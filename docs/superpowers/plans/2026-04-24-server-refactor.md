# Server Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the dead command-hook path, add pause/resume mode to eliminate ECONNREFUSED errors, and consolidate code.

**Architecture:** Extract rule-loading utilities from `engine.js` into a slim `rules-io.js` module. Delete all command-hook logic (matching, sessions, CLI entry point). Add pause/resume endpoints to the HTTP server so the stop command disables hooks without killing the process.

**Tech Stack:** Node.js, node:test, node:http

---

### Task 1: Create `rules-io.js` and delete `engine.js`

**Files:**
- Create: `hooks/lib/rules-io.js`
- Delete: `hooks/lib/engine.js`
- Modify: `hooks/lib/learn.js:5` (update import)
- Modify: `server/server.js:10` (update import)

- [ ] **Step 1: Create `hooks/lib/rules-io.js`**

```javascript
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizePath } = require('./glob-match');

function findFileInAncestors(startDir, filename) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, '.claude', 'skills', filename);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir || dir === root) return null;
    dir = parent;
  }
}

function findRulesFile(startDir) {
  return findFileInAncestors(startDir, 'skill-rules.json');
}

function findLearnedRulesFile(startDir) {
  return findFileInAncestors(startDir, 'learned-rules.json');
}

function loadRules(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data.rules || data.version !== '1.0') return null;
    return data;
  } catch {
    return null;
  }
}

module.exports = { findRulesFile, findLearnedRulesFile, loadRules, normalizePath };
```

- [ ] **Step 2: Update import in `learn.js`**

Change line 5 from:
```javascript
const { normalizePath, loadRules } = require('./engine.js');
```
to:
```javascript
const { normalizePath, loadRules } = require('./rules-io.js');
```

- [ ] **Step 3: Update import in `server/server.js`**

Change line 10 from:
```javascript
const { loadRules, findRulesFile, findLearnedRulesFile } = require(path.join(libDir, 'engine'));
```
to:
```javascript
const { loadRules, findRulesFile, findLearnedRulesFile } = require(path.join(libDir, 'rules-io'));
```

Also update the comment on line 7 from:
```javascript
// --- Shared utilities from engine.js / glob-match.js ---
```
to:
```javascript
// --- Shared utilities from rules-io.js / glob-match.js ---
```

- [ ] **Step 4: Delete `hooks/lib/engine.js`**

```bash
git rm hooks/lib/engine.js
```

- [ ] **Step 5: Run all tests to verify nothing broke**

```bash
node --test tests/learn.test.js tests/server.test.js tests/glob-match.test.js tests/hook-manager.test.js tests/skill-scaffold.test.js
```

Expected: All tests pass. `engine.test.js` will not run (it still imports engine.js, which is deleted — we handle that in Task 2).

- [ ] **Step 6: Commit**

```bash
git add hooks/lib/rules-io.js hooks/lib/learn.js server/server.js
git commit -m "refactor: extract rules-io.js from engine.js, delete command hook path"
```

---

### Task 2: Replace `engine.test.js` with `rules-io.test.js`

**Files:**
- Create: `tests/rules-io.test.js`
- Delete: `tests/engine.test.js`

- [ ] **Step 1: Create `tests/rules-io.test.js`**

Keep only the "Rules Loading" tests (rule file discovery, loadRules, normalizePath re-export). All activate/enforce/matching/session tests are deleted — they tested the command hook path which no longer exists. The server.test.js already covers the HTTP equivalents.

