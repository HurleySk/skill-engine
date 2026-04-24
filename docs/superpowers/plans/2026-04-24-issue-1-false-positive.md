# Issue #1: False-positive enforcement + version staleness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix false-positive guardrail enforcement on read-only tools and add version-aware server restart so plugin upgrades take effect immediately.

**Architecture:** Two-layer tool filtering (plugin.json matcher + per-rule toolNames Set) eliminates enforcement for read-only tools. Health endpoint gains version/pid fields; start-server.sh compares versions and auto-restarts stale servers.

**Tech Stack:** Node.js (node:test), bash, Claude Code hook system

---

### Task 1: Add tool_name filtering to handleEnforce and compileRules

**Files:**
- Modify: `server/server.js:38-63` (compileRules — add toolNamesSet)
- Modify: `server/server.js:202-255` (handleEnforce — add tool_name check)
- Test: `tests/server.test.js`

- [ ] **Step 1: Write failing tests for tool_name filtering**

Add a new `describe` block in `tests/server.test.js`. The test server needs a rule with `toolNames` set and one without. Tests verify that enforce skips rules when the tool doesn't match, and allows rules without `toolNames` to match any tool.

Add this at the end of the file (before the closing, after the Pause/Resume describe block):

```js
describe('Tool Name Filtering', () => {
  let serverProcess;
  let tmpDir;
  let rulesDir;
  let testSqlFile;
  const PORT = 19757;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-toolname-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'edit-only-rule': {
          type: 'guardrail',
          description: 'Only blocks Edit tool',
          enforcement: 'block',
          blockMessage: 'Edit only',
          triggers: {
            file: {
              toolNames: ['Edit'],
              pathPatterns: ['**/*.sql']
            }
          }
        },
        'any-tool-rule': {
          type: 'guardrail',
          description: 'Blocks any write tool',
          enforcement: 'block',
          blockMessage: 'Any tool blocked',
          triggers: {
            file: {
              pathPatterns: ['**/*.config']
            }
          }
        }
      }
    }));

    testSqlFile = path.join(tmpDir, 'test.sql');
    fs.writeFileSync(testSqlFile, 'SELECT 1');

    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT), '--rules-dir', rulesDir], { stdio: 'pipe' });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 5000);
      serverProcess.stdout.on('data', (data) => {
        if (data.toString().includes('listening')) { clearTimeout(timeout); resolve(); }
      });
      serverProcess.on('error', reject);
    });
  });

  after(() => {
    if (serverProcess) serverProcess.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks when tool_name matches rule toolNames', async () => {
    const res = await request('POST', '/enforce', {
      tool_name: 'Edit',
      tool_input: { file_path: testSqlFile }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(res.body.hookSpecificOutput.permissionDecisionReason, 'Edit only');
  });

  it('skips rule when tool_name does not match rule toolNames', async () => {
    const res = await request('POST', '/enforce', {
      tool_name: 'Write',
      tool_input: { file_path: testSqlFile }
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should not enforce for non-matching tool');
  });

  it('enforces rule without toolNames for any tool_name', async () => {
    const configFile = path.join(tmpDir, 'app.config');
    fs.writeFileSync(configFile, '<configuration />');
    const res = await request('POST', '/enforce', {
      tool_name: 'Write',
      tool_input: { file_path: configFile }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
  });

  it('enforces rule without toolNames even when tool_name is absent', async () => {
    const configFile = path.join(tmpDir, 'app.config');
    fs.writeFileSync(configFile, '<configuration />');
    const res = await request('POST', '/enforce', {
      tool_input: { file_path: configFile }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/server.test.js`
Expected: The "skips rule when tool_name does not match rule toolNames" test should FAIL — the current server has no tool_name filtering, so it blocks regardless of tool_name.

- [ ] **Step 3: Add toolNamesSet to compileRules in server.js**

In `server/server.js`, inside the `compileRules` function, after the file trigger compilation block (after `entry.contentRe` assignment around line 58), add:

```js
      if (ft.toolNames && Array.isArray(ft.toolNames) && ft.toolNames.length) {
        entry.toolNamesSet = new Set(ft.toolNames);
      }
```

- [ ] **Step 4: Add tool_name check to handleEnforce in server.js**

In `server/server.js`, inside the `handleEnforce` function, extract `tool_name` from input alongside `file_path`. Then add the toolNames check inside the loop, after the `checkSkip` call and before the `matchFileCompiled` call:

Change the top of `handleEnforce` from:

```js
function handleEnforce(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const filePath = input && input.tool_input && input.tool_input.file_path;
  if (!filePath) return {};
```

To:

```js
function handleEnforce(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const filePath = input && input.tool_input && input.tool_input.file_path;
  if (!filePath) return {};
  const toolName = input && input.tool_name;
```

Then inside the `for` loop, after the `if (checkSkip(...)) continue;` line, add:

```js
    if (entry.toolNamesSet && toolName && !entry.toolNamesSet.has(toolName)) continue;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/server.test.js`
Expected: ALL tests pass, including the new Tool Name Filtering tests.

- [ ] **Step 6: Commit**

```bash
git add server/server.js tests/server.test.js
git commit -m "feat: add per-rule toolNames filtering to enforce endpoint

Rules can specify toolNames in file triggers to restrict which tools
they apply to. Pre-compiled to a Set at load time for O(1) lookup.
Rules without toolNames match any tool (backward compatible).

Fixes the false-positive half of #1."
```

