#!/bin/bash
# Skill Engine — start the HTTP rule server if not already running.
# Called by SessionStart hook. Exits silently on any failure.

# Kill switch
if [ "$SKILL_ENGINE_OFF" = "1" ]; then
  exit 0
fi

PORT="${SKILL_ENGINE_PORT:-19750}"

_resolve_latest_plugin_dir() {
  local CACHE_BASE="$HOME/.claude/plugins/cache/hurleysk-marketplace/skill-engine"
  local LATEST
  LATEST=$(ls -d "$CACHE_BASE"/*/ 2>/dev/null | sort -V | tail -1)
  if [ -n "$LATEST" ]; then
    echo "${LATEST%/}"
  else
    echo "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  fi
}

_kill_pid() {
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Stop-Process -Id $1 -Force -ErrorAction SilentlyContinue" 2>/dev/null
  else
    kill "$1" 2>/dev/null
  fi
}

_kill_by_port() {
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort $PORT -ErrorAction SilentlyContinue).OwningProcess -Force -ErrorAction SilentlyContinue" 2>/dev/null
  elif command -v lsof >/dev/null 2>&1; then
    kill $(lsof -ti "tcp:$PORT") 2>/dev/null
  fi
}

register_session() {
  # On Windows/Git Bash, convert /c/Users/... to C:/Users/... so Node.js fs resolves correctly
  local PROJECT_DIR="$CLAUDE_PROJECT_DIR"
  if [[ "$PROJECT_DIR" =~ ^/[a-zA-Z]/ ]]; then
    PROJECT_DIR="$(cd "$PROJECT_DIR" 2>/dev/null && pwd -W)" || PROJECT_DIR="$CLAUDE_PROJECT_DIR"
  fi
  local SESSION_ID="${CLAUDE_SESSION_ID:-$(node -e "console.log(require('crypto').createHash('md5').update(process.argv[1]).digest('hex').slice(0,16))" "$PROJECT_DIR" 2>/dev/null)}"
  local PAYLOAD
  PAYLOAD=$(node -e "console.log(JSON.stringify({sessionId:process.argv[1],projectDir:process.argv[2]}))" \
    "$SESSION_ID" "$PROJECT_DIR" 2>/dev/null)
  local RESULT
  RESULT=$(curl -s -o /dev/null -w "%{http_code}" --max-time 1 -X POST -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "http://localhost:$PORT/register-session" 2>/dev/null)
  if [ "$RESULT" = "200" ]; then
    return
  fi
  # Fallback to /set-project for older servers without /register-session
  local SET_PAYLOAD
  SET_PAYLOAD=$(node -e "console.log(JSON.stringify({projectDir:process.argv[1]}))" "$PROJECT_DIR" 2>/dev/null)
  curl -s --max-time 1 -X POST -H "Content-Type: application/json" \
    -d "$SET_PAYLOAD" \
    "http://localhost:$PORT/set-project" > /dev/null 2>&1
}

PLUGIN_DIR="$(_resolve_latest_plugin_dir)"
CURRENT_VERSION=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(require('path').resolve(process.argv[1]),'utf8')).version||'')}catch{console.log('')}" "$PLUGIN_DIR/.claude-plugin/plugin.json" 2>/dev/null)

# --- Cache cleanup: remove old version directories ---
_prune_old_cache_versions() {
  local CACHE_BASE="$HOME/.claude/plugins/cache/hurleysk-marketplace/skill-engine"
  local CURRENT_DIR
  CURRENT_DIR="$(cd "$PLUGIN_DIR" 2>/dev/null && pwd)" || return 0
  [ -z "$CURRENT_DIR" ] && return 0
  [ ! -d "$CACHE_BASE" ] && return 0

  local COUNT=0
  for DIR in "$CACHE_BASE"/*/; do
    local RESOLVED
    RESOLVED="$(cd "$DIR" 2>/dev/null && pwd)" || continue
    [ "$RESOLVED" = "$CURRENT_DIR" ] && continue
    rm -rf "$DIR" 2>/dev/null && COUNT=$((COUNT + 1))
  done

  [ "$COUNT" -gt 0 ] && echo "skill-engine: pruned $COUNT old cache version(s)"
}

# Check if server is already running
HEALTH=$(curl -s --max-time 1 "http://localhost:$PORT/health" 2>/dev/null)
if [ -n "$HEALTH" ]; then
  RUNNING_VERSION=$(echo "$HEALTH" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).version||'')}catch{console.log('')}})" 2>/dev/null)

  if [ "$RUNNING_VERSION" = "$CURRENT_VERSION" ]; then
    register_session
    _prune_old_cache_versions
    exit 0
  fi

  # Version differs — kill and restart
  OLD_PID=$(echo "$HEALTH" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).pid||'')}catch{console.log('')}})" 2>/dev/null)
  if [ -n "$OLD_PID" ]; then
    _kill_pid "$OLD_PID"
  else
    _kill_by_port
  fi
  sleep 1
  echo "skill-engine: restarted ($RUNNING_VERSION → $CURRENT_VERSION)"
fi

# Start server
SERVER_JS="$PLUGIN_DIR/server/server.js"
if [ ! -f "$SERVER_JS" ]; then
  exit 0
fi

nohup node "$SERVER_JS" --port "$PORT" > /dev/null 2>&1 &
disown

# Wait for server to come up (max 3 seconds)
for i in 1 2 3; do
  sleep 1
  if curl -s --max-time 1 "http://localhost:$PORT/health" > /dev/null 2>&1; then
    register_session
    _prune_old_cache_versions
    exit 0
  fi
done

exit 0
