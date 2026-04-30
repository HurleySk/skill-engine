# Session-Keyed Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace global `lastProjectDir` with session-scoped project isolation, multi-key rule cache, simplified startup, and PostToolUse matcher fix.

**Architecture:** Session registry (`Map<sessionId, projectInfo>`) replaces global state. Multi-key `RuleCache` keyed by `rulesDir` with LRU eviction. Self-upgrade logic deleted. `/register-session` replaces `/set-project`. PostToolUse matcher expanded to include read-only tools.

**Tech Stack:** Node.js built-in modules only (http, fs, path, crypto). Tests use `node:test`. No dependencies.

**Spec:** `docs/superpowers/specs/2026-04-30-session-keyed-isolation-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `server/server.js` | Modify | SessionRegistry, multi-key RuleCache, remove self-upgrade, `/register-session`, updated `/health`, updated `/rules`, deprecated `/set-project` |
| `hooks/start-server.sh` | Modify | Simplified lifecycle, `register_session()`, remove semver logic |
| `.claude-plugin/plugin.json` | Modify | PostToolUse matcher: add Read\|Grep\|Glob |

| `tests/server.test.js` | Modify | New test suites for session registry, multi-key cache, LRU, PostToolUse on Read |
| `CLAUDE.md` | Modify | Updated architecture, endpoint list, performance notes |

---

### Task 1: Multi-Key RuleCache

Replace the single-slot `RuleCache` class with a multi-key cache keyed by `rulesDir`. This is the foundation — later tasks depend on it.

**Files:**
- Modify: `server/server.js:93-193` (RuleCache class)
- Test: `tests/server.test.js` (new describe block)

- [ ] **Step 1: Write failing test — multi-key cache serves two projects independently**

Add a new describe block at the end of `tests/server.test.js`:

```javascript
describe('Multi-Key RuleCache', () => {
  let harness;
  let tmpDirB;
  const PORT = 19754;

  before(async () => {
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'se-cache-b-'));
    const rulesDirB = path.join(tmpDirB, '.claude', 'skills');
    fs.mkdirSync(rulesDirB, { recursive: true });
    fs.writeFileSync(path.join(rulesDirB, 'skill-rules.json'), JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'rule-b': { type: 'domain', description: 'Rule B', triggers: { prompt: { keywords: ['beta-cache'] } } } }
    }));

    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'rule-a': { type: 'domain', description: 'Rule A', triggers: { prompt: { keywords: ['alpha-cache'] } } } }
    });
  });

  after(() => { stopTestServer(harness, [tmpDirB]); });

  it('caches rules for two projects simultaneously without thrashing', async () => {
    // Hit project A
    const resA1 = await request('POST', '/activate', {
      prompt: 'alpha-cache keyword',
      env: { CLAUDE_PROJECT_DIR: harness.tmpDir }
    }, PORT);
    assert.ok(resA1.body.hookSpecificOutput.additionalContext.includes('rule-a'));

    // Hit project B — should NOT evict A
    const resB = await request('POST', '/activate', {
      prompt: 'beta-cache keyword',
      env: { CLAUDE_PROJECT_DIR: tmpDirB }
    }, PORT);
    assert.ok(resB.body.hookSpecificOutput.additionalContext.includes('rule-b'));

    // Hit project A again — should still be cached (not recompiled)
    const resA2 = await request('POST', '/activate', {
      prompt: 'alpha-cache keyword',
      env: { CLAUDE_PROJECT_DIR: harness.tmpDir }
    }, PORT);
    assert.ok(resA2.body.hookSpecificOutput.additionalContext.includes('rule-a'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server.test.js --test-name-pattern "Multi-Key RuleCache"`

Expected: PASS (the existing single-slot cache happens to work for this case because `env.CLAUDE_PROJECT_DIR` triggers `getRequestContext` to derive the correct `rulesDir` per-request, and the cache will recompile on each switch). This test establishes the baseline — later tests for LRU and `/health` cache detail will expose the single-slot limitation.

- [ ] **Step 3: Rewrite RuleCache class to multi-key**

Replace the `RuleCache` class in `server/server.js` (lines 93-193) with:

```javascript
const MAX_CACHE_ENTRIES = 10;

class RuleCache {
  constructor() {
    this._entries = new Map();
  }

  _getMtime(filePath) {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
  }

  getCachedState() {
    const projects = {};
    for (const [rulesDir, entry] of this._entries) {
      projects[rulesDir] = {
        rulesLoaded: entry.compiledRules.length,
        hasToolTriggerRules: entry.hasToolTriggerRules,
        hasOutputTriggerRules: entry.hasOutputTriggerRules,
        hasStopRules: entry.hasStopRules,
      };
    }
    return {
      entries: this._entries.size,
      maxEntries: MAX_CACHE_ENTRIES,
      projects,
    };
  }

  getRules(rulesDir) {
    if (!rulesDir) {
      return {
        compiledRules: [],
        rulesData: { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {} },
        hasToolTriggerRules: false,
        hasOutputTriggerRules: false,
        hasStopRules: false,
      };
    }
    const mainFile = path.join(rulesDir, 'skill-rules.json');
    const learnedFile = path.join(rulesDir, 'learned-rules.json');
    const mainMtime = this._getMtime(mainFile);
    const learnedMtime = this._getMtime(learnedFile);

    const existing = this._entries.get(rulesDir);
    if (existing && mainMtime === existing.mainMtime && learnedMtime === existing.learnedMtime) {
      existing.lastAccess = Date.now();
      return existing.snapshot;
    }

    // Recompile
    const mainData = loadRules(mainFile);
    const learnedData = loadRules(learnedFile);
    let rulesData;
    if (!mainData && !learnedData) {
      rulesData = { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {} };
    } else if (!mainData) {
      rulesData = { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: learnedData.rules };
    } else {
      rulesData = { ...mainData };
      if (learnedData) {
        rulesData.rules = { ...learnedData.rules, ...mainData.rules };
      }
    }

    const compiled = compileRules(rulesData);
    const hasToolTriggerRules = compiled.some(e => e.toolTriggerNamesSet || (e.inputRe && e.inputRe.length));
    const hasOutputTriggerRules = compiled.some(e => e.outputToolNamesSet || (e.outputRe && e.outputRe.length));
    const hasStopRules = compiled.some(e => e.hookEventsSet && e.hookEventsSet.has('Stop'));

    const snapshot = Object.freeze({
      compiledRules: compiled,
      rulesData,
      hasToolTriggerRules,
      hasOutputTriggerRules,
      hasStopRules,
    });

    // LRU eviction
    if (!existing && this._entries.size >= MAX_CACHE_ENTRIES) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [key, entry] of this._entries) {
        if (entry.lastAccess < oldestTime) {
          oldestTime = entry.lastAccess;
          oldestKey = key;
        }
      }
      if (oldestKey) this._entries.delete(oldestKey);
    }

    this._entries.set(rulesDir, {
      mainMtime,
      learnedMtime,
      lastAccess: Date.now(),
      snapshot,
      compiledRules: compiled,
      hasToolTriggerRules,
      hasOutputTriggerRules,
      hasStopRules,
    });

    return snapshot;
  }
}
```

- [ ] **Step 4: Run tests to verify nothing breaks**

Run: `node --test tests/server.test.js`

Expected: ALL existing tests pass. The multi-key cache is a superset of the single-slot behavior.

- [ ] **Step 5: Write failing test — LRU eviction**

Add to the `Multi-Key RuleCache` describe block:

```javascript
  it('evicts LRU entry when cache exceeds max size', async () => {
    // Register 11 projects by sending activate requests with different CLAUDE_PROJECT_DIR
    const dirs = [];
    for (let i = 0; i < 11; i++) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), `se-lru-${i}-`));
      const rd = path.join(d, '.claude', 'skills');
      fs.mkdirSync(rd, { recursive: true });
      fs.writeFileSync(path.join(rd, 'skill-rules.json'), JSON.stringify({
        version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' },
        rules: { [`rule-${i}`]: { type: 'domain', description: `Rule ${i}`, triggers: { prompt: { keywords: [`lru-${i}`] } } } }
      }));
      dirs.push(d);
      await request('POST', '/activate', { prompt: `lru-${i}`, env: { CLAUDE_PROJECT_DIR: d } }, PORT);
    }

    // Check /health — cache entries should be capped at 10
    const health = await request('GET', '/health', null, PORT);
    assert.ok(health.body.cache.entries <= 10, `cache entries should be <= 10, got ${health.body.cache.entries}`);

    // Cleanup
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
```

- [ ] **Step 6: Run test to verify it passes** (it should pass since we implemented LRU in Step 3)

Run: `node --test tests/server.test.js --test-name-pattern "evicts LRU"`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/server.js tests/server.test.js
git commit -m "feat: multi-key RuleCache with LRU eviction

Replace single-slot RuleCache with Map<rulesDir, compiled> keyed by
project. Immutable frozen snapshots. LRU eviction at 10 entries.
Eliminates cache thrashing on project switch."
```

