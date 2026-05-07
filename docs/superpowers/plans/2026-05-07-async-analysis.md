# Async Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a worker-thread-based async analysis system that runs CPU-bound validation (cross-file checks, schema validation) off the main thread, delivering advisory findings via UserPromptSubmit.

**Architecture:** A singleton worker thread (`async-worker.js`) runs user-authored JS analyzer scripts. A manager module (`async-manager.js`) owns the worker lifecycle, job dispatch, and findings queue. The existing `server.js` integrates at two points: `handlePreTool()` posts jobs for matched async rules, and `handleActivate()` drains findings into the response.

**Tech Stack:** Node.js `worker_threads` (built-in), `crypto.randomUUID()` for job IDs. Zero new dependencies.

---

## File Structure

| File | Role |
|------|------|
| `server/async-worker.js` (create) | Worker script: message listener, analyzer loader, timeout, safety caps |
| `server/async-manager.js` (create) | Main-thread singleton: worker lifecycle, `postJob()`, `drainFindings()`, death handling |
| `server/server.js` (modify) | Integration: compile async rules, post jobs in `handlePreTool`, drain in `handleActivate`, `/health`, shutdown |
| `tests/async-manager.test.js` (create) | Unit tests for the manager module (singleton, death, degraded mode) |
| `tests/async-worker.test.js` (create) | Unit tests for the worker (analyzer loading, timeout, message protocol) |
| `tests/server.test.js` (modify) | Integration tests for async rules end-to-end through the server |
| `.claude-plugin/plugin.json` (modify) | Version bump to 4.0.0 |

---

### Task 1: Create the Async Worker (`server/async-worker.js`)

**Files:**
- Create: `server/async-worker.js`
- Test: `tests/async-worker.test.js`

- [ ] **Step 1: Write the failing test — worker processes a valid analyzer job**

Create `tests/async-worker.test.js`:

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WORKER_PATH = path.resolve(__dirname, '..', 'server', 'async-worker.js');

function spawnWorker() {
  return new Worker(WORKER_PATH);
}

function postAndWait(worker, message, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker response timeout')), timeoutMs);
    worker.once('message', (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    worker.postMessage(message);
  });
}

