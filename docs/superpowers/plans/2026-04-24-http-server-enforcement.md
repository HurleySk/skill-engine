# Skill Engine v3.0.0 — HTTP Server-Based Rule Enforcement

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace process-spawning command hooks with a persistent HTTP server for ~30-50x faster rule activation and enforcement.

**Architecture:** A single-file Node.js HTTP server loads rules into memory at startup, pre-compiles regexes, and serves `/activate` and `/enforce` endpoints. HTTP hooks in plugin.json route Claude Code events to the server. A SessionStart command hook boots the server if not already running. Everything degrades gracefully — server down means hooks silently no-op.

**Tech Stack:** Node.js (built-in `http`, `fs`, `path` modules only — no external dependencies). Bash for lifecycle script. Node test runner (`node:test`) for tests.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `server/server.js` | HTTP server: load rules, compile regexes, handle /activate, /enforce, /health, /reload |
| Create | `hooks/start-server.sh` | Boot server if not running, check port, respect SKILL_ENGINE_OFF |
| Create | `skills/start/SKILL.md` | Start server or show status |
| Create | `skills/stop/SKILL.md` | Stop the server |
| Create | `skills/status/SKILL.md` | Show diagnostics |
| Create | `tests/server.test.js` | Tests for server endpoints and in-memory rule evaluation |
| Modify | `hooks/lib/engine.js:112-133` | Remove `fileMarkers` from `checkSkip()` |
| Modify | `tests/engine.test.js:215-229` | Remove/update `fileMarkers` tests |
| Modify | `tests/fixtures/valid-rules.json:25-26` | Remove `fileMarkers` from fixture |
| Modify | `.claude-plugin/plugin.json` | v3.0.0, updated description, hook declarations |
| Modify | `skills/learn/SKILL.md` | Remove learn-hook routing, update for v3 |
| Modify | `skills/learn-rule/SKILL.md` | Update description to reflect enforcement is back |
| Delete | `skills/learn-hook/` | Deprecated — hooks managed by plugin, not users |
| Delete | `skills/setup/` | Deprecated — plugin handles hook registration |
| Delete | `skills/rules/` | Deprecated — learn-rule covers this |
| Delete | `hooks/activate.sh` | Replaced by HTTP hook |
| Delete | `hooks/enforce.sh` | Replaced by HTTP hook |

---

### Task 1: Remove fileMarkers from engine.js and update tests

**Files:**
- Modify: `hooks/lib/engine.js:112-133`
- Modify: `tests/engine.test.js:215-229`
- Modify: `tests/fixtures/valid-rules.json:25-26`

- [ ] **Step 1: Update the checkSkip test to verify fileMarkers is ignored**

In `tests/engine.test.js`, replace the two `fileMarkers` tests with one test that confirms fileMarkers has no effect:

```javascript
it('checkSkip ignores fileMarkers (removed in v3)', () => {
  const skipFile = path.join(fixturesDir, 'sample-skip.sql');
  const rule = { skipConditions: { fileMarkers: ['-- @skip-sql-standards'] } };
  assert.equal(engine.checkSkip('sql-standards', rule, null, skipFile), false);
});
```

This replaces the existing tests at lines 215-228 ("checkSkip returns true when file contains marker" and "checkSkip returns false when file does not contain marker").

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/engine.test.js`
Expected: The new test FAILs because `checkSkip` still reads file markers and returns `true`.

- [ ] **Step 3: Remove fileMarkers logic from checkSkip in engine.js**

In `hooks/lib/engine.js`, remove lines 120-125 (the `fileMarkers` block):

```javascript
function checkSkip(ruleName, rule, sessionId, filePath) {
  const skip = rule.skipConditions;
  if (!skip) return false;

  if (skip.envVars && skip.envVars.length) {
    if (skip.envVars.some(v => process.env[v])) return true;
  }

  if (skip.sessionOnce && sessionId) {
    const state = readSessionState(sessionId);
    if (state.firedRules.includes(ruleName)) return true;
  }

  return false;
}
```

- [ ] **Step 4: Remove fileMarkers from test fixture**

In `tests/fixtures/valid-rules.json`, remove the `fileMarkers` key from the `sql-standards` rule's `skipConditions`:

```json
"skipConditions": {
  "envVars": ["SKIP_SQL_STANDARDS"],
  "sessionOnce": false
}
```

- [ ] **Step 5: Also update the enforce test that relied on fileMarkers**

In `tests/engine.test.js`, the test at line 355 ("enforce skips rule when file has skip marker") now expects the opposite behavior. Update it:

```javascript
it('enforce does not skip rule for file markers (removed in v3)', () => {
  const rulesData = engine.loadRules(path.join(fixturesDir, 'valid-rules.json'));
  const input = {
    tool_name: 'Edit',
    tool_input: { file_path: path.join(fixturesDir, 'sample-skip.sql') },
    session_id: 'enforce-test-4'
  };
  const result = engine.enforce(input, rulesData);
  assert.equal(result.exit, 2, 'file markers no longer skip — block should fire');
});
```

- [ ] **Step 6: Run all tests to verify everything passes**

Run: `node --test tests/engine.test.js`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add hooks/lib/engine.js tests/engine.test.js tests/fixtures/valid-rules.json
git commit -m "refactor: remove fileMarkers skip condition from engine (v3)"
```