---

### Task 2: Session Registry

Add the `SessionRegistry` and `/register-session` endpoint. This replaces `lastProjectDir` as the primary project identity mechanism.

**Files:**
- Modify: `server/server.js:198-230` (lastProjectDir, getRequestContext)
- Test: `tests/server.test.js` (new describe block)

- [ ] **Step 1: Write failing test — session registration and isolation**

Add a new describe block to `tests/server.test.js`:

```javascript
describe('Session Registry', () => {
  let harness;
  let tmpDirB;
  const PORT = 19768;

  before(async () => {
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'se-sess-reg-b-'));
    const rulesDirB = path.join(tmpDirB, '.claude', 'skills');
    fs.mkdirSync(rulesDirB, { recursive: true });
    fs.writeFileSync(path.join(rulesDirB, 'skill-rules.json'), JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'rule-b': { type: 'domain', description: 'Rule B', triggers: { prompt: { keywords: ['sess-beta'] } } } }
    }));

    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'rule-a': { type: 'domain', description: 'Rule A', triggers: { prompt: { keywords: ['sess-alpha'] } } } }
    });
  });

  after(() => { stopTestServer(harness, [tmpDirB]); });

  it('POST /register-session registers a session and returns confirmation', async () => {
    const res = await request('POST', '/register-session', {
      sessionId: 'test-sess-a',
      projectDir: harness.tmpDir
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.sessionId, 'test-sess-a');
    assert.equal(res.body.projectDir, harness.tmpDir);
    assert.ok(res.body.rulesDir);
    assert.equal(res.body.rulesLoaded, 1);
    assert.ok(Array.isArray(res.body.errors));
    assert.equal(res.body.errors.length, 0);
  });

  it('registered session resolves correct project rules via session_id', async () => {
    // Register session A
    await request('POST', '/register-session', {
      sessionId: 'iso-sess-a',
      projectDir: harness.tmpDir
    }, PORT);

    // Register session B
    await request('POST', '/register-session', {
      sessionId: 'iso-sess-b',
      projectDir: tmpDirB
    }, PORT);

    // Session A should get rule-a
    const resA = await request('POST', '/activate', {
      prompt: 'sess-alpha keyword',
      session_id: 'iso-sess-a'
    }, PORT);
    assert.ok(resA.body.hookSpecificOutput);
    assert.ok(resA.body.hookSpecificOutput.additionalContext.includes('rule-a'));

    // Session B should get rule-b
    const resB = await request('POST', '/activate', {
      prompt: 'sess-beta keyword',
      session_id: 'iso-sess-b'
    }, PORT);
    assert.ok(resB.body.hookSpecificOutput);
    assert.ok(resB.body.hookSpecificOutput.additionalContext.includes('rule-b'));

    // Session A should NOT get rule-b
    const resAnoB = await request('POST', '/activate', {
      prompt: 'sess-beta keyword',
      session_id: 'iso-sess-a'
    }, PORT);
    assert.ok(!resAnoB.body.hookSpecificOutput, 'session A should not see rule-b');
  });

  it('unregistered session_id falls back to most recently registered project', async () => {
    // Register a session to establish a fallback
    await request('POST', '/register-session', {
      sessionId: 'fallback-sess',
      projectDir: harness.tmpDir
    }, PORT);

    // Request with unknown session_id should fall back
    const res = await request('POST', '/activate', {
      prompt: 'sess-alpha keyword',
      session_id: 'unknown-sess-id'
    }, PORT);
    assert.ok(res.body.hookSpecificOutput);
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('rule-a'));
  });

  it('request with no session_id falls back to most recently registered project', async () => {
    await request('POST', '/register-session', {
      sessionId: 'no-sid-fallback',
      projectDir: harness.tmpDir
    }, PORT);

    const res = await request('POST', '/activate', {
      prompt: 'sess-alpha keyword'
    }, PORT);
    assert.ok(res.body.hookSpecificOutput);
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('rule-a'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server.test.js --test-name-pattern "Session Registry"`

