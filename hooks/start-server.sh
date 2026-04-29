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
  CURRENT_VERSION=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(require('path').resolve(process.argv[1]),'utf8')).version||'')}catch{console.log('')}" "$SCRIPT_DIR/../.claude-plugin/plugin.json" 2>/dev/null)

  # Tell the running server which project we're in (hooks don't carry env in payload)
  _set_project() {
    local PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
    local PAYLOAD
    PAYLOAD=$(node -e "console.log(JSON.stringify({projectDir:process.argv[1]}))" "$PROJECT_DIR" 2>/dev/null)
    curl -s --max-time 1 -X POST -H "Content-Type: application/json" \
      -d "$PAYLOAD" \
      "http://localhost:$PORT/set-project" > /dev/null 2>&1
  }

  if [ -n "$RUNNING_VERSION" ] && [ "$RUNNING_VERSION" = "$CURRENT_VERSION" ]; then
    _set_project
    exit 0
  fi

  # Semver comparison: only upgrade, never downgrade.
  # If the running server is newer than us, leave it alone.
  _semver_newer() {
    local IFS=.
    local i a=($1) b=($2)
    for ((i=0; i<3; i++)); do
      local av="${a[i]:-0}" bv="${b[i]:-0}"
      if (( av > bv )); then return 0; fi
      if (( av < bv )); then return 1; fi
    done
    return 1
  }

  if [ -n "$RUNNING_VERSION" ] && [ -n "$CURRENT_VERSION" ] && _semver_newer "$RUNNING_VERSION" "$CURRENT_VERSION"; then
    _set_project
    exit 0
  fi

  # Running version is older — kill and upgrade
  OLD_PID=$(echo "$HEALTH" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).pid||'')}catch{console.log('')}})" 2>/dev/null)

  # Cross-platform kill: POSIX kill doesn't work on Windows Node processes
  _kill_pid() {
    if command -v powershell.exe >/dev/null 2>&1; then
      powershell.exe -NoProfile -Command "Stop-Process -Id $1 -Force -ErrorAction SilentlyContinue" 2>/dev/null
    else
      kill "$1" 2>/dev/null
    fi
  }

  if [ -n "$OLD_PID" ]; then
    _kill_pid "$OLD_PID"
    sleep 1
  else
    # Old server has no pid in health (pre-3.0.7) — kill by port
    if command -v powershell.exe >/dev/null 2>&1; then
      powershell.exe -NoProfile -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort $PORT -ErrorAction SilentlyContinue).OwningProcess -Force -ErrorAction SilentlyContinue" 2>/dev/null
    elif command -v lsof >/dev/null 2>&1; then
      kill $(lsof -ti "tcp:$PORT") 2>/dev/null
    fi
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