---

### Task 2: Build the HTTP server

**Files:**
- Create: `server/server.js`
- Test: `tests/server.test.js`

- [ ] **Step 1: Write the server test file with health endpoint test**

Create `tests/server.test.js`:

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const SERVER_PATH = path.resolve(__dirname, '..', 'server', 'server.js');
const TEST_PORT = 19751;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path: urlPath,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {}
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, raw: data });
        } catch {
          resolve({ status: res.statusCode, body: null, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('Server Health', () => {
  let serverProcess;
  let tmpDir;
  let rulesDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-server-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'test-rule': {
          type: 'domain',
          description: 'Test rule',
          triggers: { prompt: { keywords: ['test-keyword'] } }
        }
      }
    }));

    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(TEST_PORT), '--rules-dir', rulesDir], {
      stdio: 'pipe',
      env: { ...process.env }
    });

    // Wait for server to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 5000);
      serverProcess.stdout.on('data', (data) => {
        if (data.toString().includes('listening')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      serverProcess.on('error', reject);
    });
  });

  after(() => {
    if (serverProcess) serverProcess.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /health returns server status', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.uptime, 'number');
    assert.equal(res.body.rulesLoaded, 1);
    assert.equal(typeof res.body.port, 'number');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/server.test.js`
Expected: FAIL — `server/server.js` does not exist.

- [ ] **Step 3: Create the server**

Create `server/server.js`:

```javascript
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// Resolve engine from repo layout
const enginePath = path.resolve(__dirname, '..', 'hooks', 'lib', 'engine.js');
const engine = require(enginePath);

// --- Config ---
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf('--' + name);
  return (idx !== -1 && args[idx + 1]) ? args[idx + 1] : defaultVal;
}

const PORT = parseInt(process.env.SKILL_ENGINE_PORT || getArg('port', '19750'), 10);
const RULES_DIR = getArg('rules-dir', '');
const KILL_SWITCH = process.env.SKILL_ENGINE_OFF === '1';

// --- In-memory state ---
let rulesData = null;
let compiledPromptRegexes = new Map();   // pattern string -> RegExp
let compiledGlobRegexes = new Map();     // glob string -> RegExp
const sessions = new Map();              // sessionId -> { firedRules: Set, lastSeen: Date }
const stats = { startedAt: new Date(), lastEvent: null, eventsProcessed: 0, rulesLoaded: 0 };

// --- Rule loading ---
function resolveRulesDir() {
  if (RULES_DIR) return RULES_DIR;
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const rulesFile = engine.findRulesFile(cwd);
  return rulesFile ? path.dirname(rulesFile) : null;
}

function loadAndCompileRules() {
  const dir = resolveRulesDir();
  if (!dir) {
    rulesData = { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {} };
    stats.rulesLoaded = 0;
    return;
  }

  const mainFile = path.join(dir, 'skill-rules.json');
  const learnedFile = path.join(dir, 'learned-rules.json');

  const mainData = engine.loadRules(mainFile);
  const learnedData = engine.loadRules(learnedFile);

  if (!mainData && !learnedData) {
    rulesData = { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {} };
    stats.rulesLoaded = 0;
    return;
  }

  rulesData = mainData || { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {} };
  if (learnedData) {
    rulesData.rules = { ...learnedData.rules, ...rulesData.rules };
  }

  // Pre-compile regexes
  compiledPromptRegexes = new Map();
  compiledGlobRegexes = new Map();

  for (const rule of Object.values(rulesData.rules)) {
    const intentPatterns = rule.triggers?.prompt?.intentPatterns;
    if (intentPatterns) {
      for (const pat of intentPatterns) {
        if (!compiledPromptRegexes.has(pat)) {
          try { compiledPromptRegexes.set(pat, new RegExp(pat, 'i')); } catch {}
        }
      }
    }
    const contentPatterns = rule.triggers?.file?.contentPatterns;
    if (contentPatterns) {
      for (const pat of contentPatterns) {
        if (!compiledPromptRegexes.has(pat)) {
          try { compiledPromptRegexes.set(pat, new RegExp(pat)); } catch {}
        }
      }
    }
    const pathPatterns = rule.triggers?.file?.pathPatterns;
    if (pathPatterns) {
      for (const pat of pathPatterns) {
        if (!compiledGlobRegexes.has(pat)) {
          compiledGlobRegexes.set(pat, engine.globToRegex(pat));
        }
      }
    }
    const pathExclusions = rule.triggers?.file?.pathExclusions;
    if (pathExclusions) {
      for (const pat of pathExclusions) {
        if (!compiledGlobRegexes.has(pat)) {
          compiledGlobRegexes.set(pat, engine.globToRegex(pat));
        }
      }
    }
  }

  stats.rulesLoaded = Object.keys(rulesData.rules).length;
}

// --- Session management (in-memory, replaces temp file I/O) ---
function getSession(sessionId) {
  if (!sessionId) return null;
  let session = sessions.get(sessionId);
  if (!session) {
    session = { firedRules: new Set(), lastSeen: Date.now() };
    sessions.set(sessionId, session);
  }
  session.lastSeen = Date.now();
  return session;
}

function checkSkipInMemory(ruleName, rule, session) {
  const skip = rule.skipConditions;
  if (!skip) return false;

  if (skip.envVars && skip.envVars.length) {
    if (skip.envVars.some(v => process.env[v])) return true;
  }

  if (skip.sessionOnce && session) {
    if (session.firedRules.has(ruleName)) return true;
  }

  return false;
}

// --- Matching (uses pre-compiled regexes where possible) ---
const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function matchPromptInMemory(prompt, rule) {
  const triggers = rule.triggers?.prompt;
  if (!triggers) return false;

  // Keywords
  if (triggers.keywords && triggers.keywords.length) {
    const lower = prompt.toLowerCase();
    if (triggers.keywords.some(kw => lower.includes(kw.toLowerCase()))) return true;
  }

  // Intent patterns (pre-compiled)
  if (triggers.intentPatterns && triggers.intentPatterns.length) {
    for (const pat of triggers.intentPatterns) {
      const re = compiledPromptRegexes.get(pat);
      if (re && re.test(prompt)) return true;
    }
  }

  return false;
}

function matchFileInMemory(filePath, rule) {
  const triggers = rule.triggers?.file;
  if (!triggers) return false;

  const normalized = engine.normalizePath(filePath);

  // Check exclusions
  if (triggers.pathExclusions && triggers.pathExclusions.length) {
    for (const pat of triggers.pathExclusions) {
      const re = compiledGlobRegexes.get(pat);
      if (re && re.test(normalized)) return false;
    }
  }

  // Check path patterns
  if (!triggers.pathPatterns || !triggers.pathPatterns.length) return false;
  let pathMatch = false;
  for (const pat of triggers.pathPatterns) {
    const re = compiledGlobRegexes.get(pat);
    if (re && re.test(normalized)) { pathMatch = true; break; }
  }
  if (!pathMatch) return false;

  // Content patterns (only for block, still reads file — the only I/O in hot path)
  const enforcement = rule.enforcement || rulesData.defaults?.enforcement || 'suggest';
  if (enforcement === 'block' && triggers.contentPatterns && triggers.contentPatterns.length) {
    return engine.matchContent(filePath, triggers.contentPatterns);
  }

  return true;
}

// --- Handlers ---
function handleActivate(input) {
  if (KILL_SWITCH) return { result: '' };
  const prompt = input?.prompt;
  const sessionId = input?.session_id;
  if (!prompt || !rulesData) return { result: '' };

  const session = getSession(sessionId);
  const matches = [];

  for (const [name, rule] of Object.entries(rulesData.rules)) {
    if (checkSkipInMemory(name, rule, session)) continue;
    if (!matchPromptInMemory(prompt, rule)) continue;
    const priority = rule.priority || rulesData.defaults?.priority || 'medium';
    const enforcement = rule.enforcement || rulesData.defaults?.enforcement || 'suggest';
    matches.push({ name, rule, priority, enforcement });
  }

  if (!matches.length) return { result: '' };

  matches.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));

  // Record sessionOnce
  if (session) {
    for (const m of matches) {
      if (m.rule.skipConditions?.sessionOnce) {
        session.firedRules.add(m.name);
      }
    }
  }

  const count = matches.length;
  const lines = ['\u26A1 Skill Engine \u2014 ' + count + ' relevant skill' + (count > 1 ? 's' : '') + ' detected:', ''];
  for (const m of matches) {
    const typeLabel = m.rule.type === 'guardrail' ? ' (guardrail)' : '';
    lines.push('[' + m.priority.toUpperCase() + '] ' + m.name + typeLabel);
    lines.push('  ' + m.rule.description);
    if (m.rule.skillPath) lines.push('  \u2192 Read: ' + m.rule.skillPath);
    lines.push('');
  }

  return { result: lines.join('\n') };
}

