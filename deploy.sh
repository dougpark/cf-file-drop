#!/bin/bash

LOG_FILE="deploy_history.log"
TEMP_HISTORY="temp_history.log"
TEMP_DEPLOY="temp_deploy.log"
TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
DEPLOY_MSG=${1:-"Standard deployment"}

echo "Starting Cloudflare deployment..."

# 1. Run the deploy, show it on the screen, AND capture it to a temporary file
bunx wrangler deploy 2>&1 | tee "$TEMP_DEPLOY"

# 2. Build the new "Top" of the history file (Header)
echo "========================================" > "$TEMP_HISTORY"
echo "DEPLOY TIME : $TIMESTAMP" >> "$TEMP_HISTORY"
echo "MESSAGE     : $DEPLOY_MSG" >> "$TEMP_HISTORY"
echo "----------------------------------------" >> "$TEMP_HISTORY"

# 3. Append the fresh deployment output right under the new header
cat "$TEMP_DEPLOY" >> "$TEMP_HISTORY"
echo "" >> "$TEMP_HISTORY"

# 4. Append all the OLD history below the new run
if [ -f "$LOG_FILE" ]; then
    cat "$LOG_FILE" >> "$TEMP_HISTORY"
fi

# 5. Overwrite the main log file with the correctly stacked temp file
mv "$TEMP_HISTORY" "$LOG_FILE"

# 6. Clean up the deploy temp file
rm "$TEMP_DEPLOY"