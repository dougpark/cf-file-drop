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

// This tells Hono about your Cloudflare "Bindings"
type Bindings = {
	BUCKET: R2Bucket
	DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

// The Upload Endpoint (for your iPhone/macOS)
app.post('/upload', async (c) => {
	return c.json({ message: 'Ready for upload logic!' })
})

// The Download/Share Endpoint
app.get('/f/:slug', async (c) => {
	const slug = c.req.param('slug')
	return c.text(`Looking for file with slug: ${slug}`)
})

// The Download/Share Endpoint
app.get('/', async (c) => {
	return c.text(`Hello from Cloudflare Workers!`)
})

export default app