function handleEnforce(input) {
  if (KILL_SWITCH) return { decision: 'allow' };
  const filePath = input?.tool_input?.file_path;
  if (!filePath || !rulesData) return { decision: 'allow' };

  const sessionId = input?.session_id;
  const session = getSession(sessionId);
  const matches = [];

  for (const [name, rule] of Object.entries(rulesData.rules)) {
    if (rule.type !== 'guardrail') continue;
    const enforcement = rule.enforcement || rulesData.defaults?.enforcement || 'suggest';
    if (enforcement !== 'block' && enforcement !== 'warn') continue;
    if (checkSkipInMemory(name, rule, session)) continue;
    if (!matchFileInMemory(filePath, rule)) continue;
    const priority = rule.priority || rulesData.defaults?.priority || 'medium';
    matches.push({ name, rule, priority, enforcement });
  }

  if (!matches.length) return { decision: 'allow' };

  matches.sort((a, b) => {
    if (a.enforcement === 'block' && b.enforcement !== 'block') return -1;
    if (a.enforcement !== 'block' && b.enforcement === 'block') return 1;
    return (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2);
  });

  const blockMatch = matches.find(m => m.enforcement === 'block');
  if (blockMatch) {
    const reason = blockMatch.rule.blockMessage || ('Blocked by rule: ' + blockMatch.name);
    return { decision: 'block', reason };
  }

  const warnings = matches
    .filter(m => m.enforcement === 'warn')
    .map(m => '\u26A0\uFE0F ' + m.name + ': ' + m.rule.description)
    .join('\n');

  return { decision: 'allow', stderr: warnings || undefined };
}

