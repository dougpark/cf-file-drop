# CF File Drop

# ⚡ File Drop (`drop.d11cloud.com`)

Built natively on Cloudflare’s global edge network, **File Drop** represents the apex of secure, high-speed, zero-trust file distribution. By executing logic via V8 Isolates fractions of a millisecond away from the end user, every upload and download benefits from lightning-fast, localized performance—no matter where your recipients are on Earth. Engineered from the ground up for strict document containment, File Drop guarantees your sensitive data remains under your absolute control. Featuring cryptographically secure time-expiring links, strictly enforced maximum download thresholds, and comprehensive, auditable access logs backed by Cloudflare R2D1, this platform transcends standard storage solutions. It is the definitive, professional-grade architecture for transmitting private data across the globe with uncompromising speed and impenetrable security.

Probably, it's still in beta so use at your own risk.

---

## Stack

| Layer | Service |
|-------|---------|
| Runtime | Cloudflare Workers (Hono) |
| Database | Cloudflare D1 (SQLite) |
| Object storage | Cloudflare R2 |
| Frontend | HTML partials compiled into the Worker bundle |

---

## Development

```bash
npm install
npx wrangler dev          # local dev server (http://localhost:8787)
npx wrangler types        # regenerate TypeScript bindings after wrangler.jsonc changes
```

Run tests:

```bash
npx vitest run
```

---

## Deployment

```bash
npx wrangler deploy
```

Apply D1 migrations after schema changes:

```bash
npx wrangler d1 migrations apply file-drop-metadata
```

---

## First-Start: Bootstrapping the First Admin

Because every admin action requires a valid admin token in the database, a fresh deployment has a chicken-and-egg problem: there are no tokens yet, so you cannot log in to create one.

The solution is a **one-time bootstrap token** stored as a Wrangler secret. The `/setup` endpoint uses it to create the first admin token and then permanently seals itself once any admin exists.

### Step 1 — Set the bootstrap secret

Choose a strong random value (e.g. from `openssl rand -hex 24`) and store it as a Wrangler secret:

```bash
npx wrangler secret put BOOTSTRAP_ADMIN_TOKEN
# paste your secret at the prompt, then press Enter
```

This stores the value encrypted in Cloudflare — it never appears in source code or `wrangler.jsonc`.

### Step 2 — Deploy

```bash
npx wrangler deploy
```

### Step 3 — Trigger the setup endpoint

Open a browser and navigate to:

```
https://drop.d11cloud.com/setup?key=<your-secret>
```

The worker will:
1. Verify the `?key=` value matches `BOOTSTRAP_ADMIN_TOKEN`
2. Confirm that zero admin tokens exist in the database
3. Insert your secret as the first admin token
4. Return a setup page with your ready-to-use URLs

The page displays:

- **Send / Upload URL** — `https://drop.d11cloud.com/send?t=<token>`  
  Bookmark this. It gives you access to the upload page and identifies you as an admin.
- **Admin panel URL** — `https://drop.d11cloud.com/admin`  
  Manage users and tokens.

### Step 4 — Seal the endpoint

`/setup` permanently returns **404** on every subsequent visit once any admin token is in the database. No action required — it seals itself automatically.

### Step 5 — Create real admin tokens (optional)

After your first login, use the admin panel to create properly-named tokens for yourself and other users. You can then disable the bootstrap token from the admin panel so it can no longer be used.

To also remove the secret from Cloudflare:

```bash
npx wrangler secret delete BOOTSTRAP_ADMIN_TOKEN
```

### Security properties

| Property | Detail |
|----------|--------|
| Secret never in source code | Stored as a Wrangler secret, encrypted at rest |
| Endpoint is authenticated | Requires knowledge of the secret to do anything |
| Self-sealing | Returns 404 once ≥ 1 admin exists — no window for race conditions |
| Idempotent | Safe to call multiple times before an admin exists (`INSERT OR IGNORE`) |
| Revocable | Disable the token from the admin panel; delete the secret with `wrangler secret delete` |

---

## Alternative: Direct DB seed (no browser required)

If you prefer a CLI-only approach, insert a token directly into D1:

```bash
TOKEN=$(openssl rand -hex 16)

npx wrangler d1 execute file-drop-metadata --command \
  "INSERT INTO access_tokens (token, user_name, is_admin, is_active) VALUES ('${TOKEN}', 'Admin', 1, 1)"

echo "Admin send URL: https://drop.d11cloud.com/send?t=${TOKEN}"
```

This bypasses the `/setup` endpoint entirely and is useful for scripted or CI deployments.

---

## Secrets reference

| Secret | Purpose | Required |
|--------|---------|----------|
| `BOOTSTRAP_ADMIN_TOKEN` | First-boot admin seed | First deploy only |

Set with `npx wrangler secret put <NAME>`, delete with `npx wrangler secret delete <NAME>`.

---

## Database migrations

Migration files live in `migrations/`. Apply them with:

```bash
npx wrangler d1 migrations apply file-drop-metadata          # production
npx wrangler d1 migrations apply file-drop-metadata --local  # local dev
```

---

## Scheduled jobs

A nightly cleanup cron runs at **02:00 UTC** (configured in `wrangler.jsonc`):

- Soft-deletes expired file records (with a 24-hour grace period)
- Deletes R2 objects only when every reference to that object has been soft-deleted (deduplication safety)
