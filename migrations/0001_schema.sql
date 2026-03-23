-- Initial Schema for File Drop
CREATE TABLE IF NOT EXISTS file_log (
    slug TEXT PRIMARY KEY,              -- a UUID for sharing and links
    r2_key TEXT NOT NULL,               -- The actual path in your R2 bucket
    original_filename TEXT NOT NULL,    -- uploaded filename
    file_size_bytes INTEGER NOT NULL,   -- file size
    mime_type TEXT,                     -- pdf, txt, doc, 
    tags TEXT,                          -- file tags
    summary TEXT,                       -- generated file summary
    sha256_hash TEXT,                   -- For de-duplication later
    password_hash TEXT,                 -- NULL for public links, required for private downloads
    expires_at INTEGER,                 -- Unix timestamp
    is_single_use BOOLEAN DEFAULT 0,    -- 1 for single use downloads
    download_count INTEGER DEFAULT 0,   -- tracks download counts for expiring
    last_downloaded_at INTEGER,         -- Unix timestamp metric to track latest download
    uploaded_by TEXT DEFAULT 'admin',   -- uploaded user
    uploaded_at INTEGER DEFAULT (strftime('%s','now')) -- Unix timestamp, Upload time, Consistent Epoch storage
    deleted_at INTEGER                  -- Unix timestamp allows soft deletes
);

-- Index for faster searching by filename
CREATE INDEX IF NOT EXISTS idx_file_log_original_filename ON file_log(original_filename);
-- Index for faster searching by slug
CREATE INDEX IF NOT EXISTS idx_file_log_slug ON file_log(slug);
-- Virtual table for searching filenames and tags
CREATE VIRTUAL TABLE file_search_idx USING fts5(
    slug UNINDEXED, 
    original_filename, 
    tags,
    summary
);
-- Example Search Query:
-- SELECT * FROM file_log WHERE slug IN (SELECT slug FROM file_search_idx WHERE file_search_idx MATCH 'tax documents');

