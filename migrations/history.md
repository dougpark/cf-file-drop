# history of changes

DB_NAME: file-drop-metadata

# update local

bun wrangler d1 migrations apply file-drop-metadata --local

# update remote

bun wrangler d1 migrations apply file-drop-metadata --remote

