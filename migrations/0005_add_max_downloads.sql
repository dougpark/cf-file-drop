-- Add per-file download limit, defaulting to 3 to match existing behaviour
ALTER TABLE file_log ADD COLUMN max_downloads INTEGER NOT NULL DEFAULT 3;