describe('Async Worker', () => {
  let tmpDir;
  let analyzersDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-test-'));
    analyzersDir = path.join(tmpDir, '.claude', 'skills', 'analyzers');
    fs.mkdirSync(analyzersDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs an analyzer and returns findings', async () => {
    const analyzerPath = path.join(analyzersDir, 'test-analyzer.js');
    fs.writeFileSync(analyzerPath, `
      module.exports.analyze = async function(context, config) {
        return [{ severity: 'warning', message: 'found issue in ' + context.filePath, relatedFiles: ['other.js'] }];
      };
    `);

    const worker = spawnWorker();
    try {
      const result = await postAndWait(worker, {
        id: 'job-1',
        sessionId: 'sess-1',
        projectRoot: tmpDir,
        analyzer: 'test-analyzer',
        config: {},
        context: { filePath: 'src/foo.js', content: 'hello', toolName: 'Edit', ruleName: 'test-rule' }
      });

      assert.equal(result.id, 'job-1');
      assert.equal(result.sessionId, 'sess-1');
      assert.equal(result.ruleName, 'test-rule');
      assert.equal(result.status, 'completed');
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].severity, 'warning');
      assert.ok(result.findings[0].message.includes('src/foo.js'));
      assert.equal(typeof result.durationMs, 'number');
    } finally {
      await worker.terminate();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/async-worker.test.js`
Expected: FAIL — `server/async-worker.js` does not exist

- [ ] **Step 3: Write the async worker**

Create `server/async-worker.js`:

```js
'use strict';

const { parentPort } = require('worker_threads');
const path = require('path');

const analyzerCache = new Map();
const MAX_JOB_TIMEOUT_MS = 10000;

function loadAnalyzer(projectRoot, analyzerName) {
  const key = projectRoot + '|' + analyzerName;
  if (analyzerCache.has(key)) return analyzerCache.get(key);

  const analyzerPath = path.join(projectRoot, '.claude', 'skills', 'analyzers', analyzerName + '.js');
  try {
    const mod = require(analyzerPath);
    if (typeof mod.analyze !== 'function') {
      analyzerCache.set(key, null);
      return null;
    }
    analyzerCache.set(key, mod.analyze);
    return mod.analyze;
  } catch {
    analyzerCache.set(key, null);
    return null;
  }
}

async function handleJob(msg) {
  const start = Date.now();
  const { id, sessionId, projectRoot, analyzer, config, context } = msg;
  const ruleName = context && context.ruleName;

  const analyzeFn = loadAnalyzer(projectRoot, analyzer);
  if (!analyzeFn) {
    return {
      id, sessionId, ruleName,
      status: 'error',
      findings: [],
      durationMs: Date.now() - start,
      error: 'Analyzer not found or missing analyze export: ' + analyzer
    };
  }

  try {
    const result = await Promise.race([
      Promise.resolve(analyzeFn(context, config || {})),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Analyzer timeout after ' + MAX_JOB_TIMEOUT_MS + 'ms')), MAX_JOB_TIMEOUT_MS)
      )
    ]);

    const findings = Array.isArray(result) ? result : [];
    return {
      id, sessionId, ruleName,
      status: 'completed',
      findings,
      durationMs: Date.now() - start
    };
  } catch (err) {
    return {
      id, sessionId, ruleName,
      status: 'error',
      findings: [],
      durationMs: Date.now() - start,
      error: err.message || String(err)
    };
  }
}

parentPort.on('message', (msg) => {
  handleJob(msg).then((result) => {
    parentPort.postMessage(result);
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/async-worker.test.js`
Expected: PASS

- [ ] **Step 5: Write additional worker tests — missing analyzer, timeout, error in analyzer**

Add to `tests/async-worker.test.js`:

```js
  it('returns error status when analyzer file does not exist', async () => {
    const worker = spawnWorker();
    try {
      const result = await postAndWait(worker, {
        id: 'job-missing',
        sessionId: 'sess-1',
        projectRoot: tmpDir,
        analyzer: 'nonexistent',
        config: {},
        context: { filePath: 'x.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });
      assert.equal(result.status, 'error');
      assert.ok(result.error.includes('not found'));
      assert.deepStrictEqual(result.findings, []);
    } finally {
      await worker.terminate();
    }
  });

  it('returns error status when analyzer throws', async () => {
    const analyzerPath = path.join(analyzersDir, 'throws.js');
    fs.writeFileSync(analyzerPath, `
      module.exports.analyze = function() { throw new Error('boom'); };
    `);

    const worker = spawnWorker();
    try {
      const result = await postAndWait(worker, {
        id: 'job-throw',
        sessionId: 'sess-1',
        projectRoot: tmpDir,
        analyzer: 'throws',
        config: {},
        context: { filePath: 'x.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });
      assert.equal(result.status, 'error');
      assert.ok(result.error.includes('boom'));
    } finally {
      await worker.terminate();
    }
  });

  it('times out if analyzer takes too long', async () => {
    const analyzerPath = path.join(analyzersDir, 'slow.js');
    fs.writeFileSync(analyzerPath, `
      module.exports.analyze = function() {
        return new Promise(resolve => setTimeout(() => resolve([]), 30000));
      };
    `);

    const worker = spawnWorker();
    try {
      const result = await postAndWait(worker, {
        id: 'job-slow',
        sessionId: 'sess-1',
        projectRoot: tmpDir,
        analyzer: 'slow',
        config: {},
        context: { filePath: 'x.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      }, 15000);
      assert.equal(result.status, 'error');
      assert.ok(result.error.includes('timeout'));
    } finally {
      await worker.terminate();
    }
  });

  it('handles sync analyze functions', async () => {
    const analyzerPath = path.join(analyzersDir, 'sync-analyzer.js');
    fs.writeFileSync(analyzerPath, `
      module.exports.analyze = function(context, config) {
        return [{ severity: 'info', message: 'sync result', relatedFiles: [] }];
      };
    `);

    const worker = spawnWorker();
    try {
      const result = await postAndWait(worker, {
        id: 'job-sync',
        sessionId: 'sess-1',
        projectRoot: tmpDir,
        analyzer: 'sync-analyzer',
        config: {},
        context: { filePath: 'x.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });
      assert.equal(result.status, 'completed');
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].message, 'sync result');
    } finally {
      await worker.terminate();
    }
  });

  it('passes config to the analyzer', async () => {
    const analyzerPath = path.join(analyzersDir, 'config-echo.js');
    fs.writeFileSync(analyzerPath, `
      module.exports.analyze = function(context, config) {
        return [{ severity: 'info', message: 'maxFiles=' + config.maxFiles, relatedFiles: [] }];
      };
    `);

    const worker = spawnWorker();
    try {
      const result = await postAndWait(worker, {
        id: 'job-cfg',
        sessionId: 'sess-1',
        projectRoot: tmpDir,
        analyzer: 'config-echo',
        config: { maxFiles: 42 },
        context: { filePath: 'x.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });
      assert.equal(result.status, 'completed');
      assert.ok(result.findings[0].message.includes('maxFiles=42'));
    } finally {
      await worker.terminate();
    }
  });
```

- [ ] **Step 6: Run all worker tests**

Run: `node --test tests/async-worker.test.js`
Expected: ALL PASS (the timeout test will take ~10s)

- [ ] **Step 7: Commit**

```bash
git add server/async-worker.js tests/async-worker.test.js
git commit -m "feat: async worker thread for analyzer script execution"
```

---

### Task 2: Create the Async Manager (`server/async-manager.js`)

**Files:**
- Create: `server/async-manager.js`
- Test: `tests/async-manager.test.js`

- [ ] **Step 1: Write the failing test — singleton worker and job posting**

Create `tests/async-manager.test.js`:

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// async-manager uses module-level state, so we test via require + reset
const managerPath = path.resolve(__dirname, '..', 'server', 'async-manager.js');

// Helper: fresh require (bust cache)
function freshRequire() {
  delete require.cache[managerPath];
  return require(managerPath);
}

describe('Async Manager', () => {
  let tmpDir;
  let analyzersDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-test-'));
    analyzersDir = path.join(tmpDir, '.claude', 'skills', 'analyzers');
    fs.mkdirSync(analyzersDir, { recursive: true });

    fs.writeFileSync(path.join(analyzersDir, 'simple.js'), `
      module.exports.analyze = function(context, config) {
        return [{ severity: 'warning', message: 'found it', relatedFiles: [] }];
      };
    `);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('postJob dispatches to worker and findings arrive in queue', async () => {
    const manager = freshRequire();
    try {
      manager.postJob({
        sessionId: 'sess-1',
        projectRoot: tmpDir,
        analyzer: 'simple',
        config: {},
        context: { filePath: 'a.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });

      // Wait for worker to process
      await new Promise(resolve => setTimeout(resolve, 1000));

      const findings = manager.drainFindings('sess-1');
      assert.equal(findings.length, 1);
      assert.equal(findings[0].message, 'found it');
    } finally {
      await manager.shutdown();
    }
  });

  it('drainFindings returns empty array and clears queue', async () => {
    const manager = freshRequire();
    try {
      manager.postJob({
        sessionId: 'sess-2',
        projectRoot: tmpDir,
        analyzer: 'simple',
        config: {},
        context: { filePath: 'a.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      const first = manager.drainFindings('sess-2');
      assert.equal(first.length, 1);

      const second = manager.drainFindings('sess-2');
      assert.equal(second.length, 0);
    } finally {
      await manager.shutdown();
    }
  });

  it('getStatus reports worker state', async () => {
    const manager = freshRequire();
    try {
      const status = manager.getStatus();
      assert.equal(typeof status.alive, 'boolean');
      assert.equal(typeof status.respawnCount, 'number');
      assert.equal(typeof status.jobsProcessed, 'number');
      assert.equal(status.degraded, false);
    } finally {
      await manager.shutdown();
    }
  });

  it('caps findings at MAX_FINDINGS_PER_SESSION', async () => {
    const manyPath = path.join(analyzersDir, 'many.js');
    fs.writeFileSync(manyPath, `
      module.exports.analyze = function() {
        const out = [];
        for (let i = 0; i < 25; i++) out.push({ severity: 'info', message: 'item-' + i, relatedFiles: [] });
        return out;
      };
    `);

    const manager = freshRequire();
    try {
      manager.postJob({
        sessionId: 'sess-cap',
        projectRoot: tmpDir,
        analyzer: 'many',
        config: {},
        context: { filePath: 'a.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      const findings = manager.drainFindings('sess-cap');
      assert.ok(findings.length <= 20, 'should cap at 20 findings, got ' + findings.length);
    } finally {
      await manager.shutdown();
    }
  });

  it('clearSession removes findings for a session', async () => {
    const manager = freshRequire();
    try {
      manager.postJob({
        sessionId: 'sess-clear',
        projectRoot: tmpDir,
        analyzer: 'simple',
        config: {},
        context: { filePath: 'a.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });

      await new Promise(resolve => setTimeout(resolve, 1000));
      manager.clearSession('sess-clear');

      const findings = manager.drainFindings('sess-clear');
      assert.equal(findings.length, 0);
    } finally {
      await manager.shutdown();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/async-manager.test.js`
Expected: FAIL — `server/async-manager.js` does not exist

- [ ] **Step 3: Write the async manager**

Create `server/async-manager.js`:

```js
'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const crypto = require('crypto');

const WORKER_PATH = path.resolve(__dirname, 'async-worker.js');
const MAX_FINDINGS_PER_SESSION = 20;
const MAX_RESPAWNS = 3;
const RESPAWN_WINDOW_MS = 5 * 60 * 1000;

let worker = null;
let degraded = false;
let respawnCount = 0;
let respawnTimestamps = [];
let jobsProcessed = 0;

const findingsQueue = new Map();

function ensureWorker() {
  if (degraded) return null;
  if (worker) return worker;

  worker = new Worker(WORKER_PATH);

  worker.on('message', (msg) => {
    jobsProcessed++;
    if (msg.status === 'error') return;
    if (!msg.findings || !msg.findings.length) return;

    let queue = findingsQueue.get(msg.sessionId);
    if (!queue) {
      queue = [];
      findingsQueue.set(msg.sessionId, queue);
    }

    for (const f of msg.findings) {
      if (queue.length >= MAX_FINDINGS_PER_SESSION) break;
      queue.push(f);
    }
  });

  worker.on('error', () => {});

  worker.on('exit', (code) => {
    worker = null;
    if (code !== 0) {
      const now = Date.now();
      respawnTimestamps.push(now);
      respawnTimestamps = respawnTimestamps.filter(t => now - t < RESPAWN_WINDOW_MS);
      respawnCount++;

      if (respawnTimestamps.length >= MAX_RESPAWNS) {
        degraded = true;
      }
    }
  });

  return worker;
}

function postJob({ sessionId, projectRoot, analyzer, config, context }) {
  const w = ensureWorker();
  if (!w) return;

  const id = crypto.randomUUID();
  w.postMessage({ id, sessionId, projectRoot, analyzer, config, context });
}

function drainFindings(sessionId) {
  const queue = findingsQueue.get(sessionId);
  if (!queue || !queue.length) return [];
  const drained = queue.splice(0);
  findingsQueue.delete(sessionId);
  return drained;
}

function clearSession(sessionId) {
  findingsQueue.delete(sessionId);
}

function getStatus() {
  return {
    alive: worker !== null,
    respawnCount,
    jobsProcessed,
    degraded,
  };
}

async function shutdown() {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
}

module.exports = { postJob, drainFindings, clearSession, getStatus, shutdown };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/async-manager.test.js`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add server/async-manager.js tests/async-manager.test.js
git commit -m "feat: async manager — singleton worker lifecycle and findings queue"
```

---

### Task 3: Integrate Async Rules into the Rule Compiler (`server/server.js`)

**Files:**
- Modify: `server/server.js:289-349` (compileRules function)
- Modify: `server/server.js:112-115` (snapshot in RuleCache.getRules)

- [ ] **Step 1: Write the failing integration test — async rules are compiled with hasAsyncRules flag**

Add to `tests/server.test.js` (use port 19777):

```js
describe('Async Rule Compilation', () => {
  let harness;
  const PORT = 19777;

  before(async () => {
    const analyzersDir = '.claude/skills/analyzers';
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'sync-rule': {
          type: 'guardrail',
          description: 'Normal sync rule',
          enforcement: 'block',
          triggers: { file: { pathPatterns: ['**/*.sql'] } }
        },
        'async-rule': {
          type: 'guardrail',
          description: 'Async cross-file check',
          async: { analyzer: 'test-analyzer', config: { maxFiles: 10 } },
          triggers: { file: { pathPatterns: ['**/*.js'] } }
        }
      }
    }, {
      extraFiles: {
        [analyzersDir + '/test-analyzer.js']: `
          module.exports.analyze = function(context, config) {
            return [{ severity: 'warning', message: 'async finding for ' + context.filePath, relatedFiles: [] }];
          };
        `
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('GET /health reports hasAsyncRules true when async rules exist', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hasAsyncRules, true);
  });

  it('async rules are excluded from sync enforcement', async () => {
    const jsFile = path.join(harness.tmpDir, 'test.js');
    fs.writeFileSync(jsFile, 'console.log("hello")');
    const res = await request('POST', '/enforce', { tool_input: { file_path: jsFile } }, PORT);
    assert.equal(res.status, 200);
    // async-rule should NOT produce a sync deny/ask/warn
    const hso = res.body.hookSpecificOutput;
    assert.ok(!hso || hso.permissionDecision !== 'deny', 'async rule should not produce sync deny');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server.test.js --test-name-pattern "Async Rule Compilation"`
Expected: FAIL — `hasAsyncRules` not in health response

- [ ] **Step 3: Modify compileRules to flag async rules and add hasAsyncRules to cache snapshot**

In `server/server.js`, in the `compileRules` function, add after the `contextBoost` block (around line 344):

```js
    if (rule.async && rule.async.analyzer) {
      entry.isAsync = true;
      entry.asyncAnalyzer = rule.async.analyzer;
      entry.asyncConfig = rule.async.config || {};
    }
```

In the `RuleCache.getRules` method, after the `hasStopRules` line (around line 115), add:

```js
    const hasAsyncRules = compiled.some(e => e.isAsync);
```

And add `hasAsyncRules` to the snapshot object:

```js
    const snapshot = Object.freeze({
      compiledRules: compiled,
      rulesData,
      hasToolTriggerRules,
      hasOutputTriggerRules,
      hasStopRules,
      hasAsyncRules,
    });
```

In `getRequestContext`, add `hasAsyncRules` to the empty-state return (around line 267):

```js
    return {
      projectRoot: null,
      rulesDir: null,
      compiledRules: [],
      rulesData: { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {} },
      hasToolTriggerRules: false,
      hasOutputTriggerRules: false,
      hasStopRules: false,
      hasAsyncRules: false,
    };
```

In the `/health` response object (around line 839), add:

```js
      hasAsyncRules: ctx.hasAsyncRules,
```

In the `handleEnforce` function (around line 688), add an exclusion for async rules. In the filter function, after the `if (entry.rule.type !== 'guardrail') return false;` check, add:

```js
    if (entry.isAsync) return false;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/server.test.js --test-name-pattern "Async Rule Compilation"`
Expected: PASS

- [ ] **Step 5: Run all existing tests to check for regressions**

Run: `node --test tests/server.test.js`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add server/server.js tests/server.test.js
git commit -m "feat: compile async rules with hasAsyncRules flag, exclude from sync enforcement"
```

---

### Task 4: Post Async Jobs from `handlePreTool` (`server/server.js`)

**Files:**
- Modify: `server/server.js:709-762` (handlePreTool function)
- Modify: `server/server.js` (require async-manager at top)

- [ ] **Step 1: Write the failing integration test — async rule triggers job and findings arrive**

Add to `tests/server.test.js` (use port 19778):

```js
describe('Async Job Dispatch via PreTool', () => {
  let harness;
  const PORT = 19778;

  before(async () => {
    const analyzersDir = '.claude/skills/analyzers';
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'async-check': {
          type: 'guardrail',
          description: 'Async cross-file check',
          async: { analyzer: 'cross-check', config: {} },
          triggers: { file: { pathPatterns: ['**/*.js'] } }
        }
      }
    }, {
      extraFiles: {
        [analyzersDir + '/cross-check.js']: `
          module.exports.analyze = function(context) {
            return [{ severity: 'warning', message: 'issue in ' + context.filePath, relatedFiles: ['other.js'] }];
          };
        `
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('pre-tool with matching async rule does not block (returns empty)', async () => {
    const jsFile = path.join(harness.tmpDir, 'app.js');
    fs.writeFileSync(jsFile, 'const x = 1;');
    const res = await request('POST', '/pre-tool', {
      tool_name: 'Edit',
      tool_input: { file_path: jsFile },
      session_id: 'async-sess-1'
    }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.ok(!hso || !hso.permissionDecision, 'async rule should not produce a permission decision');
  });

  it('findings appear in /activate after async job completes', async () => {
    const jsFile = path.join(harness.tmpDir, 'app.js');
    fs.writeFileSync(jsFile, 'const x = 1;');

    // Trigger async job via pre-tool
    await request('POST', '/pre-tool', {
      tool_name: 'Edit',
      tool_input: { file_path: jsFile },
      session_id: 'async-sess-2'
    }, PORT);

    // Wait for worker to process
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Activate should include findings
    const res = await request('POST', '/activate', {
      prompt: 'what next',
      session_id: 'async-sess-2'
    }, PORT);
    assert.equal(res.status, 200);
    const ctx = res.body.hookSpecificOutput && res.body.hookSpecificOutput.additionalContext;
    assert.ok(ctx, 'should have additionalContext');
    assert.ok(ctx.includes('Async Analysis'), 'should contain async analysis header');
    assert.ok(ctx.includes('issue in'), 'should contain finding message');
  });

  it('findings are consumed on drain — second activate has no findings', async () => {
    // Second activate for same session should have nothing
    const res = await request('POST', '/activate', {
      prompt: 'anything else',
      session_id: 'async-sess-2'
    }, PORT);
    assert.equal(res.status, 200);
    const ctx = res.body.hookSpecificOutput && res.body.hookSpecificOutput.additionalContext;
    assert.ok(!ctx || !ctx.includes('Async Analysis'), 'should not have async findings on second drain');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server.test.js --test-name-pattern "Async Job Dispatch"`
Expected: FAIL — no async job posting logic exists

- [ ] **Step 3: Require async-manager in server.js and add job posting to handlePreTool**

At the top of `server/server.js`, after the existing require statements (around line 11), add:

```js
const asyncManager = require('./async-manager');
```

In `handlePreTool` (around line 710), after the sync results are computed but before the return logic, add async job dispatching. The modified function:

```js
function handlePreTool(input) {
  const results = [
    handleEnforce(input),
    handleEnforceTool(input),
    handlePreWrite(input),
  ];

  // Dispatch async jobs for matching async rules
  if (!paused && process.env.SKILL_ENGINE_OFF !== '1') {
    const ctx = getRequestContext(input);
    if (ctx.hasAsyncRules && input && input.tool_input && input.tool_input.file_path) {
      const filePath = input.tool_input.file_path;
      const content = input.tool_input.content || input.tool_input.new_string || '';
      const session = getSession(input.session_id, ctx.projectRoot);

      for (const entry of ctx.compiledRules) {
        if (!entry.isAsync) continue;
        if (!ruleMatchesProject(entry, ctx.projectRoot)) continue;
        if (checkSkip(entry.name, entry.rule, session)) continue;
        if (!matchFileCompiled(filePath, entry, ctx.projectRoot, ctx.rulesData)) continue;

        asyncManager.postJob({
          sessionId: input.session_id || 'unknown',
          projectRoot: ctx.projectRoot,
          analyzer: entry.asyncAnalyzer,
          config: entry.asyncConfig,
          context: {
            filePath,
            content,
            toolName: input.tool_name || '',
            ruleName: entry.name,
          }
        });
      }
    }
  }

  let deny = null;
  let ask = null;
  const contexts = [];

  for (const r of results) {
    const hso = r && r.hookSpecificOutput;
    if (!hso) continue;
    const decision = hso.permissionDecision;
    if (decision === 'deny' && !deny) {
      deny = r;
    } else if (decision === 'ask' && !ask) {
      ask = r;
    }
    if (hso.additionalContext) {
      contexts.push(hso.additionalContext);
    }
  }

  if (deny) {
    const out = { ...deny.hookSpecificOutput };
    if (contexts.length) out.additionalContext = contexts.join('\n');
    return { hookSpecificOutput: out };
  }

  if (ask) {
    const out = { ...ask.hookSpecificOutput };
    if (contexts.length) out.additionalContext = contexts.join('\n');
    return { hookSpecificOutput: out };
  }

  if (contexts.length) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: contexts.join('\n'),
      }
    };
  }

  return {};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/server.test.js --test-name-pattern "Async Job Dispatch"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/server.js
git commit -m "feat: dispatch async jobs from handlePreTool for matching async rules"
```

---

### Task 5: Drain Findings in `handleActivate` (`server/server.js`)

**Files:**
- Modify: `server/server.js:511-580` (handleActivate function)

- [ ] **Step 1: The integration test from Task 4 already covers this path**

The test `'findings appear in /activate after async job completes'` validates that `handleActivate` drains findings. We need to add the drain logic now.

- [ ] **Step 2: Modify handleActivate to drain async findings**

In `handleActivate`, at the end (just before the final `return` statement at line 579), add findings drain logic. Replace the final return block:

```js
  // Drain async findings for this session
  const asyncFindings = input.session_id ? asyncManager.drainFindings(input.session_id) : [];

  if (asyncFindings.length) {
    lines.push('───────────────────────────────');
    lines.push('⚠️ Async Analysis Results (' + asyncFindings.length + ' finding' + (asyncFindings.length > 1 ? 's' : '') + '):');
    lines.push('');
    for (const f of asyncFindings) {
      const prefix = f.severity === 'warning' ? '⚠️' : 'ℹ️';
      lines.push(prefix + ' ' + f.message);
      if (f.relatedFiles && f.relatedFiles.length) {
        lines.push('  Related: ' + f.relatedFiles.join(', '));
      }
    }
    lines.push('');
  }

  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lines.join('\n') } };
```

Also add a check for async findings when no sync matches exist. Before the `if (!matches.length) return {};` line (around line 524), add:

```js
  if (!matches.length) {
    const asyncFindings = input && input.session_id ? asyncManager.drainFindings(input.session_id) : [];
    if (!asyncFindings.length) return {};
    const lines = [];
    lines.push('───────────────────────────────');
    lines.push('⚠️ Async Analysis Results (' + asyncFindings.length + ' finding' + (asyncFindings.length > 1 ? 's' : '') + '):');
    lines.push('');
    for (const f of asyncFindings) {
      const prefix = f.severity === 'warning' ? '⚠️' : 'ℹ️';
      lines.push(prefix + ' ' + f.message);
      if (f.relatedFiles && f.relatedFiles.length) {
        lines.push('  Related: ' + f.relatedFiles.join(', '));
      }
    }
    lines.push('');
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lines.join('\n') } };
  }
```

- [ ] **Step 3: Run the full async dispatch test suite**

Run: `node --test tests/server.test.js --test-name-pattern "Async Job Dispatch"`
Expected: ALL PASS

- [ ] **Step 4: Write test for findings-only delivery (no sync matches)**

Add to the `Async Job Dispatch via PreTool` describe block in `tests/server.test.js`:

```js
  it('delivers findings even when no sync rules match the prompt', async () => {
    const jsFile = path.join(harness.tmpDir, 'solo.js');
    fs.writeFileSync(jsFile, 'const y = 2;');

    await request('POST', '/pre-tool', {
      tool_name: 'Edit',
      tool_input: { file_path: jsFile },
      session_id: 'async-sess-solo'
    }, PORT);

    await new Promise(resolve => setTimeout(resolve, 1500));

    // Prompt that matches no sync rules
    const res = await request('POST', '/activate', {
      prompt: 'completely unrelated prompt',
      session_id: 'async-sess-solo'
    }, PORT);
    assert.equal(res.status, 200);
    const ctx = res.body.hookSpecificOutput && res.body.hookSpecificOutput.additionalContext;
    assert.ok(ctx, 'should have additionalContext from async findings alone');
    assert.ok(ctx.includes('Async Analysis'), 'should contain async header');
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/server.test.js --test-name-pattern "Async Job Dispatch"`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add server/server.js tests/server.test.js
git commit -m "feat: drain async findings in handleActivate with findings-only delivery"
```

---

### Task 6: Health Endpoint and Shutdown Integration (`server/server.js`)

**Files:**
- Modify: `server/server.js:825-846` (/health response)
- Modify: `server/server.js:975-978` (shutdown function)

- [ ] **Step 1: Write the failing test — /health includes asyncWorker status**

Add to the `Async Rule Compilation` describe block in `tests/server.test.js` (port 19777):

```js
  it('GET /health includes asyncWorker status', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.status, 200);
    const aw = res.body.asyncWorker;
    assert.ok(aw, 'should have asyncWorker field');
    assert.equal(typeof aw.alive, 'boolean');
    assert.equal(typeof aw.respawnCount, 'number');
    assert.equal(typeof aw.jobsProcessed, 'number');
    assert.equal(aw.degraded, false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server.test.js --test-name-pattern "asyncWorker status"`
Expected: FAIL — no `asyncWorker` field in response

- [ ] **Step 3: Add asyncWorker to /health and terminate worker on shutdown**

In the `/health` response object (around line 825), add after `deprecatedSetProjectCalls`:

```js
      asyncWorker: asyncManager.getStatus(),
```

In the `shutdown` function (around line 975), add worker termination:

```js
function shutdown() {
  clearInterval(cleanupInterval);
  asyncManager.shutdown();
  server.close();
}
```

Also add session cleanup for async findings. In `cleanStaleSessions` (around line 366), add after the `sessionChecklists` cleanup:

```js
  for (const [id] of findingsQueue) {
    // not accessible here — use asyncManager.clearSession
  }
```

Actually, since `findingsQueue` is internal to `async-manager.js`, add a call in `cleanStaleSessions` for each removed session. Replace the sessionChecklists cleanup block to also clear async findings:

In `cleanStaleSessions`, after the `sessionChecklists` loop, add:

```js
  for (const [id] of sessionRegistry) {
    // already handled above
  }
```

Wait — simpler approach. Just clear async findings for dead sessions by checking the session registry. Add to `cleanStaleSessions`, after the existing loops:

```js
  asyncManager.clearStaleSessions(sessionRegistry);
```

And add a `clearStaleSessions` export to `async-manager.js`:

```js
function clearStaleSessions(activeRegistry) {
  for (const sessionId of findingsQueue.keys()) {
    if (!activeRegistry.has(sessionId)) {
      findingsQueue.delete(sessionId);
    }
  }
}
```

Add `clearStaleSessions` to the module.exports in `async-manager.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/server.test.js --test-name-pattern "asyncWorker status"`
Expected: PASS

- [ ] **Step 5: Run all tests for regressions**

Run: `node --test tests/server.test.js`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add server/server.js server/async-manager.js tests/server.test.js
git commit -m "feat: asyncWorker in /health, worker shutdown, stale session cleanup"
```

---

### Task 7: Exclude Async Rules from Tool Trigger Enforcement (`server/server.js`)

**Files:**
- Modify: `server/server.js:582-604` (handleEnforceTool function)

- [ ] **Step 1: Write the failing test — async rule with tool trigger does not block**

Add to `tests/server.test.js` (use port 19779):

```js
describe('Async Rules Excluded from Sync Enforcement', () => {
  let harness;
  const PORT = 19779;

  before(async () => {
    const analyzersDir = '.claude/skills/analyzers';
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'async-tool-rule': {
          type: 'guardrail',
          description: 'Async tool-triggered check',
          enforcement: 'block',
          async: { analyzer: 'tool-check', config: {} },
          triggers: {
            tool: { toolNames: ['Bash'], inputPatterns: ['rm -rf'] }
          }
        }
      }
    }, {
      extraFiles: {
        [analyzersDir + '/tool-check.js']: `
          module.exports.analyze = function() {
            return [{ severity: 'warning', message: 'dangerous command', relatedFiles: [] }];
          };
        `
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('async rule with tool trigger does not produce sync block', async () => {
    const res = await request('POST', '/enforce-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/test' },
      session_id: 'async-excl-1'
    }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.ok(!hso || hso.permissionDecision !== 'deny', 'async rule should not produce sync deny');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server.test.js --test-name-pattern "Async Rules Excluded"`
Expected: FAIL — the async rule has `enforcement: 'block'` and tool triggers, so it fires synchronously

- [ ] **Step 3: Add isAsync exclusion to handleEnforceTool**

In `handleEnforceTool` (around line 595), add after the `if (entry.rule.type !== 'guardrail') return false;` line:

```js
    if (entry.isAsync) return false;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/server.test.js --test-name-pattern "Async Rules Excluded"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/server.js tests/server.test.js
git commit -m "fix: exclude async rules from sync tool trigger enforcement"
```

---

### Task 8: Version Bump and Release (`plugin.json`)

**Files:**
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Run all tests one final time**

Run: `node --test tests/*.test.js`
Expected: ALL PASS

- [ ] **Step 2: Bump version to 4.0.0**

In `.claude-plugin/plugin.json`, change:

```json
"version": "3.4.1",
```

to:

```json
"version": "4.0.0",
```

- [ ] **Step 3: Commit with [release] tag**

```bash
git add .claude-plugin/plugin.json
git commit -m "feat: async analysis system with worker threads and analyzer scripts [release]"
```

- [ ] **Step 4: Push to master**

```bash
git push origin master
```

This triggers the CI workflow (`.github/workflows/version-bump.yml`) which will:
- See the `[release]` tag in the commit message
- The version is already set to 4.0.0 manually (CI normally bumps patch, but we've set it explicitly)
- Dispatch update to HurleySk/claude-plugins-marketplace

- [ ] **Step 5: Pull the CI commit**

```bash
git pull
```

- [ ] **Step 6: Verify marketplace update**

Check that the marketplace received the v4.0.0 update. In a Claude Code session, run `/refresh:refresh` then `/skill-engine:start` to restart the server on the new version.
