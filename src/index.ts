/**
 * Cloudflare Workers File Drop
 * A simple file sharing service built on Cloudflare Workers, R2, and D1.
 */

import { Hono } from 'hono'

// preload HTML parts and styles (embed them directly)
// @ts-ignore
import sharedHead from './client/head.part.html'
// @ts-ignore
import sharedStyle from './client/style.part.css'
// @ts-ignore
import startPage from './client/startpage.part.html'
// @ts-ignore
import newUpload from './client/newupload.part.html'
// @ts-ignore
import adminPage from './client/adminpage.part.html'
// @ts-ignore
import maxDownload from './client/maxdownload.part.html'
// @ts-ignore
import download from './client/download.part.html'


// This tells Hono about your Cloudflare "Bindings"
type Bindings = {
	ASSETS: any;
	DB: D1Database;
	BUCKET: R2Bucket;
	UPLOAD_PASSWORD: string;
}

const app = new Hono<{ Bindings: Bindings }>()

// The Default Endpoint - public
app.get('/', (c) => {
	const html =
		sharedHead
			.replace('{{shared_style}}', `<style>${sharedStyle}</style>`) +
		startPage

	return c.html(html);

})

// The Admin Endpoint - private needs password (or unique pin)
app.get('/admin', (c) => {
	const html =
		sharedHead
			.replace('{{shared_style}}', `<style>${sharedStyle}</style>`) +
		adminPage

	return c.html(html);

})

// upload a new file - private needs unique pin
app.get('/newupload', (c) => {
	const html =
		sharedHead
			.replace('{{shared_style}}', `<style>${sharedStyle}</style>`) +
		newUpload

	return c.html(html);
})


// The Upload Endpoint (for your iPhone/macOS) - private, needs password (or unique pin)
app.post('/upload', async (c) => {

	const body = await c.req.parseBody();
	const file = body['file'] as File;
	const password = body['password'] as string; // Look for the password

	// Check the password against the secret we set
	if (password !== c.env.UPLOAD_PASSWORD) {
		return c.json({ success: false, error: 'Unauthorized: Invalid Admin Password' }, 401);
	}

	if (!file) return c.text('No file uploaded', 400);

	// 1. Generate SHA-256 for Deduplication
	const arrayBuffer = await file.arrayBuffer();
	const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
	const hashSum = Array.from(new Uint8Array(hashBuffer))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');

	// 2. Check D1: Does this file already exist?
	const existing = await c.env.DB.prepare(
		"SELECT r2_key FROM file_log WHERE sha256_hash = ? LIMIT 1"
	).bind(hashSum).first();

	const slug = crypto.randomUUID();
	let r2_key = existing ? (existing.r2_key as string) : `${slug}-${file.name}`;

	// 3. Upload to R2 (only if it's a new file)
	if (!existing) {
		await c.env.BUCKET.put(r2_key, arrayBuffer, {
			httpMetadata: { contentType: file.type }
		});
	}

	// 4. Record the entry in D1
	await c.env.DB.prepare(`
    INSERT INTO file_log (slug, r2_key, original_filename, file_size_bytes, mime_type, sha256_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(slug, r2_key, file.name, file.size, file.type, hashSum).run();

	return c.json({
		success: true,
		share_url: `https://drop.d11cloud.com/f/${slug}`,
		// share_url: `http://localhost:8787/f/${slug}`,
		message: existing ? 'Deduplicated (Shared existing storage)' : 'New file uploaded'
	});
});


// The Download/Share Endpoint
// 1. The Public Landing Page - public
app.get('/f/:slug', async (c) => {
	const slug = c.req.param('slug');
	const MAX_DOWNLOADS = 3; // Your "Reasonable" limit

	const file = await c.env.DB.prepare(
		"SELECT original_filename, file_size_bytes, download_count,\
		expires_at, is_single_use, password_hash FROM file_log WHERE slug = ? AND deleted_at IS NULL"
	).bind(slug).first();

	if (!file) return c.text('File not found.', 404);

	// 2. Check Expiration
	if (file.expires_at && Date.now() / 1000 > (file.expires_at as number)) {
		return c.text('This link has expired.', 410);
	}

	// 3. Check Single-Use
	if (file.is_single_use && (file.download_count as number) > 0) {
		return c.text('This was a single-use link and has already been claimed.', 410);
	}

	// 4. Handle Private PIN (if set)
	const userPin = c.req.query('pin');
	if (file.password_hash && file.password_hash !== userPin) {
		// In a real app, you'd return an HTML form here. For now, a simple check:
		return c.text('This file is private. Please append ?pin=YOUR_PIN to the URL.', 401);
	}

	// Check if they've hit the limit
	const remaining = MAX_DOWNLOADS - (file.download_count as number);

	if (remaining <= 0) {
		// build the max download page from parts
		const html =
			sharedHead
				.replace('{{shared_style}}', `<style>${sharedStyle}</style>`) +
			maxDownload
				.replace('{{original_filename}}', `${file.original_filename}`);
		return c.html(html);
	}

	// If all checks pass, show the download page with the correct info filled in
	// build the download page from parts
	const html =
		sharedHead
			.replace('{{shared_style}}', `<style>${sharedStyle}</style>`) +
		download
			.replace('{{original_filename}}', `${file.original_filename}`)
			.replace('{{file_size}}', `${(Number(file.file_size_bytes) / 1024 / 1024).toFixed(2)} MB`)
			.replace('{{slug}}', slug)
			.replace('{{remaining}}', remaining.toString())
			.replace('{{MAX_DOWNLOADS}}', MAX_DOWNLOADS.toString());
	return c.html(html);
});

