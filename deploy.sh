#!/bin/bash

# make sure you create at least one tag in your git repo before using this script, otherwise the deploy command will fail and the log won't update. You can create a tag with: `git tag v1.0.0` (replace with your version) and then push it with `git push origin v1.0.0`
# example: git tag v1.0.0
# use git tag to show current tags and git describe --tags to show the most recent tag in your history

# use bunx wrangler deploy list to see your past deploys in the terminal, but this script captures the full output of each deploy and saves it to a log file for easier reference and debugging later on. Each deploy entry in the log is timestamped and includes the commit message for better context.
# it is possible to rollback to a previous deploy using the wrangler CLI with `bunx wrangler deploy --tag <tag-name>` if you need to revert to an older version of your code. Just make sure to check your deploy history log to find the tag name associated with the deploy you want to rollback to.



LOG_FILE="deploy_history.log"
TEMP_HISTORY="temp_history.log"
TEMP_DEPLOY="temp_deploy.log"
TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
DEPLOY_MSG=${1:-"Standard deployment"}

echo "Starting Cloudflare deployment..."

# 1. Run the deploy, show it on the screen, AND capture it to a temporary file
 bunx wrangler deploy --tag " $(git describe --tags --abbrev=0)" --message "$(git log -1 --pretty=%B)" 2>&1 | tee "$TEMP_DEPLOY"

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