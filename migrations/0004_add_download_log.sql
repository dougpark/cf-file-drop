-- Migration number: 0004 	 2026-03-30

-- Per-download audit log. One row per download event.
CREATE TABLE IF NOT EXISTS download_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL,                     -- which file was downloaded
    created_by_token TEXT,                  -- sender's access token (for tracing back to uploader)
    downloaded_at INTEGER NOT NULL,         -- Unix timestamp of the download
    ip_address TEXT,                        -- Cloudflare CF-Connecting-IP (hashed for privacy)
    country TEXT,                           -- Cloudflare CF-IPCountry (free, no geo-IP lookup needed)
    user_agent TEXT,                        -- Full UA string (browser, OS, device)
    device_type TEXT,                       -- Derived: 'mobile' | 'tablet' | 'desktop' | 'bot' | 'unknown'
    referer TEXT,                           -- Where the receiver came from (direct link vs forwarded)
    cf_ray TEXT,                            -- Cloudflare Ray ID for deep log correlation
    FOREIGN KEY (slug) REFERENCES file_log(slug)
);

CREATE INDEX IF NOT EXISTS idx_download_log_slug ON download_log(slug);
CREATE INDEX IF NOT EXISTS idx_download_log_downloaded_at ON download_log(downloaded_at);
