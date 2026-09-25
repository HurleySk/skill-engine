#!/bin/bash
# Skill Engine — start the HTTP rule server if not already running.
# Called by SessionStart hook. Exits silently on any failure.

# Kill switch
if [ "$SKILL_ENGINE_OFF" = "1" ]; then
  exit 0
fi

PORT="${SKILL_ENGINE_PORT:-19750}"

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
  local PROJECT_DIR="$CLAUDE_PROJECT_DIR"
  if [[ "$PROJECT_DIR" =~ ^/[a-zA-Z]/ ]]; then
    PROJECT_DIR="$(cd "$PROJECT_DIR" 2>/dev/null && pwd -W)" || PROJECT_DIR="$CLAUDE_PROJECT_DIR"
  fi
  local PAYLOAD
  PAYLOAD=$(node -e "const [sid,dir]=process.argv.slice(1);console.log(JSON.stringify({sessionId:sid||require('crypto').createHash('md5').update(dir).digest('hex').slice(0,16),projectDir:dir}))"     "$CLAUDE_SESSION_ID" "$PROJECT_DIR" 2>/dev/null)
  curl -s -o /dev/null --max-time 1 -X POST -H "Content-Type: application/json"     -d "$PAYLOAD" "http://localhost:$PORT/register-session" 2>/dev/null
}

PLUGIN_DIR="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CURRENT_VERSION=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version||'')}catch{console.log('')}" "$PLUGIN_DIR/.claude-plugin/plugin.json" 2>/dev/null)

# Check if server is already running
HEALTH=$(curl -s --max-time 1 "http://localhost:$PORT/health" 2>/dev/null)
if [ -n "$HEALTH" ]; then
  read -r RUNNING_VERSION OLD_PID < <(echo "$HEALTH" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const h=JSON.parse(d);console.log((h.version||'-')+' '+(h.pid||''))}catch{console.log('-')}})" 2>/dev/null)

  if [ "$RUNNING_VERSION" = "$CURRENT_VERSION" ]; then
    register_session
    exit 0
  fi

  # Version differs — kill and restart
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
    exit 0
  fi
done

exit 0
