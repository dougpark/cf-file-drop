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
import joinPage from './client/joinPage.part.html'
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

//The Default Endpoint - public
app.get('/', (c) => {
	const html =
		sharedHead
			.replace('{{shared_style}}', `<style>${sharedStyle}</style>`) +
		"Welcome to drop.d11cloud.com! \
		Please contact the admin to receive your access link."

	return c.html(html);

})

// join page - public, but with a unique token in the URL to prevent random people from stumbling on it. This is where you would share the "join" link with your friends or family so they can upload files without needing the admin password. The token can be a simple random string that you generate and share privately.
app.get('/send', (c) => {
	const html =
		sharedHead
			.replace('{{shared_style}}', `<style>${sharedStyle}</style>`) +
		joinPage

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

// /newupload is now merged into /send — redirect for any bookmarks
app.get('/newupload', (c) => c.redirect('/send', 301))


// The Upload Endpoint — requires a valid access token via Authorization: Bearer header
app.post('/upload', async (c) => {

	// Validate the access token
	const authHeader = c.req.header('Authorization');
	const uploadToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
	if (!uploadToken) {
		return c.json({ success: false, error: 'Unauthorized: Token required' }, 401);
	}
	const tokenRecord = await c.env.DB.prepare(
		"SELECT token FROM access_tokens WHERE token = ? AND is_active = 1"
	).bind(uploadToken).first();
	if (!tokenRecord) {
		return c.json({ success: false, error: 'Unauthorized: Invalid or inactive token' }, 401);
	}

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

	// 4. Record the entry in D1 (including which token uploaded it)
	const expiresAt = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60; // 3 days from now
	await c.env.DB.prepare(`
    INSERT INTO file_log (slug, r2_key, original_filename, file_size_bytes, mime_type, sha256_hash, created_by_token, expires_at, max_downloads)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 3)
  `).bind(slug, r2_key, file.name, file.size, file.type, hashSum, uploadToken, expiresAt).run();

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

	const file = await c.env.DB.prepare(
		`SELECT fl.original_filename, fl.file_size_bytes, fl.download_count,
		fl.expires_at, fl.is_single_use, fl.password_hash,
		COALESCE(fl.max_downloads, 3) AS max_downloads,
		COALESCE(at.user_name, 'Someone') AS sender_name
		FROM file_log fl
		LEFT JOIN access_tokens at ON at.token = fl.created_by_token
		WHERE fl.slug = ? AND fl.deleted_at IS NULL`
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
	const fileMaxDownloads = file.max_downloads as number;
	const remaining = fileMaxDownloads - (file.download_count as number);

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
			.replace('{{MAX_DOWNLOADS}}', fileMaxDownloads.toString())
			.replace('{{sender_name}}', `${file.sender_name}`)
			.replace('{{expires_at}}', file.expires_at
				? new Date((file.expires_at as number) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
				: 'No expiry');
	return c.html(html);
});

// 2. The Actual Download Stream - public
app.get('/f/:slug/raw', async (c) => {
	const slug = c.req.param('slug');
	const file = await c.env.DB.prepare(
		"SELECT r2_key, original_filename, created_by_token FROM file_log WHERE slug = ?"
	).bind(slug).first();

	if (!file) return c.text('Not found', 404);

	const object = await c.env.BUCKET.get(file.r2_key as string);
	if (!object) return c.text('File missing', 404);

	const now = Math.floor(Date.now() / 1000);

	// Collect Cloudflare request metadata for the audit log
	const ua = c.req.header('User-Agent') ?? null;
	const country = c.req.header('CF-IPCountry') ?? null;
	const cfRay = c.req.header('CF-Ray') ?? null;
	const referer = c.req.header('Referer') ?? null;

	// Hash the IP for privacy — we keep correlation ability without storing raw IPs
	const rawIp = c.req.header('CF-Connecting-IP') ?? null;
	let ipHash: string | null = null;
	if (rawIp) {
		const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawIp));
		ipHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
	}

	// Derive a simple device type from the User-Agent
	let deviceType = 'unknown';
	if (ua) {
		const u = ua.toLowerCase();
		if (/bot|crawl|spider|slurp|facebookexternalhit/.test(u)) deviceType = 'bot';
		else if (/ipad|tablet|playbook|silk/.test(u)) deviceType = 'tablet';
		else if (/mobile|iphone|android|ipod|blackberry|iemobile|opera mini/.test(u)) deviceType = 'mobile';
		else deviceType = 'desktop';
	}

	// Run both DB writes in a batch
	await c.env.DB.batch([
		c.env.DB.prepare(
			"UPDATE file_log SET download_count = download_count + 1, last_downloaded_at = ? WHERE slug = ?"
		).bind(now, slug),
		c.env.DB.prepare(
			`INSERT INTO download_log (slug, created_by_token, downloaded_at, ip_address, country, user_agent, device_type, referer, cf_ray)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).bind(slug, file.created_by_token ?? null, now, ipHash, country, ua, deviceType, referer, cfRay),
	]);

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('Content-Disposition', `attachment; filename="${file.original_filename}"`);
	return new Response(object.body, { headers });
});


// Serve the PWA Manifest - public
app.get('/manifest.json', (c) => {
	return c.json(require('../public/manifest.json')) // Or just paste the JSON here
})

// An API Endpoint to List Recent Uploads — scoped to the calling user's token
app.get('/api/recent', async (c) => {
	const authHeader = c.req.header('Authorization');
	const recentToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
	if (!recentToken) {
		return c.json({ error: 'Unauthorized' }, 401);
	}
	const tokenRecord = await c.env.DB.prepare(
		"SELECT token FROM access_tokens WHERE token = ? AND is_active = 1"
	).bind(recentToken).first();
	if (!tokenRecord) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const { results } = await c.env.DB.prepare(`
    SELECT slug, original_filename, uploaded_at, file_size_bytes, expires_at, download_count,
           COALESCE(max_downloads, 3) AS max_downloads
    FROM file_log 
    WHERE deleted_at IS NULL AND created_by_token = ?
    ORDER BY uploaded_at DESC 
    LIMIT 50
  `).bind(recentToken).all();

	return c.json(results);
});

// Stats endpoint — returns upload count, storage used, and last activity for the calling user's token
app.get('/api/stats', async (c) => {
	const authHeader = c.req.header('Authorization');
	const statsToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
	if (!statsToken) return c.json({ error: 'Unauthorized' }, 401);

	const tokenRecord = await c.env.DB.prepare(
		"SELECT token FROM access_tokens WHERE token = ? AND is_active = 1"
	).bind(statsToken).first();
	if (!tokenRecord) return c.json({ error: 'Unauthorized' }, 401);

	const row = await c.env.DB.prepare(`
		SELECT
			COUNT(*) AS file_count,
			COALESCE(SUM(file_size_bytes), 0) AS total_bytes,
			MAX(COALESCE(uploaded_at, 0), COALESCE(last_downloaded_at, 0)) AS last_activity
		FROM file_log
		WHERE created_by_token = ? AND deleted_at IS NULL
	`).bind(statsToken).first();

	return c.json(row);
});

// user-info endpoint - private, needs token
app.get('/api/user-info', async (c) => {

	const authHeader = c.req.header('Authorization');
	const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
	if (!token) {
		return c.json({ success: false, error: 'Token is required' }, 400);
	}

	const user = await c.env.DB.prepare(
		"SELECT user_name, user_email, is_admin FROM access_tokens WHERE token = ? AND is_active = 1"
	).bind(token).first();

	if (!user) {
		return c.json({ success: false, error: 'Invalid or inactive token' }, 401);
	}

	return c.json({ success: true, user });
});

// Sender: extend a file's expiry by 3 days from today
app.post('/api/extend-expiry', async (c) => {
	const authHeader = c.req.header('Authorization');
	const callerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
	if (!callerToken) return c.json({ error: 'Unauthorized' }, 401);

	const { slug } = await c.req.json();
	if (!slug) return c.json({ error: 'slug required' }, 400);

	const owner = await c.env.DB.prepare(
		'SELECT slug FROM file_log WHERE slug = ? AND created_by_token = ? AND deleted_at IS NULL'
	).bind(slug, callerToken).first();
	if (!owner) return c.json({ error: 'Not found' }, 404);

	const newExpiry = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
	await c.env.DB.prepare(
		'UPDATE file_log SET expires_at = ? WHERE slug = ?'
	).bind(newExpiry, slug).run();

	return c.json({ success: true, expires_at: newExpiry });
});

// Sender: add 3 more downloads to a file's limit
app.post('/api/extend-downloads', async (c) => {
	const authHeader = c.req.header('Authorization');
	const callerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
	if (!callerToken) return c.json({ error: 'Unauthorized' }, 401);

	const { slug } = await c.req.json();
	if (!slug) return c.json({ error: 'slug required' }, 400);

	const owner = await c.env.DB.prepare(
		'SELECT slug FROM file_log WHERE slug = ? AND created_by_token = ? AND deleted_at IS NULL'
	).bind(slug, callerToken).first();
	if (!owner) return c.json({ error: 'Not found' }, 404);

	// Cap at download_count + 3 so repeating clicks never grants more than 3 remaining
	await c.env.DB.prepare(
		'UPDATE file_log SET max_downloads = download_count + 3 WHERE slug = ?'
	).bind(slug).run();

	const updated = await c.env.DB.prepare(
		'SELECT max_downloads, download_count FROM file_log WHERE slug = ?'
	).bind(slug).first();

	return c.json({ success: true, max_downloads: updated?.max_downloads, download_count: updated?.download_count });
});

// Sender-facing download activity for their own file (public-safe fields only)
app.get('/api/file-activity/:slug', async (c) => {
	const authHeader = c.req.header('Authorization');
	const callerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
	if (!callerToken) return c.json({ error: 'Unauthorized' }, 401);

	const slug = c.req.param('slug');

	// Verify the file belongs to the calling token
	const owner = await c.env.DB.prepare(
		'SELECT slug FROM file_log WHERE slug = ? AND created_by_token = ? AND deleted_at IS NULL'
	).bind(slug, callerToken).first();
	if (!owner) return c.json({ error: 'Not found' }, 404);

	// Return only sender-safe columns — no IP, no UA, no CF Ray
	const { results } = await c.env.DB.prepare(`
		SELECT downloaded_at, country, device_type
		FROM download_log
		WHERE slug = ?
		ORDER BY downloaded_at DESC
	`).bind(slug).all();

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

// Admin endpoint to view the download audit log for a specific file
app.get('/admin/download-log/:slug', async (c) => {
	const slug = c.req.param('slug');

	const { results } = await c.env.DB.prepare(`
		SELECT
			dl.id,
			dl.downloaded_at,
			dl.country,
			dl.device_type,
			dl.user_agent,
			dl.referer,
			dl.ip_address,
			dl.cf_ray,
			COALESCE(at.user_name, 'Unknown sender') AS sender_name
		FROM download_log dl
		LEFT JOIN access_tokens at ON at.token = dl.created_by_token
		WHERE dl.slug = ?
		ORDER BY dl.downloaded_at DESC
	`).bind(slug).all();

	return c.json(results);
});

// Admin endpoint to list access tokens
app.get('/admin/tokens', async (c) => {
	const { results } = await c.env.DB.prepare(
		"SELECT token, user_name, user_email, use_count, is_active, is_admin, created_at FROM access_tokens ORDER BY created_at DESC"
	).all();

	return c.json(results);
});

// Admin endpoint: metadata-only file list for a sender token (no r2_key, no download URLs)
app.get('/admin/user-files/:token', async (c) => {
	const senderToken = c.req.param('token');

	const { results } = await c.env.DB.prepare(`
		SELECT
			slug,
			original_filename,
			file_size_bytes,
			mime_type,
			uploaded_at,
			download_count,
			last_downloaded_at,
			deleted_at
		FROM file_log
		WHERE created_by_token = ?
		ORDER BY uploaded_at DESC
	`).bind(senderToken).all();

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

// Scheduled cleanup: runs nightly at 02:00 UTC
// Phase 1 — soft-delete expired D1 rows (expires_at < now - 24h grace period)
// Phase 2 — hard-delete R2 objects whose every file_log row is now deleted
async function runCleanup(env: Bindings): Promise<void> {
	const gracePeriod = 24 * 60 * 60; // 24 hours in seconds
	const cutoff = Math.floor(Date.now() / 1000) - gracePeriod;

	// 1. Collect r2_keys of rows about to be soft-deleted
	const expired = await env.DB.prepare(
		`SELECT r2_key FROM file_log
		WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?`
	).bind(cutoff).all();

	if (expired.results.length === 0) {
		console.log('cleanup: no expired files found');
		return;
	}

	// 2. Soft-delete those rows
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`UPDATE file_log SET deleted_at = ?
		WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?`
	).bind(now, cutoff).run();

	console.log(`cleanup: soft-deleted ${expired.results.length} rows`);

	// 3. For each affected r2_key, only delete the R2 object if ALL rows
	//    referencing that key are now deleted (deduplication safety check)
	const uniqueKeys = [...new Set(expired.results.map((r: Record<string, unknown>) => r.r2_key as string))];
	let r2Deleted = 0;

	for (const key of uniqueKeys) {
		const active = await env.DB.prepare(
			`SELECT COUNT(*) AS cnt FROM file_log WHERE r2_key = ? AND deleted_at IS NULL`
		).bind(key).first<{ cnt: number }>();

		if ((active?.cnt ?? 1) === 0) {
			await env.BUCKET.delete(key);
			r2Deleted++;
		}
	}

	console.log(`cleanup: deleted ${r2Deleted} R2 objects`);
}

export default {
	fetch: app.fetch,
	async scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
		ctx.waitUntil(runCleanup(env));
	},
};