```javascript
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const rulesIO = require(path.resolve(__dirname, '..', 'hooks', 'lib', 'rules-io.js'));

describe('Rules Loading', () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures');

  it('loadRules returns parsed data for valid rules file', () => {
    const result = rulesIO.loadRules(path.join(fixturesDir, 'valid-rules.json'));
    assert.equal(result.version, '1.0');
    assert.ok(result.rules['sql-standards']);
    assert.ok(result.rules['pipeline-guidance']);
    assert.ok(result.rules['config-warning']);
    assert.equal(result.defaults.enforcement, 'suggest');
    assert.equal(result.defaults.priority, 'medium');
  });

  it('loadRules returns null for missing file', () => {
    const result = rulesIO.loadRules('/nonexistent/path/rules.json');
    assert.equal(result, null);
  });

  it('loadRules returns null for malformed JSON', () => {
    const result = rulesIO.loadRules(path.join(fixturesDir, 'malformed.json'));
    assert.equal(result, null);
  });

  it('loadRules returns null for JSON without version field', () => {
    const tmpFile = path.join(os.tmpdir(), 'no-version.json');
    fs.writeFileSync(tmpFile, JSON.stringify({ rules: {} }));
    const result = rulesIO.loadRules(tmpFile);
    assert.equal(result, null);
    fs.unlinkSync(tmpFile);
  });

  it('findRulesFile walks up directories to find skill-rules.json', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'se-test-'));
    const projectDir = path.join(tmpBase, 'project');
    const srcDir = path.join(projectDir, 'src', 'deep');
    const rulesDir = path.join(projectDir, '.claude', 'skills');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(rulesDir, { recursive: true });
    const rulesFile = path.join(rulesDir, 'skill-rules.json');
    fs.writeFileSync(rulesFile, '{"version":"1.0","rules":{}}');
    const found = rulesIO.findRulesFile(srcDir);
    assert.equal(found, rulesFile);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('findRulesFile returns null when no rules file exists', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'se-test-'));
    const result = rulesIO.findRulesFile(tmpBase);
    assert.equal(result, null);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('findLearnedRulesFile finds learned-rules.json walking up directories', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'se-test-'));
    const projectDir = path.join(tmpBase, 'project');
    const srcDir = path.join(projectDir, 'src', 'deep');
    const rulesDir = path.join(projectDir, '.claude', 'skills');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(rulesDir, { recursive: true });
    const learnedFile = path.join(rulesDir, 'learned-rules.json');
    fs.writeFileSync(learnedFile, '{"version":"1.0","rules":{}}');
    const found = rulesIO.findLearnedRulesFile(srcDir);
    assert.equal(found, learnedFile);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('findLearnedRulesFile returns null when no file exists', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'se-test-'));
    const result = rulesIO.findLearnedRulesFile(tmpBase);
    assert.equal(result, null);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('re-exports normalizePath from glob-match', () => {
    assert.equal(typeof rulesIO.normalizePath, 'function');
    assert.equal(rulesIO.normalizePath('C:\\Users\\test\\file.sql'), 'C:/Users/test/file.sql');
  });
});
```

- [ ] **Step 2: Delete `tests/engine.test.js`**

```bash
git rm tests/engine.test.js
```

- [ ] **Step 3: Run the new test file**

```bash
node --test tests/rules-io.test.js
```

Expected: All 8 tests pass.

- [ ] **Step 4: Run all tests to verify nothing broke**

```bash
node --test tests/rules-io.test.js tests/server.test.js tests/learn.test.js tests/glob-match.test.js tests/hook-manager.test.js tests/skill-scaffold.test.js
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/rules-io.test.js
git commit -m "test: replace engine.test.js with rules-io.test.js"
```

---

### Task 3: Add pause/resume endpoints to server

**Files:**
- Modify: `server/server.js`
- Modify: `tests/server.test.js`

- [ ] **Step 1: Write failing tests for pause/resume**

Add a new describe block to `tests/server.test.js` after the existing "Kill Switch" describe:

