#!/bin/bash
# Skill Engine — start the HTTP rule server if not already running.
# Called by SessionStart hook. Exits silently on any failure.

# Kill switch
if [ "$SKILL_ENGINE_OFF" = "1" ]; then
  exit 0
fi

PORT="${SKILL_ENGINE_PORT:-19750}"

# Check if server is already running
HEALTH=$(curl -s --max-time 1 "http://localhost:$PORT/health" 2>/dev/null)
if [ -n "$HEALTH" ]; then
  # Server is running — check if version matches
  RUNNING_VERSION=$(echo "$HEALTH" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).version||'')}catch{console.log('')}})" 2>/dev/null)
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  CURRENT_VERSION=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$SCRIPT_DIR/../.claude-plugin/plugin.json','utf8')).version||'')}catch{console.log('')}" 2>/dev/null)

  if [ -n "$RUNNING_VERSION" ] && [ "$RUNNING_VERSION" = "$CURRENT_VERSION" ]; then
    exit 0
  fi

  # Version mismatch — kill old server and start fresh
  OLD_PID=$(echo "$HEALTH" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).pid||'')}catch{console.log('')}})" 2>/dev/null)
  if [ -n "$OLD_PID" ]; then
    kill "$OLD_PID" 2>/dev/null
    sleep 1
  fi
  echo "skill-engine: restarted ($RUNNING_VERSION → $CURRENT_VERSION)"
fi

# Resolve plugin directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_JS="$SCRIPT_DIR/../server/server.js"

if [ ! -f "$SERVER_JS" ]; then
  exit 0
fi

# Start server in background, detached from this process
RULES_DIR="${CLAUDE_PROJECT_DIR:+$CLAUDE_PROJECT_DIR/.claude/skills}"
nohup node "$SERVER_JS" --port "$PORT" ${RULES_DIR:+--rules-dir "$RULES_DIR"} > /dev/null 2>&1 &
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
