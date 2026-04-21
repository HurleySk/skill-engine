#!/bin/bash
# Shared utilities for PreToolUse / PostToolUse hooks.
# Source this file: . "$CLAUDE_PROJECT_DIR/.claude/hooks/lib/hook-helpers.sh"

# Parse the command string from hook JSON input (pass $INPUT as $1)
parse_command() {
  echo "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).tool_input.command||'')}catch{}})" 2>/dev/null
}

# Emit a deny decision and exit
deny() {
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"$1\"}}"
  exit 0
}

# Emit an ask decision and exit
ask() {
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"$1\"}}"
  exit 0
}