function handleHealth() {
  return {
    uptime: (Date.now() - stats.startedAt.getTime()) / 1000,
    rulesLoaded: stats.rulesLoaded,
    port: PORT,
    lastEvent: stats.lastEvent,
    eventsProcessed: stats.eventsProcessed,
    activeSessions: sessions.size
  };
}

// --- HTTP server ---
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify(handleHealth()));
    return;
  }

  if (req.method === 'POST' && req.url === '/reload') {
    loadAndCompileRules();
    res.writeHead(200);
    res.end(JSON.stringify({ reloaded: true, rulesLoaded: stats.rulesLoaded }));
    return;
  }

  if (req.method === 'POST' && req.url === '/activate') {
    const input = await readBody(req);
    stats.eventsProcessed++;
    stats.lastEvent = new Date().toISOString();
    const result = handleActivate(input);
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'POST' && req.url === '/enforce') {
    const input = await readBody(req);
    stats.eventsProcessed++;
    stats.lastEvent = new Date().toISOString();
    const result = handleEnforce(input);
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// --- Session cleanup ---
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, session] of sessions) {
    if (session.lastSeen < cutoff) sessions.delete(id);
  }
}, 5 * 60 * 1000).unref();

// --- File watcher for hot-reload ---
function watchRules() {
  const dir = resolveRulesDir();
  if (!dir) return;
  for (const filename of ['skill-rules.json', 'learned-rules.json']) {
    const filePath = path.join(dir, filename);
    if (fs.existsSync(filePath)) {
      try {
        fs.watch(filePath, { persistent: false }, () => {
          loadAndCompileRules();
        });
      } catch {}
    }
  }
}

