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

// import uploadHtml from '../public/upload2.html'
const uploadHtml = ``;

// This tells Hono about your Cloudflare "Bindings"
type Bindings = {
	ASSETS: any;
	DB: D1Database;
	BUCKET: R2Bucket;
	UPLOAD_PASSWORD: string;
}

const app = new Hono<{ Bindings: Bindings }>()

// The Upload Endpoint (for your iPhone/macOS)
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
// 1. The Public Landing Page
app.get('/f/:slug', async (c) => {
	const slug = c.req.param('slug');
	const MAX_DOWNLOADS = 3; // Your "Reasonable" limit

	const file = await c.env.DB.prepare(
		"SELECT original_filename, file_size_bytes, download_count FROM file_log WHERE slug = ? AND deleted_at IS NULL"
	).bind(slug).first();

	if (!file) return c.text('File not found.', 404);

	// Check if they've hit the limit
	const remaining = MAX_DOWNLOADS - (file.download_count as number);

	if (remaining <= 0) {
		return c.html(`
      <body style="background:#111;color:white;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;">
        <div style="text-align:center;border:1px solid #444;padding:40px;border-radius:20px;">
          <div style="font-size:3em;">🚫</div>
          <h2>Link Expired</h2>
          <p style="color:#888;">This file reached its maximum download limit.</p>
        </div>
      </body>
    `);
	}

	return c.html(`
    <div class="card">
      <h2>${file.original_filename}</h2>
      <div class="meta">${(Number(file.file_size_bytes) / 1024 / 1024).toFixed(2)} MB</div>
      <a href="/f/${slug}/raw" class="btn">Download File</a>
      <div style="margin-top:15px; font-size:0.8em; color:#666;">
        Remaining downloads: ${remaining} of ${MAX_DOWNLOADS}
      </div>
    </div>
  `);
});

// 2. The Actual Download Stream
app.get('/f/:slug/raw', async (c) => {
	const slug = c.req.param('slug');
	const file = await c.env.DB.prepare(
		"SELECT r2_key, original_filename FROM file_log WHERE slug = ?"
	).bind(slug).first();

	if (!file) return c.text('Not found', 404);

	const object = await c.env.BUCKET.get(file.r2_key as string);
	if (!object) return c.text('File missing', 404);

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('Content-Disposition', `attachment; filename="${file.original_filename}"`);
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