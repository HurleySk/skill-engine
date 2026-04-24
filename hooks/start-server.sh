#!/bin/bash
# Skill Engine — start the HTTP rule server if not already running.
# Called by SessionStart hook. Exits silently on any failure.

# Kill switch
if [ "$SKILL_ENGINE_OFF" = "1" ]; then
  exit 0
fi

PORT="${SKILL_ENGINE_PORT:-19750}"

# Check if server is already running
if curl -s --max-time 1 "http://localhost:$PORT/health" > /dev/null 2>&1; then
  exit 0
fi

# Resolve plugin directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_JS="$SCRIPT_DIR/../server/server.js"

if [ ! -f "$SERVER_JS" ]; then
  exit 0
fi

# Start server in background, detached from this process
nohup node "$SERVER_JS" --port "$PORT" > /dev/null 2>&1 &
disown

# Wait briefly for server to come up (max 3 seconds)
for i in 1 2 3; do
  sleep 1
  if curl -s --max-time 1 "http://localhost:$PORT/health" > /dev/null 2>&1; then
    exit 0
  fi
done

# Server didn't start — exit silently, hooks will no-op
exit 0