```javascript
describe('Pause / Resume', () => {
  let serverProcess;
  let tmpDir;
  let rulesDir;
  let testSqlFile;
  const PORT = 19756;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-pause-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'block-rule': {
          type: 'guardrail',
          description: 'Block SQL files',
          enforcement: 'block',
          blockMessage: 'SQL blocked',
          triggers: { file: { pathPatterns: ['**/*.sql'] } }
        },
        'activate-rule': {
          type: 'domain',
          description: 'Test activation',
          triggers: { prompt: { keywords: ['activate-test'] } }
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

  it('POST /pause returns paused true', async () => {
    const res = await request('POST', '/pause', null, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.paused, true);
  });

  it('health shows paused state', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.paused, true);
  });

  it('enforce returns empty when paused', async () => {
    const res = await request('POST', '/enforce', { tool_input: { file_path: testSqlFile } }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should have no hookSpecificOutput when paused');
  });

  it('activate returns empty when paused', async () => {
    const res = await request('POST', '/activate', { prompt: 'activate-test keyword' }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should have no hookSpecificOutput when paused');
  });

  it('POST /resume returns paused false', async () => {
    const res = await request('POST', '/resume', null, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.paused, false);
  });

  it('health shows unpaused state after resume', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.paused, false);
  });

  it('enforce blocks again after resume', async () => {
    const res = await request('POST', '/enforce', { tool_input: { file_path: testSqlFile } }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.equal(hso.hookEventName, 'PreToolUse');
    assert.equal(hso.permissionDecision, 'deny');
  });

  it('activate matches again after resume', async () => {
    const res = await request('POST', '/activate', { prompt: 'activate-test keyword', session_id: 'pause-resume-test' }, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('activate-rule'));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test tests/server.test.js
```

Expected: The new "Pause / Resume" tests fail (404 on /pause and /resume).

- [ ] **Step 3: Add `paused` state and endpoints to `server/server.js`**

Add the paused flag after line 258 (the `let lastEvent = null;` line):

```javascript
let paused = false;
```

Replace the `SKILL_ENGINE_OFF` early returns in `handleActivate` (line 152) and `handleEnforce` (line 203):

In `handleActivate`, change:
```javascript
if (process.env.SKILL_ENGINE_OFF === '1') return {};
```
to:
```javascript
if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
```

In `handleEnforce`, change:
```javascript
if (process.env.SKILL_ENGINE_OFF === '1') return {};
```
to:
```javascript
if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
```

Add the `paused` field to the health response (inside the `GET /health` handler, after the `avgResponseTimeMs` line):

```javascript
paused,
```

Add the pause and resume endpoints in `handleRequest`, after the `/reload` handler and before the 404 fallback:

```javascript
  if (method === 'POST' && url === '/pause') {
    paused = true;
    return respond(res, 200, { paused: true });
  }

  if (method === 'POST' && url === '/resume') {
    paused = false;
    return respond(res, 200, { paused: false });
  }
```

- [ ] **Step 4: Run all tests**

```bash
node --test tests/server.test.js
```

Expected: All tests pass including the new Pause / Resume suite.

- [ ] **Step 5: Commit**

```bash
git add server/server.js tests/server.test.js
git commit -m "feat: add pause/resume endpoints to eliminate ECONNREFUSED on stop"
```

---

### Task 4: Update stop, start, and status skills

**Files:**
- Modify: `skills/stop/SKILL.md`
- Modify: `skills/start/SKILL.md`
- Modify: `skills/status/SKILL.md`

- [ ] **Step 1: Rewrite `skills/stop/SKILL.md`**

```markdown
---
name: stop
description: Pause the skill-engine HTTP server. Hooks will silently no-op until it is resumed.
---

# Skill Engine — Stop (Pause)

Pause the rule enforcement server. After pausing, all HTTP hooks return empty responses — Claude Code is unaffected.

## Steps

1. Check if the server is running:

\`\`\`bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
\`\`\`

2. **If not running** (connection refused), tell the user:

> Skill Engine server is not running. Nothing to pause.

3. **If running**, pause it:

\`\`\`bash
curl -s -X POST http://localhost:${SKILL_ENGINE_PORT:-19750}/pause
\`\`\`

4. Verify with health check:

\`\`\`bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
\`\`\`

Confirm the `paused` field is `true`. Tell the user:

> Skill Engine paused. Hooks will silently no-op until resumed with `/skill-engine:start`.
```