// --- Start ---
loadAndCompileRules();
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('skill-engine server listening on port ' + PORT + '\n');
  watchRules();
});
```

- [ ] **Step 4: Run the health test to verify it passes**

Run: `node --test tests/server.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/server.js tests/server.test.js
git commit -m "feat: add HTTP rule server with health endpoint"
```

---

### Task 3: Add activate and enforce endpoint tests

**Files:**
- Modify: `tests/server.test.js`

- [ ] **Step 1: Add activate endpoint tests**

Append to `tests/server.test.js`:

```javascript
describe('Server Activate', () => {
  let serverProcess;
  let tmpDir;
  let rulesDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-activate-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'test-rule': {
          type: 'domain',
          description: 'Test domain rule',
          skillPath: './test/SKILL.md',
          triggers: { prompt: { keywords: ['test-keyword'] } },
          skipConditions: { sessionOnce: true }
        },
        'high-rule': {
          type: 'domain',
          priority: 'high',
          description: 'High priority rule',
          triggers: { prompt: { keywords: ['high-keyword'] } }
        }
      }
    }));

    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', '19752', '--rules-dir', rulesDir], { stdio: 'pipe' });
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

  it('returns skill suggestions for matching prompt', async () => {
    const res = await request('POST', '/activate', { prompt: 'check the test-keyword', session_id: 'sess-1' });
    assert.equal(res.status, 200);
    assert.ok(res.body.result.includes('test-rule'));
    assert.ok(res.body.result.includes('Skill Engine'));
  });

  it('returns empty result for non-matching prompt', async () => {
    const res = await request('POST', '/activate', { prompt: 'something unrelated', session_id: 'sess-2' });
    assert.equal(res.status, 200);
    assert.equal(res.body.result, '');
  });

  it('respects sessionOnce — skips on second call', async () => {
    const body = { prompt: 'check the test-keyword', session_id: 'sess-once' };
    const first = await request('POST', '/activate', body);
    assert.ok(first.body.result.includes('test-rule'));
    const second = await request('POST', '/activate', body);
    assert.ok(!second.body.result.includes('test-rule'));
  });

  it('sorts by priority (high before medium)', async () => {
    const res = await request('POST', '/activate', { prompt: 'test-keyword high-keyword', session_id: 'sess-sort' });
    const highPos = res.body.result.indexOf('HIGH');
    const medPos = res.body.result.indexOf('MEDIUM');
    assert.ok(highPos < medPos, 'HIGH should appear before MEDIUM');
  });
});
```

Note: the `request` helper defined in Task 2 must be moved to module scope (above all `describe` blocks) so all test suites can use it. It was already written that way in Task 2.

For this test suite, update the port in the `request` calls. The simplest approach: make `request` accept a port parameter. Refactor the helper:

```javascript
function request(method, urlPath, body, port) {
  port = port || TEST_PORT;
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port,
      path: urlPath,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {}
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, raw: data });
        } catch {
          resolve({ status: res.statusCode, body: null, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
```

Use port `19752` for activate tests, `19753` for enforce tests.

- [ ] **Step 2: Add enforce endpoint tests**

Append to `tests/server.test.js`:

```javascript
describe('Server Enforce', () => {
  let serverProcess;
  let tmpDir;
  let rulesDir;
  let testSqlFile;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-enforce-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });

    testSqlFile = path.join(tmpDir, 'test.sql');
    fs.writeFileSync(testSqlFile, 'CREATE PROCEDURE [dbo].[Test]\nAS\nBEGIN\n  SELECT 1\nEND');

    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'block-sql': {
          type: 'guardrail',
          enforcement: 'block',
          priority: 'critical',
          description: 'Block SQL edits',
          blockMessage: 'SQL blocked',
          triggers: {
            file: {
              pathPatterns: ['**/*.sql'],
              contentPatterns: ['CREATE\\s+PROC']
            }
          }
        },
        'warn-config': {
          type: 'guardrail',
          enforcement: 'warn',
          priority: 'medium',
          description: 'Config warning',
          triggers: {
            file: { pathPatterns: ['**/*.config'] }
          }
        }
      }
    }));

    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', '19753', '--rules-dir', rulesDir], { stdio: 'pipe' });
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

  it('returns block for matching guardrail with content pattern', async () => {
    const res = await request('POST', '/enforce', {
      tool_name: 'Edit',
      tool_input: { file_path: testSqlFile },
      session_id: 'enf-1'
    }, 19753);
    assert.equal(res.status, 200);
    assert.equal(res.body.decision, 'block');
    assert.equal(res.body.reason, 'SQL blocked');
  });

  it('returns warn for matching warn guardrail', async () => {
    const configFile = path.join(tmpDir, 'app.config');
    fs.writeFileSync(configFile, '<config/>');
    const res = await request('POST', '/enforce', {
      tool_name: 'Edit',
      tool_input: { file_path: configFile },
      session_id: 'enf-2'
    }, 19753);
    assert.equal(res.status, 200);
    assert.equal(res.body.decision, 'allow');
    assert.ok(res.body.stderr.includes('warn-config'));
  });

  it('returns allow for non-matching file', async () => {
    const res = await request('POST', '/enforce', {
      tool_name: 'Edit',
      tool_input: { file_path: '/some/readme.md' },
      session_id: 'enf-3'
    }, 19753);
    assert.equal(res.status, 200);
    assert.equal(res.body.decision, 'allow');
    assert.equal(res.body.stderr, undefined);
  });

  it('returns allow when file_path is missing', async () => {
    const res = await request('POST', '/enforce', {
      tool_name: 'Edit',
      tool_input: {},
      session_id: 'enf-4'
    }, 19753);
    assert.equal(res.status, 200);
    assert.equal(res.body.decision, 'allow');
  });
});
```

- [ ] **Step 3: Run all server tests**

Run: `node --test tests/server.test.js`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/server.test.js
git commit -m "test: add activate and enforce endpoint tests for HTTP server"
```

---

### Task 4: Add reload endpoint test and KILL_SWITCH test

**Files:**
- Modify: `tests/server.test.js`

- [ ] **Step 1: Add reload and kill switch tests**

Append to `tests/server.test.js`:

