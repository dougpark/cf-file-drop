-- Migration number: 0002 	 2026-03-25T03:21:22.282Z

-- User Access Tokens for upload tracking and user management
CREATE TABLE IF NOT EXISTS access_tokens (
    token TEXT PRIMARY KEY,
    user_name TEXT NOT NULL,
    user_email TEXT,
    use_count INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME
);

-- Add a column to your existing file_log to track who uploaded what
ALTER TABLE file_log ADD COLUMN created_by_token TEXT;
ALTER TABLE file_log ADD COLUMN receiver_name TEXT;
    