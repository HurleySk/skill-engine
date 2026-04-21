#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$SCRIPT_DIR/../hooks"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"
PASS=0
FAIL=0

# On Windows/Git Bash, convert POSIX paths to Windows-compatible paths for Node.js
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

# Set up temp project dir with rules
TMPDIR_BASE=$(mktemp -d)
RULES_DIR="$TMPDIR_BASE/.claude/skills"
mkdir -p "$RULES_DIR"
cp "$FIXTURES_DIR/valid-rules.json" "$RULES_DIR/skill-rules.json"

# Get Node-compatible paths
NODE_TMPDIR_BASE=$(node_path "$TMPDIR_BASE")
NODE_FIXTURES_DIR=$(node_path "$FIXTURES_DIR")

echo ""
echo "=== activate.sh tests ==="

set +e
OUTPUT=$(echo "{\"prompt\":\"create a stored proc\",\"session_id\":\"hook-test-1\",\"cwd\":\"$NODE_TMPDIR_BASE\"}" \
  | bash "$HOOKS_DIR/activate.sh" 2>/dev/null)
EXIT=$?
set -e
assert_exit "activate exits 0 on keyword match" 0 $EXIT
assert_contains "activate output contains sql-standards" "sql-standards" "$OUTPUT"
assert_contains "activate output contains CRITICAL" "CRITICAL" "$OUTPUT"

set +e
OUTPUT=$(echo "{\"prompt\":\"build a REST API\",\"session_id\":\"hook-test-2\",\"cwd\":\"$NODE_TMPDIR_BASE\"}" \
  | bash "$HOOKS_DIR/activate.sh" 2>/dev/null)
EXIT=$?
set -e
assert_exit "activate exits 0 on no match" 0 $EXIT
assert_empty "activate output is empty on no match" "$OUTPUT"

set +e
OUTPUT=$(echo "{\"prompt\":\"anything\",\"session_id\":\"hook-test-3\",\"cwd\":\"C:/nonexistent/path\"}" \
  | bash "$HOOKS_DIR/activate.sh" 2>/dev/null)
EXIT=$?
set -e
assert_exit "activate exits 0 with no rules file" 0 $EXIT
assert_empty "activate output is empty with no rules file" "$OUTPUT"

rm -rf "$TMPDIR_BASE"

echo ""
echo "=== enforce.sh tests ==="

TMPDIR_ENF=$(mktemp -d)
RULES_DIR_ENF="$TMPDIR_ENF/.claude/skills"
mkdir -p "$RULES_DIR_ENF"
cp "$FIXTURES_DIR/valid-rules.json" "$RULES_DIR_ENF/skill-rules.json"
NODE_TMPDIR_ENF=$(node_path "$TMPDIR_ENF")

# Test: block rule fires on SQL file
set +e
OUTPUT=$(echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$NODE_FIXTURES_DIR/sample.sql\"},\"session_id\":\"enf-test-1\",\"cwd\":\"$NODE_TMPDIR_ENF\"}" \
  | bash "$HOOKS_DIR/enforce.sh" 2>&1 1>/dev/null)
EXIT=$?
set -e
assert_exit "enforce exits 2 on block rule match" 2 $EXIT
assert_contains "enforce stderr contains blockMessage" "SQL standards apply" "$OUTPUT"

# Test: warn rule fires on config file
set +e
STDERR=$(echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$NODE_FIXTURES_DIR/sample.config\"},\"session_id\":\"enf-test-2\",\"cwd\":\"$NODE_TMPDIR_ENF\"}" \
  | bash "$HOOKS_DIR/enforce.sh" 2>&1 1>/dev/null)
EXIT=$?
set -e
assert_exit "enforce exits 0 on warn rule" 0 $EXIT
assert_contains "enforce stderr contains warning" "config-warning" "$STDERR"

# Test: no match — silent exit 0
set +e
OUTPUT=$(echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"C:/some/readme.md\"},\"session_id\":\"enf-test-3\",\"cwd\":\"$NODE_TMPDIR_ENF\"}" \
  | bash "$HOOKS_DIR/enforce.sh" 2>&1)
EXIT=$?
set -e
assert_exit "enforce exits 0 on no match" 0 $EXIT

# Test: skip marker bypasses block
set +e
OUTPUT=$(echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$NODE_FIXTURES_DIR/sample-skip.sql\"},\"session_id\":\"enf-test-4\",\"cwd\":\"$NODE_TMPDIR_ENF\"}" \
  | bash "$HOOKS_DIR/enforce.sh" 2>&1)
EXIT=$?
set -e
assert_exit "enforce exits 0 when skip marker present" 0 $EXIT

# Test: no rules file — silent pass-through
set +e
OUTPUT=$(echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"C:/some/file.sql\"},\"cwd\":\"C:/nonexistent/path\"}" \
  | bash "$HOOKS_DIR/enforce.sh" 2>&1)
EXIT=$?
set -e
assert_exit "enforce exits 0 with no rules file" 0 $EXIT

rm -rf "$TMPDIR_ENF"

echo ""
echo "=== learn.js + enforce.sh integration ==="

TMPDIR_LEARN=$(mktemp -d)
RULES_DIR_LEARN="$TMPDIR_LEARN/.claude/skills"
mkdir -p "$RULES_DIR_LEARN"

# Write a minimal skill-rules.json (required for engine to load)
echo '{"version":"1.0","defaults":{"enforcement":"suggest","priority":"medium"},"rules":{}}' \
  > "$RULES_DIR_LEARN/skill-rules.json"

NODE_TMPDIR_LEARN=$(node_path "$TMPDIR_LEARN")
NODE_LEARNED_FILE=$(node_path "$RULES_DIR_LEARN/learned-rules.json")
LEARN_SCRIPT="$SCRIPT_DIR/../hooks/lib/learn.js"

# Add a learned warn rule via learn.js
RULE_JSON='{"type":"guardrail","enforcement":"warn","description":"Learned: always review JS files","triggers":{"file":{"pathPatterns":["**/*.js"]}}}'
node "$LEARN_SCRIPT" add js-review "$RULE_JSON" --file "$NODE_LEARNED_FILE" > /dev/null

# Verify the learned rule file was created
set +e
OUTPUT=$(cat "$RULES_DIR_LEARN/learned-rules.json" 2>/dev/null)
set -e
assert_contains "learned-rules.json contains js-review rule" "js-review" "$OUTPUT"

# Now enforce.sh should fire the learned warn rule on a .js file
set +e
STDERR=$(echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"C:/some/path/app.js\"},\"session_id\":\"learn-int-1\",\"cwd\":\"$NODE_TMPDIR_LEARN\"}" \
  | bash "$HOOKS_DIR/enforce.sh" 2>&1 1>/dev/null)
EXIT=$?
set -e
assert_exit "enforce exits 0 for learned warn rule" 0 $EXIT
assert_contains "enforce stderr contains learned rule name" "js-review" "$STDERR"

rm -rf "$TMPDIR_LEARN"

echo ""
echo "=== Results ==="
echo "$PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] && exit 0 || exit 1