Expected: FAIL — `/register-session` returns 200 `{}` (unknown POST route fail-open).

- [ ] **Step 3: Implement SessionRegistry and `/register-session` endpoint**

In `server/server.js`, replace the `lastProjectDir` global and `getRequestContext` function:

```javascript
// --- Session Registry (replaces lastProjectDir) ---
const sessionRegistry = new Map();
let lastRegisteredSessionId = null;
let deprecatedSetProjectCalls = 0;

function registerSession(sessionId, projectDir) {
  const normalizedDir = normalizePath(projectDir);
  const rulesDir = normalizedDir + '/.claude/skills';
  const errors = [];

  // Pre-warm the cache and check for load errors
  const cached = ruleCache.getRules(rulesDir);
  const mainFile = path.join(rulesDir, 'skill-rules.json');
  const learnedFile = path.join(rulesDir, 'learned-rules.json');
  if (!fs.existsSync(mainFile) && !fs.existsSync(learnedFile)) {
    errors.push('No skill-rules.json or learned-rules.json found in ' + rulesDir);
  }

  sessionRegistry.set(sessionId, {
    projectDir: normalizedDir,
    rulesDir,
    registeredAt: new Date().toISOString(),
    lastRequest: new Date().toISOString(),
  });
  lastRegisteredSessionId = sessionId;

  return {
    sessionId,
    projectDir: normalizedDir,
    rulesDir,
    rulesLoaded: cached.compiledRules.length,
    errors,
  };
}

// --- Per-request context helper ---
function getRequestContext(input) {
  let projectDir = null;

  // Priority 1: explicit env override (per-request, used by tests)
  if (input && input.env && input.env.CLAUDE_PROJECT_DIR) {
    projectDir = input.env.CLAUDE_PROJECT_DIR;
  }
  // Priority 2: session registry lookup
  else if (input && input.session_id && sessionRegistry.has(input.session_id)) {
    const entry = sessionRegistry.get(input.session_id);
    entry.lastRequest = new Date().toISOString();
    projectDir = entry.projectDir;
  }
  // Priority 3: fallback to most recently registered session
  else if (lastRegisteredSessionId && sessionRegistry.has(lastRegisteredSessionId)) {
    const entry = sessionRegistry.get(lastRegisteredSessionId);
    entry.lastRequest = new Date().toISOString();
    projectDir = entry.projectDir;
  }
  // Priority 4: process env (initial startup, no sessions registered yet)
  else if (process.env.CLAUDE_PROJECT_DIR) {
    projectDir = process.env.CLAUDE_PROJECT_DIR;
  }

  if (!projectDir) {
    return {
      projectRoot: null,
      rulesDir: null,
      compiledRules: [],
      rulesData: { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {} },
      hasToolTriggerRules: false,
      hasOutputTriggerRules: false,
      hasStopRules: false,
    };
  }

  const projectRoot = normalizePath(projectDir);
  const rulesDir = projectRoot + '/.claude/skills';
  const cached = ruleCache.getRules(rulesDir);
  return {
    projectRoot,
    rulesDir,
    ...cached,
  };
}
```