---

### Task 2: Add version and pid to /health endpoint

**Files:**
- Modify: `server/server.js:1-20` (top-level — read version from plugin.json)
- Modify: `server/server.js:293-307` (health handler — add version + pid)
- Test: `tests/server.test.js`

- [ ] **Step 1: Write failing tests for version and pid in /health**

Add these two tests inside the existing `describe('Server Health')` block, after the existing `it('GET /health includes timing stats')` test:

```js
  it('GET /health includes version from plugin.json', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.version, 'string');
    assert.ok(res.body.version.match(/^\d+\.\d+\.\d+$/), 'version should be semver');
  });

  it('GET /health includes pid as a number', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.pid, 'number');
    assert.ok(res.body.pid > 0, 'pid should be positive');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/server.test.js`
Expected: Both new tests FAIL — `/health` currently returns no `version` or `pid` field.

- [ ] **Step 3: Read plugin.json version at startup and add to /health**

At the top of `server/server.js`, after the `RULES_DIR` declaration (around line 19), add:

```js
// --- Version from plugin.json (read once at startup) ---
const PLUGIN_JSON = path.resolve(__dirname, '..', '.claude-plugin', 'plugin.json');
let SERVER_VERSION = 'unknown';
try {
  SERVER_VERSION = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).version || 'unknown';
} catch {}
```

Then in the `/health` handler, add `version` and `pid` to the response object:

Change the respond call from:

```js
    return respond(res, 200, {
      uptime: process.uptime(),
      rulesLoaded: compiledRules.length,
      port: PORT,
      lastEvent,
      eventsProcessed,
      activeSessions: sessions.size,
      avgResponseTimeMs: Math.round(avgMs * 100) / 100,
      paused,
    });
```

To:

```js
    return respond(res, 200, {
      version: SERVER_VERSION,
      pid: process.pid,
      uptime: process.uptime(),
      rulesLoaded: compiledRules.length,
      port: PORT,
      lastEvent,
      eventsProcessed,
      activeSessions: sessions.size,
      avgResponseTimeMs: Math.round(avgMs * 100) / 100,
      paused,
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/server.test.js`
Expected: ALL tests pass, including the new version and pid tests.

- [ ] **Step 5: Commit**

```bash
git add server/server.js tests/server.test.js
git commit -m "feat: add version and pid to /health endpoint

Version read from plugin.json once at startup (zero cost per request).
PID enables start-server.sh to kill stale processes by PID.

Part of version staleness fix for #1."
```

---

### Task 3: Add matcher to PreToolUse hook in plugin.json

**Files:**
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Add matcher to PreToolUse hook entry**

In `.claude-plugin/plugin.json`, change the `PreToolUse` section from:

```json
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:19750/enforce"
          }
        ]
      }
    ]
```

To:

```json
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:19750/enforce"
          }
        ]
      }
    ]
```

- [ ] **Step 2: Validate plugin.json is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/plugin.json
git commit -m "perf: add matcher to PreToolUse hook to skip read-only tools

Claude Code evaluates the matcher before calling the hook, so Read,
Grep, Glob, Bash etc. never hit the enforce endpoint at all.
This is the primary performance win for #1."
```

---

### Task 4: Version-aware restart in start-server.sh

**Files:**
- Modify: `hooks/start-server.sh`

- [ ] **Step 1: Update the health check section to compare versions**

Replace the current "Check if server is already running" block (lines 12-14):

```bash
# Check if server is already running
if curl -s --max-time 1 "http://localhost:$PORT/health" > /dev/null 2>&1; then
  exit 0
fi
```

With:

```bash
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
```

Note: The `SCRIPT_DIR` declaration is now inside this block, which means we must remove the duplicate declaration later in the file. The full file after edit should be:

```bash
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
```

- [ ] **Step 2: Verify the script is syntactically valid**

Run: `bash -n hooks/start-server.sh && echo 'valid'`
Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add hooks/start-server.sh
git commit -m "feat: version-aware server restart in start-server.sh

Compares running server version (from /health) with plugin.json version.
If they differ, kills old process by PID and starts fresh, logging
the version transition. Same-version case exits immediately as before.

Completes #1."
```

---

### Task 5: Final verification

**Files:** None (read-only check)

- [ ] **Step 1: Run full test suite**

Run: `node --test tests/server.test.js`
Expected: ALL tests pass. Zero failures.

- [ ] **Step 2: Run all other test files to check for regressions**

Run: `node --test tests/glob-match.test.js tests/rules-io.test.js tests/hook-manager.test.js tests/learn.test.js tests/skill-scaffold.test.js`
Expected: ALL tests pass.

- [ ] **Step 3: Verify plugin.json is valid**

Run: `node -e "const p = JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8')); console.log(p.hooks.PreToolUse[0].matcher)"`
Expected: `Edit|Write|NotebookEdit`

- [ ] **Step 4: Verify /health reports version when server is started manually**

Run: `node server/server.js --port 19799 --rules-dir /tmp/empty &` then `curl -s http://localhost:19799/health | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).version,JSON.parse(d).pid))"`
Expected: Prints the version (e.g., `3.0.6`) and a PID number. Kill the server afterward: `kill %1`