// 2. The Actual Download Stream - public, but with all the checks in place from the landing page
app.get('/f/:slug/raw', async (c) => {
	const slug = c.req.param('slug');
	const file = await c.env.DB.prepare(
		"SELECT r2_key, original_filename FROM file_log WHERE slug = ?"
	).bind(slug).first();

	if (!file) return c.text('Not found', 404);

	const object = await c.env.BUCKET.get(file.r2_key as string);
	if (!object) return c.text('File missing', 404);



	// 5. Update Metrics (Download Count & Last Downloaded)
	await c.env.DB.prepare(
		"UPDATE file_log SET download_count = download_count + 1, last_downloaded_at = ? WHERE slug = ?"
	).bind(Math.floor(Date.now() / 1000), slug).run();

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('Content-Disposition', `attachment; filename="${file.original_filename}"`);
	return new Response(object.body, { headers });
});


// Serve the PWA Manifest - public
app.get('/manifest.json', (c) => {
	return c.json(require('../public/manifest.json')) // Or just paste the JSON here
})

// An API Endpoint to List Recent Uploads - private, needs password (or unique pin)
// list recent uploads (for demo purposes) - In a real app, you'd want pagination and better security around this!
app.get('/api/recent', async (c) => {
	// Query the last 5 non-deleted files
	const { results } = await c.env.DB.prepare(`
    SELECT slug, original_filename, uploaded_at, file_size_bytes 
    FROM file_log 
    WHERE deleted_at IS NULL 
    ORDER BY uploaded_at DESC 
    LIMIT 5
  `).all();

	return c.json(results);
});

// admin create-new-user endpoint
app.post('/admin/create-new-user', async (c) => {
	const token = generateToken(16); // Generate a random token for the new user
	const body = await c.req.json();
	const userName = body.user_name as string;
	const userEmail = body.user_email as string;
	const is_admin = body.is_admin as boolean;

	if (!userName) {
		return c.json({ success: false, error: 'User name is required' }, 400);
	}

	// Insert the new token into the database
	await c.env.DB.prepare(`
		INSERT INTO access_tokens (token, user_name, user_email, is_admin) 
		VALUES (?, ?, ?, ?)
	`).bind(token, userName, userEmail, is_admin ? 1 : 0).run();

	return c.json({ success: true, token });
});

// Helper to create a token
const generateToken = (length = 8) => {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	const array = new Uint8Array(length);
	crypto.getRandomValues(array);
	return Array.from(array, (byte) => chars[byte % chars.length]).join('');
};

// Admin endpoint to list access tokens
app.get('/admin/tokens', async (c) => {
	const { results } = await c.env.DB.prepare(
		"SELECT token, user_name, user_email, use_count, is_active, is_admin, created_at FROM access_tokens ORDER BY created_at DESC"
	).all();

	return c.json(results);
});
// Admin endpoint to update admin status
app.post('/admin/update-admin-status', async (c) => {
	const body = await c.req.json();
	const token = body.token as string;
	const is_admin = body.is_admin as boolean;

	if (!token) {
		return c.json({ success: false, error: 'Token is required' }, 400);
	}

	await c.env.DB.prepare(
		"UPDATE access_tokens SET is_admin = ? WHERE token = ?"
	).bind(is_admin ? 1 : 0, token).run();

	return c.json({ success: true });
});

// Admin endpoint to enable a token
app.post('/admin/enable-token', async (c) => {
	const body = await c.req.json();
	const token = body.token as string;

	if (!token) {
		return c.json({ success: false, error: 'Token is required' }, 400);
	}

	await c.env.DB.prepare(
		"UPDATE access_tokens SET is_active = 1 WHERE token = ?"
	).bind(token).run();

	return c.json({ success: true });
});

// Admin endpoint to disable a token
app.post('/admin/disable-token', async (c) => {
	const body = await c.req.json();
	const token = body.token as string;

	if (!token) {
		return c.json({ success: false, error: 'Token is required' }, 400);
	}

	await c.env.DB.prepare(
		"UPDATE access_tokens SET is_active = 0 WHERE token = ?"
	).bind(token).run();

	return c.json({ success: true });
});
// The Default Endpoint - public, just to test that the worker is running. You can remove this once you have the main functionality working.
app.get('/hello', async (c) => {
	return c.text(`Hello from Cloudflare Workers!`)
})

export default app