Delete the `let lastProjectDir = process.env.CLAUDE_PROJECT_DIR || null;` line (line 198).

Add the `/register-session` route in the request handler (after the `/set-project` block):

```javascript
  if (method === 'POST' && url === '/register-session') {
    let body = null;
    try { body = await readBody(req); } catch {}
    if (body && body.sessionId && body.projectDir) {
      const result = registerSession(body.sessionId, body.projectDir);
      return respond(res, 200, result);
    }
    return respond(res, 400, { error: 'sessionId and projectDir required' });
  }
```

Update the `/set-project` handler to use the registry as a deprecated fallback:

```javascript
  if (method === 'POST' && url === '/set-project') {
    let body = null;
    try { body = await readBody(req); } catch {}
    if (body && body.projectDir) {
      deprecatedSetProjectCalls++;
      const crypto = require('crypto');
      const syntheticId = crypto.createHash('md5').update(normalizePath(body.projectDir)).digest('hex').slice(0, 16);
      const result = registerSession(syntheticId, body.projectDir);
      return respond(res, 200, { projectDir: result.projectDir, rulesLoaded: result.rulesLoaded });
    }
    const ctx = getRequestContext(null);
    return respond(res, 200, { rulesLoaded: ctx.compiledRules.length });
  }
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `node --test tests/server.test.js`

Expected: ALL tests pass, including existing Cross-Project and new Session Registry tests.

- [ ] **Step 5: Commit**

```bash
git add server/server.js tests/server.test.js
git commit -m "feat: session registry replaces lastProjectDir

