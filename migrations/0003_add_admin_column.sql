-- Migration number: 0003 	 2026-03-25T03:31:58.998Z

-- Add is_admin column to access_tokens for admin user management
ALTER TABLE access_tokens ADD COLUMN is_admin INTEGER DEFAULT 0;