```javascript
describe('Server Reload', () => {
  let serverProcess;
  let tmpDir;
  let rulesDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-reload-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
      version: '1.0', defaults: {}, rules: {
        'old-rule': { type: 'domain', description: 'Old', triggers: { prompt: { keywords: ['old'] } } }
      }
    }));

    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', '19754', '--rules-dir', rulesDir], { stdio: 'pipe' });
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

  it('POST /reload picks up new rules', async () => {
    // Verify old rule works
    const before = await request('POST', '/activate', { prompt: 'old keyword', session_id: 'r1' }, 19754);
    assert.ok(before.body.result.includes('old-rule'));

    // Write new rules
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
      version: '1.0', defaults: {}, rules: {
        'new-rule': { type: 'domain', description: 'New', triggers: { prompt: { keywords: ['new'] } } }
      }
    }));

    // Reload
    const reload = await request('POST', '/reload', {}, 19754);
    assert.equal(reload.body.reloaded, true);
    assert.equal(reload.body.rulesLoaded, 1);

    // Verify new rule works and old rule is gone
    const afterOld = await request('POST', '/activate', { prompt: 'old keyword', session_id: 'r2' }, 19754);
    assert.equal(afterOld.body.result, '');
    const afterNew = await request('POST', '/activate', { prompt: 'new keyword', session_id: 'r3' }, 19754);
    assert.ok(afterNew.body.result.includes('new-rule'));
  });
});

describe('Server Kill Switch', () => {
  let serverProcess;
  let tmpDir;
  let rulesDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-kill-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
      version: '1.0', defaults: {}, rules: {
        'block-rule': {
          type: 'guardrail', enforcement: 'block', description: 'Block all SQL',
          triggers: { file: { pathPatterns: ['**/*.sql'] } }
        }
      }
    }));

    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', '19755', '--rules-dir', rulesDir], {
      stdio: 'pipe',
      env: { ...process.env, SKILL_ENGINE_OFF: '1' }
    });
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

  it('activate returns empty when SKILL_ENGINE_OFF=1', async () => {
    const res = await request('POST', '/activate', { prompt: 'test keyword', session_id: 'k1' }, 19755);
    assert.equal(res.body.result, '');
  });

  it('enforce returns allow when SKILL_ENGINE_OFF=1', async () => {
    const res = await request('POST', '/enforce', {
      tool_name: 'Edit', tool_input: { file_path: '/any/file.sql' }, session_id: 'k2'
    }, 19755);
    assert.equal(res.body.decision, 'allow');
  });
});
```

- [ ] **Step 2: Run all server tests**

Run: `node --test tests/server.test.js`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/server.test.js
git commit -m "test: add reload and kill-switch tests for HTTP server"
```

---

### Task 5: Create start-server.sh lifecycle script

**Files:**
- Create: `hooks/start-server.sh`

- [ ] **Step 1: Write start-server.sh**

Create `hooks/start-server.sh`:

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
if curl -s --max-time 1 "http://localhost:$PORT/health" > /dev/null 2>&1; then
  exit 0
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
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x hooks/start-server.sh`

- [ ] **Step 3: Test manually**

Run: `bash hooks/start-server.sh && curl -s http://localhost:19750/health | node -e "process.stdin.resume(); process.stdin.on('data',d=>console.log(JSON.parse(d)))"`
Expected: Server starts and health check returns JSON with `rulesLoaded` and `uptime` fields.

- [ ] **Step 4: Stop the test server**

Run: `curl -s http://localhost:19750/health | node -e "process.stdin.resume(); process.stdin.on('data',d=>{const h=JSON.parse(d);console.log(h)})" && kill $(lsof -ti:19750) 2>/dev/null || true`

- [ ] **Step 5: Commit**

```bash
git add hooks/start-server.sh
git commit -m "feat: add start-server.sh lifecycle script"
```

---

### Task 6: Create lifecycle skills (start, stop, status)

**Files:**
- Create: `skills/start/SKILL.md`
- Create: `skills/stop/SKILL.md`
- Create: `skills/status/SKILL.md`

- [ ] **Step 1: Create start skill**

Create `skills/start/SKILL.md`:

```markdown
---
name: start
description: Start the skill-engine HTTP server or confirm it is already running. Shows server status.
---

# Skill Engine — Start

Start the rule enforcement server or check if it's already running.

## Steps

1. Check if the server is running:

```bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
```

2. **If the health check succeeds**, show the user the status:

> Skill Engine server is already running.
> - Port: {port}
> - Uptime: {uptime}s
> - Rules loaded: {rulesLoaded}
> - Events processed: {eventsProcessed}
> - Active sessions: {activeSessions}

3. **If the health check fails** (connection refused), start the server:

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
bash "$PLUGIN_DIR/hooks/start-server.sh"
```

Then re-check health and show status to confirm it started.

4. If the server still doesn't start after the script runs, tell the user:

> Server failed to start. Check that port ${SKILL_ENGINE_PORT:-19750} is free and Node.js is available.
```

- [ ] **Step 2: Create stop skill**

Create `skills/stop/SKILL.md`:

```markdown
---
name: stop
description: Stop the skill-engine HTTP server. Hooks will silently no-op until it is restarted.
---

# Skill Engine — Stop

Stop the rule enforcement server. After stopping, HTTP hooks will silently no-op — Claude Code is unaffected.

## Steps

1. Check if the server is running:

```bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
```

2. **If not running**, tell the user:

> Skill Engine server is not running. Nothing to stop.

3. **If running**, find and kill the process:

On macOS/Linux:
```bash
kill $(lsof -ti:${SKILL_ENGINE_PORT:-19750}) 2>/dev/null
```

On Windows (Git Bash):
```bash
netstat -ano | grep ":${SKILL_ENGINE_PORT:-19750} " | head -1 | awk '{print $5}' | xargs -r taskkill //F //PID
```

