-- Migration number: 0006 	 2026-04-03
-- Public access request queue — submitted from the welcome page before any token is issued

CREATE TABLE IF NOT EXISTS access_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT,                        -- optional note from the requester
    requested_at INTEGER DEFAULT (strftime('%s','now')),
    status TEXT DEFAULT 'pending',       -- pending | approved | denied
    reviewed_at INTEGER,
    reviewed_by_token TEXT,              -- admin token that acted on it
    ip_hash TEXT                         -- short SHA-256 prefix for abuse tracking
);

CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status);
CREATE INDEX IF NOT EXISTS idx_access_requests_email  ON access_requests(email);
