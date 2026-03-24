/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { Hono } from 'hono'

import uploadHtml from '../public/upload2.html'

// This tells Hono about your Cloudflare "Bindings"
type Bindings = {
	ASSETS: any;
	DB: D1Database;
	BUCKET: R2Bucket;
}

const app = new Hono<{ Bindings: Bindings }>()

// The Upload Endpoint (for your iPhone/macOS)
app.post('/upload', async (c) => {

	const body = await c.req.parseBody();
	const file = body['file'] as File;

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
		// share_url: `https://d11cloud.com/f/${slug}`,
		share_url: `http://localhost:8787/f/${slug}`,
		message: existing ? 'Deduplicated (Shared existing storage)' : 'New file uploaded'
	});
});


// The Download/Share Endpoint
app.get('/f/:slug', async (c) => {
	const slug = c.req.param('slug');

	// 1. Fetch metadata from D1
	const file = await c.env.DB.prepare(
		"SELECT * FROM file_log WHERE slug = ? AND (deleted_at IS NULL)"
	).bind(slug).first();

	if (!file) return c.text('File not found', 404);

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

	// 5. Update Metrics (Download Count & Last Downloaded)
	await c.env.DB.prepare(
		"UPDATE file_log SET download_count = download_count + 1, last_downloaded_at = ? WHERE slug = ?"
	).bind(Math.floor(Date.now() / 1000), slug).run();

	// 6. Get the file from R2 and serve it
	const object = await c.env.BUCKET.get(file.r2_key as string);

	if (!object) return c.text('File missing from storage', 404);

	// Set headers so the browser knows it's a file download
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('Content-Disposition', `attachment; filename="${file.original_filename}"`);
	headers.set('etag', object.httpEtag);

	return new Response(object.body, { headers });
});


// Serve the PWA Manifest
app.get('/manifest.json', (c) => {
	return c.json(require('../public/manifest.json')) // Or just paste the JSON here
})

// Simple Upload UI (The "Dashboard")
app.get('/up', (c) => {
	return c.html(uploadHtml)
})

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

// The Default Endpoint
app.get('/hello', async (c) => {
	return c.text(`Hello from Cloudflare Workers!`)
})

export default app