4. Verify it stopped:

```bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
```

If the health check fails (connection refused), confirm: "Skill Engine server stopped."
```

- [ ] **Step 3: Create status skill**

Create `skills/status/SKILL.md`:

```markdown
---
name: status
description: Show skill-engine server diagnostics — port, uptime, rules loaded, events processed, active sessions.
---

# Skill Engine — Status

Show the current state of the rule enforcement server.

## Steps

1. Check server health:

```bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
```

2. **If running**, display:

> **Skill Engine Server**
> - Status: Running
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
git add skills/start/SKILL.md skills/stop/SKILL.md skills/status/SKILL.md
git commit -m "feat: add start, stop, status lifecycle skills"
```

---

### Task 7: Update plugin.json to v3.0.0 with hook declarations

**Files:**
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Update plugin.json**

Replace the contents of `.claude-plugin/plugin.json` with:

```json
{
  "name": "skill-engine",
  "version": "3.0.0",
  "description": "Rule-based skill activation and guardrail enforcement for Claude Code. Uses a persistent HTTP server for near-zero latency on every tool call.",
  "author": {
    "name": "Samuel Hurley",
    "url": "https://github.com/HurleySk"
  },
  "license": "MIT",
  "homepage": "https://github.com/HurleySk/skill-engine",
  "repository": "https://github.com/HurleySk/skill-engine",
  "keywords": [
    "skills",
    "rules",
    "enforcement",
    "learn",
    "scaffold",
    "claude-code"
  ],
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/start-server.sh\"" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "http", "url": "http://localhost:19750/activate" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          { "type": "http", "url": "http://localhost:19750/enforce" }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Verify the JSON is valid**

Run: `node -e "console.log(JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8')).version)"`
Expected: `3.0.0`

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/plugin.json
git commit -m "feat: v3.0.0 — HTTP hooks for activation and enforcement"
```

---

### Task 8: Update learn skill and delete deprecated skills/scripts

**Files:**
- Modify: `skills/learn/SKILL.md`
- Modify: `skills/learn-rule/SKILL.md`
- Delete: `skills/learn-hook/`
- Delete: `skills/setup/`
- Delete: `skills/rules/`
- Delete: `hooks/activate.sh`
- Delete: `hooks/enforce.sh`

- [ ] **Step 1: Update learn/SKILL.md to remove learn-hook routing**

In `skills/learn/SKILL.md`, update the classification table and routing section. Remove the "hook" row and the hook routing option:

Replace the classification table:

```markdown
| Signal | Artifact | Route to |
|---|---|---|
| "warn/block/never/always when editing X files" | Enforcement rule | `/skill-engine:learn-rule` |
| "when doing X, follow these steps", multi-step process | Reusable skill | `/skill-engine:learn-skill` |
| "update/change that rule to also cover..." | Rule update | `/skill-engine:learn-rule update` |
| "make that learned rule permanent" | Rule promotion | `/skill-engine:learn-rule promote` |
```

Replace the routing section:

```markdown
### Step 3: Route

Once classified, tell the user what you're doing and follow the appropriate sub-skill:

- **Rule**: Follow `/skill-engine:learn-rule`
- **Skill**: Follow `/skill-engine:learn-skill`

Pass along the lesson context so the user doesn't have to re-explain.
```

- [ ] **Step 2: Update learn-rule/SKILL.md description**

In `skills/learn-rule/SKILL.md`, update the frontmatter description to reflect v3:

```yaml
---
name: learn-rule
description: Capture a lesson as an enforcement rule, update an existing rule's triggers, or promote a learned rule to permanent. Rules are enforced by the skill-engine HTTP server.
argument-hint: "[update <rule-name>|promote <rule-name>]"
---
```

- [ ] **Step 3: Delete deprecated skills and old hook scripts**

Run:
```bash
rm -rf skills/learn-hook skills/setup skills/rules
rm -f hooks/activate.sh hooks/enforce.sh
```

- [ ] **Step 4: Verify the remaining structure**

Run: `ls skills/`
Expected: `learn/  learn-rule/  learn-skill/  start/  status/  stop/`

Run: `ls hooks/`
Expected: `lib/  start-server.sh`

- [ ] **Step 5: Commit**

```bash
git add -A skills/ hooks/activate.sh hooks/enforce.sh
git commit -m "chore: remove deprecated skills and old hook scripts for v3"
```

---

### Task 9: Create performance validation subagent skill

**Files:**
- Create: `skills/perf-check/SKILL.md`

- [ ] **Step 1: Create the performance check skill**

Create `skills/perf-check/SKILL.md`:

```markdown
---
name: perf-check
description: Dispatch a Claude Code performance expert subagent to audit hooks, MCP servers, and plugin configuration for latency issues. Reusable across projects.
---

# Skill Engine — Performance Check

Dispatch a subagent that acts as a Claude Code performance expert. It audits the current project's hook configuration, MCP servers, and plugin setup for performance issues.

## When to Use

- After adding or modifying hooks
- When Claude Code feels sluggish
- Before publishing a plugin to the marketplace
- As a periodic health check on project configuration

## Steps

1. Dispatch an Agent subagent with `subagent_type: "general-purpose"` and the following prompt:

```
You are a Claude Code performance expert. Audit this project for performance issues.

## What to Check

### 1. Hook Configuration
Read .claude/settings.json and .claude/settings.local.json (if they exist) and any plugin.json files.
For each hook:
- What type is it? (command, http, mcp_tool, prompt, agent)
- What event does it fire on? (PreToolUse, PostToolUse, UserPromptSubmit, etc.)
- Does it have an `if` filter to limit when it fires?
- Estimate the per-event cost:
  - `command` hooks: ~200-500ms on Windows, ~50-200ms on macOS/Linux (process spawn)
  - `http` hooks: ~5-20ms (localhost), ~50-500ms (remote)
  - `mcp_tool` hooks: ~4-9ms (if MCP server is running)
  - `prompt` hooks: variable (LLM call)
  - `agent` hooks: variable (full agent invocation)

### 2. MCP Servers
Check for .mcp.json or MCP server declarations in settings.
For each MCP server:
- Does it use stdio or HTTP transport?
- How many tools does it expose? (each tool adds to context window consumption)
- Is it needed for every session, or could it be lazily loaded?

### 3. Hot Path Analysis
Identify hooks on PreToolUse and UserPromptSubmit — these fire most frequently.
Flag any command hooks on these events as high-impact.
Calculate estimated overhead per session:
  total = (prompt_count × per_prompt_hook_cost) + (tool_count × per_tool_hook_cost)
  Assume: ~10 prompts, ~100 tool calls for a moderate session.

### 4. Recommendations
For each issue found, recommend a specific fix:
- Replace command hooks with http hooks (if a server is available)
- Add `if` filters to limit when hooks fire
- Move expensive hooks from PreToolUse to PostToolUse if they don't need to block
- Consolidate multiple hooks on the same event
- Flag MCP servers that could be lazy-loaded

## Output Format

Report as:

**Performance Audit**

| Hook/Server | Event | Type | Est. Cost | Issue | Fix |
|---|---|---|---|---|---|

**Estimated Session Overhead:** X seconds (for 10 prompts + 100 tool calls)

**Recommendations:**
1. ...
2. ...
```

2. Present the subagent's findings to the user.
```

- [ ] **Step 2: Commit**

```bash
git add skills/perf-check/SKILL.md
git commit -m "feat: add perf-check skill for Claude Code performance auditing"
```

---

### Task 10: Run full test suite and verify

**Files:** (none — verification only)

- [ ] **Step 1: Run all existing engine tests**

Run: `node --test tests/engine.test.js`
Expected: All tests PASS (with updated fileMarkers behavior).

- [ ] **Step 2: Run all server tests**

Run: `node --test tests/server.test.js`
Expected: All tests PASS.

- [ ] **Step 3: Run learn.js tests**

Run: `node --test tests/learn.test.js`
Expected: All tests PASS (no changes to learn.js).

- [ ] **Step 4: Run remaining test files**

Run: `node --test tests/glob-match.test.js tests/skill-scaffold.test.js tests/hook-manager.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Verify plugin.json is valid and complete**

Run: `node -e "const p=JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8'));console.log(p.version,Object.keys(p.hooks).join(','))"`
Expected: `3.0.0 SessionStart,UserPromptSubmit,PreToolUse`

- [ ] **Step 6: Verify skill directory structure**

Run: `ls skills/`
Expected: `learn/  learn-rule/  learn-skill/  perf-check/  start/  status/  stop/`

- [ ] **Step 7: Commit any fixups if needed, then tag**

If all tests pass and structure is correct:

```bash
git add -A
git diff --cached --quiet || git commit -m "chore: final v3.0.0 cleanup"
```

Do NOT create the tag manually — the CI/CD workflow handles tagging and marketplace publication on push to master.

---

## Self-Review Checklist

- **Spec coverage:** All requirements from the design spec are covered:
  - Server with /activate, /enforce, /health, /reload endpoints (Task 2)
  - fileMarkers removal (Task 1)
  - HTTP hooks in plugin.json (Task 7)
  - Lifecycle management: start-server.sh (Task 5), start/stop/status skills (Task 6)
  - Kill switch via SKILL_ENGINE_OFF (Tasks 2, 4, 5)
  - Deprecated skill/script deletion (Task 8)
  - v3.0.0 version bump (Task 7)
  - CI/CD handles publication (Task 10, no workflow changes needed)
  - Performance expert subagent skill (Task 9)
- **Placeholder scan:** No TBDs, TODOs, or vague instructions. All code blocks are complete.
- **Type consistency:** `handleActivate` returns `{ result: string }`, `handleEnforce` returns `{ decision, reason?, stderr? }`, `handleHealth` returns stats object — consistent across server code and tests.