- [ ] **Step 2: Rewrite `skills/start/SKILL.md`**

```markdown
---
name: start
description: Start or resume the skill-engine HTTP server. Shows server status.
---

# Skill Engine — Start

Start or resume the rule enforcement server.

## Steps

1. Check if the server is running:

\`\`\`bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
\`\`\`

2. **If running and paused** (`paused: true` in health response), resume it:

\`\`\`bash
curl -s -X POST http://localhost:${SKILL_ENGINE_PORT:-19750}/resume
\`\`\`

Re-check health and show status. Tell the user: "Skill Engine resumed."

3. **If running and not paused**, show the user the status:

> Skill Engine server is already running.
> - Port: {port}
> - Uptime: {uptime}s
> - Rules loaded: {rulesLoaded}
> - Events processed: {eventsProcessed}
> - Active sessions: {activeSessions}

4. **If not running** (connection refused), start the server:

\`\`\`bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
bash "$PLUGIN_DIR/hooks/start-server.sh"
\`\`\`

Then re-check health and show status to confirm it started.

5. If the server still doesn't start after the script runs, tell the user:

> Server failed to start. Check that port ${SKILL_ENGINE_PORT:-19750} is free and Node.js is available.
```

- [ ] **Step 3: Update `skills/status/SKILL.md`**

```markdown
---
name: status
description: Show skill-engine server diagnostics — port, uptime, rules loaded, events processed, active sessions, paused state.
---

# Skill Engine — Status

Show the current state of the rule enforcement server.

## Steps

1. Check server health:

\`\`\`bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
\`\`\`

2. **If running**, display:

> **Skill Engine Server**
> - Status: Running (or "Paused" if `paused: true`)
> - Port: {port}
> - Uptime: {uptime}s
> - Rules loaded: {rulesLoaded}
> - Events processed: {eventsProcessed}
> - Last event: {lastEvent}
> - Active sessions: {activeSessions}

3. **If not running**, display:

> **Skill Engine Server**
> - Status: Not running
> - HTTP hooks are silently no-op until the server is started.
> - Run `/skill-engine:start` to start.
```

- [ ] **Step 4: Commit**

```bash
git add skills/stop/SKILL.md skills/start/SKILL.md skills/status/SKILL.md
git commit -m "docs: update stop/start/status skills for pause/resume mode"
```

---

### Task 5: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

```bash
node --test tests/rules-io.test.js tests/server.test.js tests/learn.test.js tests/glob-match.test.js tests/hook-manager.test.js tests/skill-scaffold.test.js
```

Expected: All tests pass across all suites.

- [ ] **Step 2: Verify engine.js is gone**

```bash
ls hooks/lib/engine.js 2>&1 || echo "DELETED (expected)"
ls hooks/lib/rules-io.js && echo "EXISTS (expected)"
```

- [ ] **Step 3: Verify no stale imports remain**

```bash
grep -r "require.*engine" hooks/ server/ tests/ --include="*.js"
```

Expected: No results. All references point to `rules-io`.

- [ ] **Step 4: Smoke test the server manually**

```bash
node server/server.js --port 19799 &
sleep 2

# Health check
curl -s http://localhost:19799/health | jq .paused
# Expected: false

# Pause
curl -s -X POST http://localhost:19799/pause | jq .
# Expected: {"paused": true}

# Enforce while paused (should return {})
curl -s -X POST http://localhost:19799/enforce -H "Content-Type: application/json" -d '{"tool_input":{"file_path":"test.sql"}}' | jq .
# Expected: {}

# Resume
curl -s -X POST http://localhost:19799/resume | jq .
# Expected: {"paused": false}

kill %1
```

- [ ] **Step 5: Commit (if any fixups needed)**

Only if earlier tasks required adjustments discovered during verification.
