# ⚡ File Drop 

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![D1](https://img.shields.io/badge/SQLite-D1-003B57?logo=sqlite&logoColor=white)
![License](https://img.shields.io/github/license/dougpark/cf-file-drop?color=blue)
![Beta](https://img.shields.io/badge/Status-Beta-yellow)

---

✨ Key Features
- Zero-Account Sharing: Send files via "Magic Links" without requiring recipient registration.
- Admin Dashboard: Comprehensive UI for managing tokens, revoking access, and monitoring usage.
- Self-Sealing Setup: Secure "Bootstrap" process that locks itself after the first admin is created.
- Smart Cleanup: Automated CRON triggers to prune expired R2 objects and database records.
- Audit Logging: Privacy-conscious logging with salted IP hashing to protect downloader identity.

---

## 📖 Table of Contents
- [Performance & Architecture](#performance--architecture)
- [Security & Encryption](#security--encryption)
- [Infrastructure & Prerequisites](#infrastructure--cloudflare-integration)
- [First-Start: Bootstrapping](#first-start-bootstrapping-the-first-admin)
- [Scheduled Jobs](#scheduled-jobs)



Built natively on Cloudflare’s global edge network, **File Drop** represents the apex of secure, high-speed, zero-trust file distribution. By executing logic via V8 Isolates fractions of a millisecond away from the end user, every upload and download benefits from lightning-fast, localized performance—no matter where your recipients are on Earth. Engineered from the ground up for strict document containment, File Drop guarantees your sensitive data remains under your absolute control. Featuring cryptographically secure time-expiring links, strictly enforced maximum download thresholds, and comprehensive, auditable access logs backed by Cloudflare R2D1, this platform transcends standard storage solutions. It is the definitive, professional-grade architecture for transmitting private data across the globe with uncompromising speed and impenetrable security.

Probably, it's still in beta so use at your own risk.

---

## Performance & Architecture
If you are wondering why the entire application is bundled into a single runtime file and gzipped before deployment, it is to take full advantage of the Cloudflare Workers architecture.

When a request hits an edge node, Cloudflare spins up a **V8 Isolate** in mere milliseconds. By embedding all CSS, icons, and logic directly into the script, we eliminate the "waterfall" of additional network requests for static assets. The result is a "Zero-Latency" feel where the code is already in memory, ready to serve, the moment the Isolate wakes up. It isn't just fast; it’s built for the edge.

``` mermaid
graph TD
    User((User)) -->|HTTPS/TLS 1.3| CF[Cloudflare Edge]
    subgraph Cloudflare Worker
        CF -->|V8 Isolate| Hono[Hono Router]
        Hono -->|Auth Check| D1[(D1 Metadata)]
        Hono -->|Stream File| R2[R2 Object Storage]
    end
    Hono -->|Signed Link| User
```

---

## Security & Encryption
Data integrity and privacy are baked into the infrastructure through Cloudflare One.
- **In Transit:** All traffic is strictly enforced over **TLS 1.3**, providing domain-level encryption from the browser to the Worker.
- **At Rest:** Files are stored in an **AES-256 encrypted** - **R2 bucket**, ensuring that data is protected the moment it leaves the stream.

Note on End-to-End Encryption (E2EE): While the pipeline is encrypted at every stage, this service does not currently utilize client-side encryption. We have prioritized a seamless "Magic Link" user experience over the complex key-exchange requirements of E2EE, ensuring that receivers can access files without managing local cryptographic keys.

## 🛡️ Security Model

|Threat|Mitigation|
|------|----------|
|Data Breach at Rest|AES-256 Encryption provided by Cloudflare R2.|
|Man-in-the-Middle|Strictly enforced TLS 1.3 (Cloudflare Edge).|
|IP Tracking/Doxxing|IPs are salted and hashed (IP_HASH_SALT) before storage.|
|Brute Force Slugs|"Cryptographically secure, high-entropy URL slugs."|
|Bot Scraping|Token-based access control + Cloudflare WAF compatibility.|

## Infrastructure & Cloudflare Integration
This project is architected to run exclusively on the Cloudflare Ecosystem, leveraging Workers (Compute), D1 (SQL Database), and R2 (Object Storage).

**Prerequisites**
To deploy this service, you must have an active Cloudflare account with the following resources provisioned:
- Cloudflare Workers: The serverless runtime for the application logic.
- D1 Database: For relational metadata, user tokens, and audit logging.
- R2 Bucket: For high-performance, S3-compatible object storage.

**Resource Binding**
Successful deployment requires binding these resources to your Worker environment. You will need to configure your wrangler.json (or wrangler.toml) to map the DB and BUCKET bindings to your specific resource IDs.

Detailed documentation for creating these resources and managing bindings can be found in the **Cloudflare Developer Documentation**, or via an LLM-assisted walkthrough for rapid environment setup.

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

### Step 1 — Set the required secrets

Choose a strong random value for the bootstrap token (e.g. from `openssl rand -hex 24`) and a separate salt for IP hashing, then store both as Wrangler secrets:

```bash
# First-boot admin seed
npx wrangler secret put BOOTSTRAP_ADMIN_TOKEN
# paste your secret at the prompt, then press Enter

# Salt for hashing downloader IP addresses (prevents rainbow-table attacks)
npx wrangler secret put IP_HASH_SALT
# paste a different random value, e.g. output of: openssl rand -hex 32
```

Both values are stored encrypted in Cloudflare — they never appear in source code or `wrangler.jsonc`.

#### Local development

For `wrangler dev`, secrets are read from a `.dev.vars` file in the project root (never commit this file):

```bash
# .dev.vars  ← gitignored
BOOTSTRAP_ADMIN_TOKEN=your-local-bootstrap-secret
IP_HASH_SALT=your-local-ip-salt
```

Create it once:

```bash
cat > .dev.vars <<'EOF'
BOOTSTRAP_ADMIN_TOKEN=dev-bootstrap-token
IP_HASH_SALT=$(openssl rand -hex 32)
EOF
```

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
| `IP_HASH_SALT` | Salts IP hashes in download_log to prevent rainbow-table attacks | Always (set before first deploy) |

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


## License

Distributed under the MIT License. See [LICENSE](/LICENSE) for more information.