POST /register-session maps session_id → projectDir. Request context
resolves via session lookup, not global state. /set-project becomes a
deprecated fallback that creates a synthetic session entry."
```

---

### Task 3: Updated /health and /rules Endpoints

Update `/health` to show per-session project state and cache detail. Update `/rules` to accept session scoping.

**Files:**
- Modify: `server/server.js:609-646` (/health and /rules handlers)
- Test: `tests/server.test.js` (new tests)

- [ ] **Step 1: Write failing test — /health shows sessions and cache**

Add to the `Session Registry` describe block (or create a new one):

```javascript
describe('Health and Rules with Sessions', () => {
  let harness;
  const PORT = 19769;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'health-rule': { type: 'domain', description: 'Health rule', triggers: { prompt: { keywords: ['health-test'] } } } }
    });
    // Register a session
    await request('POST', '/register-session', {
      sessionId: 'health-sess',
      projectDir: harness.tmpDir
    }, PORT);
  });

  after(() => { stopTestServer(harness); });

  it('GET /health shows sessions map with project detail', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.sessions, 'should have sessions field');
    assert.ok(res.body.sessions['health-sess'], 'should have our registered session');
    const sess = res.body.sessions['health-sess'];
    assert.ok(sess.projectDir);
    assert.ok(sess.rulesDir);
    assert.equal(typeof sess.rulesLoaded, 'number');
    assert.ok(sess.registeredAt);
  });

  it('GET /health shows cache stats', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.cache, 'should have cache field');
    assert.equal(typeof res.body.cache.entries, 'number');
    assert.equal(res.body.cache.maxEntries, 10);
  });

  it('GET /rules?session=X returns rules for that session project', async () => {
    const res = await request('GET', '/rules?session=health-sess', null, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 1);
    assert.equal(res.body.rules[0].name, 'health-rule');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server.test.js --test-name-pattern "Health and Rules with Sessions"`

Expected: FAIL — `/health` doesn't have `sessions` or `cache` fields yet.

- [ ] **Step 3: Update /health handler**

Replace the `/health` handler in `server/server.js`:

```javascript
  if (method === 'GET' && url === '/health') {
    const cacheState = ruleCache.getCachedState();
    const avgMs = timedResponses > 0
      ? Number(totalResponseTimeNs / BigInt(timedResponses)) / 1e6
      : 0;

    const sessionsObj = {};
    for (const [sid, entry] of sessionRegistry) {
      const cached = ruleCache.getRules(entry.rulesDir);
      sessionsObj[sid] = {
        projectDir: entry.projectDir,
        rulesDir: entry.rulesDir,
        rulesLoaded: cached.compiledRules.length,
        registeredAt: entry.registeredAt,
        lastRequest: entry.lastRequest,
      };
    }

    return respond(res, 200, {
      version: SERVER_VERSION,
      pid: process.pid,
      uptime: process.uptime(),
      port: PORT,
      lastEvent,
      eventsProcessed,
      activeSessions: sessionRegistry.size,
      avgResponseTimeMs: Math.round(avgMs * 100) / 100,
      paused,
      sessions: sessionsObj,
      cache: {
        entries: cacheState.entries,
        maxEntries: cacheState.maxEntries,
      },
      deprecatedSetProjectCalls,
    });
  }
```

- [ ] **Step 4: Update /rules handler to support session scoping**

Replace the `/rules` handler:

```javascript
  if (method === 'GET' && (url === '/rules' || url.startsWith('/rules?'))) {
    const params = new URL(url, 'http://localhost').searchParams;
    const sessionFilter = params.get('session');

    if (sessionFilter && sessionRegistry.has(sessionFilter)) {
      const entry = sessionRegistry.get(sessionFilter);
      const cached = ruleCache.getRules(entry.rulesDir);
      const rules = cached.compiledRules.map(e => ({
        name: e.name,
        type: e.rule.type,
        enforcement: getEnforcement(e.rule, cached.rulesData.defaults),
        priority: getPriority(e.rule, cached.rulesData.defaults),
        description: e.rule.description,
        sourceRepo: e.sourceRepo || null,
        triggers: Object.keys(e.rule.triggers || {}),
        hookEvents: e.rule.hookEvents || null,
      }));
      return respond(res, 200, {
        session: sessionFilter,
        projectDir: entry.projectDir,
        rulesDir: entry.rulesDir,
        count: rules.length,
        rules,
      });
    }

    // Default: all rules across all cached projects
    const allRules = [];
    for (const [sid, entry] of sessionRegistry) {
      const cached = ruleCache.getRules(entry.rulesDir);
      for (const e of cached.compiledRules) {
        allRules.push({
          session: sid,
          projectDir: entry.projectDir,
          name: e.name,
          type: e.rule.type,
          enforcement: getEnforcement(e.rule, cached.rulesData.defaults),
          priority: getPriority(e.rule, cached.rulesData.defaults),
          description: e.rule.description,
          sourceRepo: e.sourceRepo || null,
          triggers: Object.keys(e.rule.triggers || {}),
          hookEvents: e.rule.hookEvents || null,
        });
      }
    }
    return respond(res, 200, { count: allRules.length, rules: allRules });
  }
```

- [ ] **Step 5: Run tests to verify all pass**

Run: `node --test tests/server.test.js`

Expected: ALL tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/server.js tests/server.test.js
git commit -m "feat: /health shows per-session state, /rules accepts session scoping

/health now includes sessions map with projectDir, rulesDir, rulesLoaded
per session. Cache stats (entries, maxEntries) exposed. /rules accepts
?session=X query param for filtered view."
```

---

### Task 4: Remove Self-Upgrade Logic

Delete the self-upgrade block from `server.js`. This eliminates the dual-version-manager race condition.

**Files:**
- Modify: `server/server.js:41-77` (self-upgrade block)
- Test: `tests/server.test.js` (existing tests should still pass)

- [ ] **Step 1: Delete the self-upgrade block**

In `server/server.js`, delete lines 41-77 — the entire `if (!process.env.SKILL_ENGINE_UPGRADED) { ... }` block.

The block starts with:
```javascript
// --- Self-upgrade: if a newer version exists in cache, re-exec into it ---
```

And ends with:
```javascript
  } catch {}
}
```

Delete all of it, including the comment.

- [ ] **Step 2: Run tests to verify nothing breaks**

Run: `node --test tests/server.test.js`

Expected: ALL tests pass. No test depends on self-upgrade behavior.

- [ ] **Step 3: Commit**

```bash
git add server/server.js
git commit -m "fix: remove self-upgrade logic from server.js

Eliminates the dual-version-manager race condition between server.js and
start-server.sh. The shell script is now the sole owner of version
decisions. Fixes version reversion bugs."
```

---

### Task 5: Session Cleanup Integration

Merge the session registry cleanup with the existing session (firedRules) cleanup. When a session expires from the registry, its firedRules should also be cleaned up.

**Files:**
- Modify: `server/server.js:289-311` (session tracking, cleanup)

- [ ] **Step 1: Write failing test — stale sessions are cleaned up**

Add to the `Session Registry` describe block or a new block:

```javascript
describe('Session Cleanup', () => {
  let harness;
  const PORT = 19770;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'cleanup-rule': { type: 'domain', description: 'Cleanup rule', triggers: { prompt: { keywords: ['cleanup-test'] } } } }
    });
  });

  after(() => { stopTestServer(harness); });

  it('GET /health shows registered session, then not after deregistration', async () => {
    await request('POST', '/register-session', {
      sessionId: 'ephemeral-sess',
      projectDir: harness.tmpDir
    }, PORT);

    const before = await request('GET', '/health', null, PORT);
    assert.ok(before.body.sessions['ephemeral-sess'], 'should show registered session');
    assert.ok(before.body.activeSessions >= 1);
  });
});
```

- [ ] **Step 2: Update session cleanup to include registry**

In `server/server.js`, update `cleanStaleSessions` to also clean the registry:

```javascript
function cleanStaleSessions() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) sessions.delete(id);
  }
  for (const [id, entry] of sessionRegistry) {
    const lastActive = new Date(entry.lastRequest).getTime();
    if (lastActive < cutoff) {
      sessionRegistry.delete(id);
      if (lastRegisteredSessionId === id) lastRegisteredSessionId = null;
    }
  }
}
```

- [ ] **Step 3: Run tests to verify all pass**

Run: `node --test tests/server.test.js`

Expected: ALL tests pass.

- [ ] **Step 4: Commit**

```bash
git add server/server.js tests/server.test.js
git commit -m "fix: session cleanup sweeps registry alongside firedRules

Stale session registry entries (30min) are removed in the same cleanup
interval. Prevents unbounded growth of session registry."
```

---

### Task 6: PostToolUse Matcher Fix (Issue #6)

Expand the PostToolUse matcher in `plugin.json` to include read-only tools.

**Files:**
- Modify: `.claude-plugin/plugin.json:71-80` (PostToolUse hook)
- Test: `tests/server.test.js` (new test)

- [ ] **Step 1: Write test — output trigger fires on Read tool**

Add a test to the existing `Post-Tool Endpoint` describe block or a new one:

```javascript
describe('PostToolUse on Read-Only Tools', () => {
  let harness;
  const PORT = 19771;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'detect-error-pattern': {
          type: 'domain',
          enforcement: 'suggest',
          priority: 'high',
          description: 'Detected error pattern in file',
          guidance: 'This file contains Entity Does Not Exist errors. Check ADF pipeline configuration.',
          triggers: {
            output: {
              toolNames: ['Read', 'Grep'],
              outputPatterns: ['Entity Does Not Exist']
            }
          }
        }
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('fires output trigger for Read tool output', async () => {
    const res = await request('POST', '/post-tool', {
      tool_name: 'Read',
      tool_output: 'Error: Entity Does Not Exist in pipeline xyz'
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.hookSpecificOutput);
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('Entity Does Not Exist errors'));
  });

  it('fires output trigger for Grep tool output', async () => {
    const res = await request('POST', '/post-tool', {
      tool_name: 'Grep',
      tool_output: 'file.csv:42: Entity Does Not Exist'
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.hookSpecificOutput);
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('Entity Does Not Exist errors'));
  });

  it('does not fire for non-matching tool', async () => {
    const res = await request('POST', '/post-tool', {
      tool_name: 'Bash',
      tool_output: 'Entity Does Not Exist'
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should not match Bash');
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (server-side `/post-tool` already handles any tool name — the restriction was only in plugin.json matchers, which don't affect the server tests)

Run: `node --test tests/server.test.js --test-name-pattern "PostToolUse on Read-Only"`

Expected: PASS — the server already processes any tool name in `/post-tool`. These tests verify the server-side behavior is correct.

- [ ] **Step 3: Update plugin.json PostToolUse matcher**

In `.claude-plugin/plugin.json`, change the PostToolUse matcher from:

```json
"matcher": "Write|Edit|Bash|PowerShell|NotebookEdit",
```

to:

```json
"matcher": "Read|Grep|Glob|Write|Edit|Bash|PowerShell|NotebookEdit",
```

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json tests/server.test.js
git commit -m "fix: PostToolUse matcher includes Read|Grep|Glob (#6)

Output trigger rules can now fire on read-only tools. The
hasOutputTriggerRules fast-path ensures zero overhead for projects
without output trigger rules."
```

---

### Task 7: Simplify start-server.sh

Rewrite the startup script to the simplified three-state lifecycle with `register_session()`.

**Files:**
- Modify: `hooks/start-server.sh` (full rewrite)

- [ ] **Step 1: Rewrite start-server.sh**

Replace the entire contents of `hooks/start-server.sh`:

```bash
#!/bin/bash
# Skill Engine — start the HTTP rule server if not already running.
# Called by SessionStart hook. Exits silently on any failure.

# Kill switch
if [ "$SKILL_ENGINE_OFF" = "1" ]; then
  exit 0
fi

PORT="${SKILL_ENGINE_PORT:-19750}"

_resolve_latest_plugin_dir() {
  local CACHE_BASE="$HOME/.claude/plugins/cache/hurleysk-marketplace/skill-engine"
  local LATEST
  LATEST=$(ls -d "$CACHE_BASE"/*/ 2>/dev/null | sort -V | tail -1)
  if [ -n "$LATEST" ]; then
    echo "${LATEST%/}"
  else
    echo "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  fi
}

# Cross-platform kill: POSIX kill doesn't work on Windows Node processes
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
  local SESSION_ID="${CLAUDE_SESSION_ID:-$(node -e "console.log(require('crypto').createHash('md5').update(process.argv[1]).digest('hex').slice(0,16))" "$CLAUDE_PROJECT_DIR" 2>/dev/null)}"
  local PAYLOAD
  PAYLOAD=$(node -e "console.log(JSON.stringify({sessionId:process.argv[1],projectDir:process.argv[2]}))" \
    "$SESSION_ID" "$CLAUDE_PROJECT_DIR" 2>/dev/null)
  local RESULT
  RESULT=$(curl -s --max-time 1 -X POST -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "http://localhost:$PORT/register-session" 2>/dev/null)
  # Check for registration errors
  local ERRORS
  ERRORS=$(echo "$RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const e=JSON.parse(d).errors||[];if(e.length)console.log(e.join('; '))}catch{}})" 2>/dev/null)
  if [ -n "$ERRORS" ]; then
    echo "skill-engine: warning — $ERRORS" >&2
  fi
}

PLUGIN_DIR="$(_resolve_latest_plugin_dir)"
CURRENT_VERSION=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(require('path').resolve(process.argv[1]),'utf8')).version||'')}catch{console.log('')}" "$PLUGIN_DIR/.claude-plugin/plugin.json" 2>/dev/null)

# Check if server is already running
HEALTH=$(curl -s --max-time 1 "http://localhost:$PORT/health" 2>/dev/null)
if [ -n "$HEALTH" ]; then
  RUNNING_VERSION=$(echo "$HEALTH" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).version||'')}catch{console.log('')}})" 2>/dev/null)

  if [ "$RUNNING_VERSION" = "$CURRENT_VERSION" ]; then
    register_session
    exit 0
  fi

  # Version differs — kill and restart
  OLD_PID=$(echo "$HEALTH" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).pid||'')}catch{console.log('')}})" 2>/dev/null)
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
```

- [ ] **Step 2: Verify the script is syntactically valid**

Run: `bash -n hooks/start-server.sh`

Expected: No output (no syntax errors).

- [ ] **Step 3: Commit**

```bash
git add hooks/start-server.sh
git commit -m "feat: simplified start-server.sh with register_session

Three states: not running → start; same version → register; different
version → kill and restart. Removed _semver_newer, fail-safe guards,
and _set_project. register_session posts to /register-session with
session_id and project dir. Reports registration errors to stderr."
```

---

### Task 8: Update CLAUDE.md

Update architecture documentation to reflect the new design.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

Replace the Architecture section's endpoint list to include `/register-session` and remove `/set-project`:

Change the `server/server.js` line from:
```
- `server/server.js` — HTTP server: `/health`, `/activate`, `/enforce`, `/enforce-tool`, `/post-tool`, `/pre-write`, `/stop`, `/set-project`, `/pause`, `/resume`
```
to:
```
- `server/server.js` — HTTP server: `/health`, `/activate`, `/enforce`, `/enforce-tool`, `/post-tool`, `/pre-write`, `/stop`, `/register-session`, `/pause`, `/resume` (`/set-project` deprecated)
```

Update the Cross-Repo Rule Scoping section from:
```
At enforcement time, each request derives its project root from `env.CLAUDE_PROJECT_DIR` (in the hook input) or `process.env.CLAUDE_PROJECT_DIR` (fallback).
```
to:
```
At enforcement time, each request derives its project root from its `session_id` (looked up in the session registry), `env.CLAUDE_PROJECT_DIR` (per-request override), or `process.env.CLAUDE_PROJECT_DIR` (startup fallback). Sessions are registered via `POST /register-session` called by the SessionStart hook.
```

Update the Performance section to add:
```
- PostToolUse hooks now fire on read-only tools (Read, Grep, Glob) for output trigger rules. The `hasOutputTriggerRules` fast-path returns empty immediately when no output triggers exist, limiting overhead to one HTTP round-trip (~2ms).
```

Update the port range in Development section from:
```
Server tests spawn real processes on ports 19751-19767.
```
to:
```
Server tests spawn real processes on ports 19751-19771.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update architecture for session registry, PostToolUse matcher"
```

---

### Task 9: Full Test Suite Verification

Run the complete test suite and verify everything passes.

**Files:**
- Test: `tests/*.test.js`

- [ ] **Step 1: Run the full test suite**

Run: `node --test tests/*.test.js`

Expected: ALL tests pass with no failures.

- [ ] **Step 2: Verify /health output manually**

Start a test server and check the new `/health` format:

```bash
CLAUDE_PROJECT_DIR=$(pwd) node server/server.js --port 19799 &
sleep 2
curl -s http://localhost:19799/health | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
curl -s -X POST -H "Content-Type: application/json" -d '{"sessionId":"manual-test","projectDir":"'$(pwd)'"}' http://localhost:19799/register-session
curl -s http://localhost:19799/health | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
kill %1
```

Expected: First `/health` shows empty sessions. After `/register-session`, shows the registered session with project detail.

- [ ] **Step 3: Final commit (if any test fixes needed)**

Only if adjustments were needed. Otherwise skip.

---

### Task 10: Release

Commit with `[release]` tag and push.

- [ ] **Step 1: Create release commit**

```bash
git commit --allow-empty -m "feat: session-keyed isolation, multi-key cache, PostToolUse fix [release]

Addresses #5 (cross-project rule contamination) and #6 (PostToolUse
excludes read-only tools). Replaces lastProjectDir with session
registry. Removes self-upgrade logic. Adds LRU rule cache."
```

- [ ] **Step 2: Push to master**

```bash
git push origin master
```

- [ ] **Step 3: Pull version bump from CI**

```bash
git pull
```
