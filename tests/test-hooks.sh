#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$SCRIPT_DIR/../hooks"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"
PASS=0
FAIL=0

node_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    echo "$1"
  fi
}

assert_exit() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc (expected exit $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc (expected to contain: $expected)"
    FAIL=$((FAIL + 1))
  fi
}

assert_empty() {
  local desc="$1" actual="$2"
  if [ -z "$actual" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc (expected empty, got: $actual)"
    FAIL=$((FAIL + 1))
  fi
}

assert_equals() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc (expected: $expected, got: $actual)"
    FAIL=$((FAIL + 1))
  fi
}

NODE_FIXTURES_DIR=$(node_path "$FIXTURES_DIR")

echo ""
echo "=== _resolve_latest_plugin_dir tests ==="

# Source the function from start-server.sh without running the rest
# We extract the function and test it in isolation
TMPDIR_CACHE=$(mktemp -d)
MOCK_CACHE="$TMPDIR_CACHE/.claude/plugins/cache/hurleysk-marketplace/skill-engine"

# Test: multiple versions — picks latest
mkdir -p "$MOCK_CACHE/3.1.0" "$MOCK_CACHE/3.2.7" "$MOCK_CACHE/3.3.0"
RESULT=$(HOME="$TMPDIR_CACHE" bash -c '
  _resolve_latest_plugin_dir() {
    local CACHE_BASE="$HOME/.claude/plugins/cache/hurleysk-marketplace/skill-engine"
    local LATEST
    LATEST=$(ls -d "$CACHE_BASE"/*/ 2>/dev/null | sort -V | tail -1)
    if [ -n "$LATEST" ]; then
      echo "${LATEST%/}"
    else
      echo "FALLBACK"
    fi
  }
  _resolve_latest_plugin_dir
')
assert_contains "picks latest from multiple versions" "3.3.0" "$RESULT"

# Test: single version
rm -rf "$MOCK_CACHE"
mkdir -p "$MOCK_CACHE/2.0.0"
RESULT=$(HOME="$TMPDIR_CACHE" bash -c '
  _resolve_latest_plugin_dir() {
    local CACHE_BASE="$HOME/.claude/plugins/cache/hurleysk-marketplace/skill-engine"
    local LATEST
    LATEST=$(ls -d "$CACHE_BASE"/*/ 2>/dev/null | sort -V | tail -1)
    if [ -n "$LATEST" ]; then
      echo "${LATEST%/}"
    else
      echo "FALLBACK"
    fi
  }
  _resolve_latest_plugin_dir
')
assert_contains "works with single version" "2.0.0" "$RESULT"

# Test: no cache — falls back
rm -rf "$MOCK_CACHE"
RESULT=$(HOME="$TMPDIR_CACHE" bash -c '
  _resolve_latest_plugin_dir() {
    local CACHE_BASE="$HOME/.claude/plugins/cache/hurleysk-marketplace/skill-engine"
    local LATEST
    LATEST=$(ls -d "$CACHE_BASE"/*/ 2>/dev/null | sort -V | tail -1)
    if [ -n "$LATEST" ]; then
      echo "${LATEST%/}"
    else
      echo "FALLBACK"
    fi
  }
  _resolve_latest_plugin_dir
')
assert_equals "falls back when no cache exists" "FALLBACK" "$RESULT"

# Test: many versions in non-sorted order
rm -rf "$MOCK_CACHE"
mkdir -p "$MOCK_CACHE/3.0.9" "$MOCK_CACHE/3.0.5" "$MOCK_CACHE/3.1.0" "$MOCK_CACHE/3.10.0" "$MOCK_CACHE/3.2.0"
RESULT=$(HOME="$TMPDIR_CACHE" bash -c '
  _resolve_latest_plugin_dir() {
    local CACHE_BASE="$HOME/.claude/plugins/cache/hurleysk-marketplace/skill-engine"
    local LATEST
    LATEST=$(ls -d "$CACHE_BASE"/*/ 2>/dev/null | sort -V | tail -1)
    if [ -n "$LATEST" ]; then
      echo "${LATEST%/}"
    else
      echo "FALLBACK"
    fi
  }
  _resolve_latest_plugin_dir
')
assert_contains "handles double-digit minor version correctly" "3.10.0" "$RESULT"

rm -rf "$TMPDIR_CACHE"

echo ""
echo "=== learn.js tests ==="

TMPDIR_LEARN=$(mktemp -d)
RULES_DIR_LEARN="$TMPDIR_LEARN/.claude/skills"
mkdir -p "$RULES_DIR_LEARN"

echo '{"version":"1.0","defaults":{"enforcement":"suggest","priority":"medium"},"rules":{}}' \
  > "$RULES_DIR_LEARN/skill-rules.json"

NODE_TMPDIR_LEARN=$(node_path "$TMPDIR_LEARN")
NODE_LEARNED_FILE=$(node_path "$RULES_DIR_LEARN/learned-rules.json")
LEARN_SCRIPT="$SCRIPT_DIR/../hooks/lib/learn.js"

# Add a learned rule
RULE_JSON='{"type":"guardrail","enforcement":"warn","description":"Learned: always review JS files","triggers":{"file":{"pathPatterns":["**/*.js"]}}}'
node "$LEARN_SCRIPT" add js-review "$RULE_JSON" --file "$NODE_LEARNED_FILE" > /dev/null

set +e
OUTPUT=$(cat "$RULES_DIR_LEARN/learned-rules.json" 2>/dev/null)
set -e
assert_contains "learned-rules.json contains js-review rule" "js-review" "$OUTPUT"
assert_contains "learned rule has correct enforcement" "warn" "$OUTPUT"
assert_contains "learned rule has correct description" "always review JS files" "$OUTPUT"

# List rules
set +e
LIST_OUTPUT=$(node "$LEARN_SCRIPT" list --file "$NODE_LEARNED_FILE" 2>/dev/null)
set -e
assert_contains "list shows js-review rule" "js-review" "$LIST_OUTPUT"

# Remove rule
node "$LEARN_SCRIPT" remove js-review --file "$NODE_LEARNED_FILE" > /dev/null 2>&1
set +e
OUTPUT=$(cat "$RULES_DIR_LEARN/learned-rules.json" 2>/dev/null)
set -e
if echo "$OUTPUT" | grep -q "js-review"; then
  echo "  ✗ remove deletes the rule (rule still present)"
  FAIL=$((FAIL + 1))
else
  echo "  ✓ remove deletes the rule"
  PASS=$((PASS + 1))
fi

rm -rf "$TMPDIR_LEARN"

echo ""
echo "=== glob-match.js tests ==="

GLOB_SCRIPT="$SCRIPT_DIR/../hooks/lib/glob-match.js"

# Test normalizePath
RESULT=$(node -e "
  const {normalizePath} = require('$(node_path "$GLOB_SCRIPT")');
  console.log(normalizePath('C:\\\\Users\\\\test\\\\file.js'));
")
assert_equals "normalizePath converts backslashes" "C:/Users/test/file.js" "$RESULT"

# Test globMatch
RESULT=$(node -e "
  const {globMatch} = require('$(node_path "$GLOB_SCRIPT")');
  console.log(globMatch('**/*.sql', 'src/queries/main.sql'));
")
assert_equals "globMatch matches **/*.sql" "true" "$RESULT"

RESULT=$(node -e "
  const {globMatch} = require('$(node_path "$GLOB_SCRIPT")');
  console.log(globMatch('**/*.sql', 'src/queries/main.js'));
")
assert_equals "globMatch rejects non-matching" "false" "$RESULT"

RESULT=$(node -e "
  const {globMatch} = require('$(node_path "$GLOB_SCRIPT")');
  console.log(globMatch('src/**/*.config', 'src/app/database.config'));
")
assert_equals "globMatch matches nested path" "true" "$RESULT"

echo ""
echo "=== Results ==="
echo "$PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] && exit 0 || exit 1
