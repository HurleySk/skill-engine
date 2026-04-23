#!/bin/bash
# Shared utilities for PreToolUse / PostToolUse hooks.
# Source this file: . "$CLAUDE_PROJECT_DIR/.claude/hooks/lib/hook-helpers.sh"

# Parse the command string from hook JSON input (pass $INPUT as $1)
# Uses jq for fast JSON parsing (~0.2s vs ~0.3s for node cold-start on Windows)
parse_command() {
  echo "$1" | jq -r '.tool_input.command // empty' 2>/dev/null
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
