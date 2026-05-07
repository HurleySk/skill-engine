# Skill Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the feedback loop between session lessons and skill improvement — accumulate feedback signals on the server, flag skills that need attention, and provide skills to review and apply targeted improvements.

**Architecture:** The server gets two new endpoints (`/skill-feedback`, `/skill-health`) plus a feedback module that handles JSONL signal logging and threshold tracking. Three new SKILL.md files (`skill-improve`, enhanced `debrief`, `using-skill-engine-skills`) replace the old debrief and add the improvement workflow. A nudge rule conditionally fires on session start when skills are flagged. The nudge rule uses a special-case check in `handleActivate` against the threshold file.

**Tech Stack:** Node.js built-in modules (fs, path, os). JSONL for append-only signal log. JSON for threshold state. Zero new dependencies.

---

## File Structure

| File | Role |
|------|------|
| `server/skill-feedback.js` (create) | Feedback module: signal recording, threshold checking, JSONL read/write, health reporting |
| `server/server.js` (modify) | Wire `/skill-feedback` and `/skill-health` endpoints, add activation logging in `handleActivate`, add nudge threshold check in `handleActivate` |
| `tests/skill-feedback.test.js` (create) | Unit tests for the feedback module |
| `tests/server.test.js` (modify) | Integration tests for new endpoints |
| `skills/skill-improve/SKILL.md` (create) | The core skill-improve skill |
| `skills/debrief/SKILL.md` (modify) | Enhanced debrief replacing the current version |
| `skills/using-skill-engine-skills/SKILL.md` (create) | Meta-skill for session-start orientation |
| `CLAUDE.md` (modify) | Document new endpoints and skills |

---

### Task 1: Create the Feedback Module (`server/skill-feedback.js`)

**Files:**
- Create: `server/skill-feedback.js`
- Create: `tests/skill-feedback.test.js`

This module handles all feedback persistence and threshold logic. It's a pure library — no HTTP concerns.

- [ ] **Step 1: Write failing test for `recordSignal`**

```js
// tests/skill-feedback.test.js
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('Skill Feedback Module', () => {
  let tmpDir, feedbackModule;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-feedback-'));
    // Re-require with fresh state each test
    delete require.cache[require.resolve('../server/skill-feedback')];
    feedbackModule = require('../server/skill-feedback');
    feedbackModule._setBaseDir(tmpDir);
  });

  after(() => {
    // Cleanup handled per-test by tmpDir uniqueness
  });

  describe('recordSignal', () => {
    it('appends a signal to the JSONL log and returns recorded:true', () => {
      const result = feedbackModule.recordSignal({
        skillName: 'superpowers:brainstorming',
        type: 'correction',
        summary: 'Visual companion fired for non-UI task',
      });
      assert.equal(result.recorded, true);

      const logPath = path.join(tmpDir, 'skill-feedback-log.jsonl');
      assert.ok(fs.existsSync(logPath));
      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const signal = JSON.parse(lines[0]);
      assert.equal(signal.skillName, 'superpowers:brainstorming');
      assert.equal(signal.type, 'correction');
      assert.ok(signal.timestamp);
    });

    it('increments threshold counter for corrections', () => {
      feedbackModule.recordSignal({ skillName: 'test:skill', type: 'correction', summary: 'a' });
      feedbackModule.recordSignal({ skillName: 'test:skill', type: 'correction', summary: 'b' });

      const thresholds = feedbackModule.getThresholds();
      assert.equal(thresholds['test:skill'].corrections, 2);
      assert.equal(thresholds['test:skill'].needsReview, false);
    });

    it('flags needsReview at 3 corrections', () => {
      feedbackModule.recordSignal({ skillName: 'test:skill', type: 'correction', summary: 'a' });
      feedbackModule.recordSignal({ skillName: 'test:skill', type: 'correction', summary: 'b' });
      const result = feedbackModule.recordSignal({ skillName: 'test:skill', type: 'correction', summary: 'c' });

      assert.deepStrictEqual(result.needsReview, ['test:skill']);
      const thresholds = feedbackModule.getThresholds();
      assert.equal(thresholds['test:skill'].needsReview, true);
    });

    it('does not increment threshold for activation type', () => {
      feedbackModule.recordSignal({ skillName: 'test:skill', type: 'activation', summary: '' });

      const thresholds = feedbackModule.getThresholds();
      assert.equal(thresholds['test:skill'], undefined);
    });

    it('includes sessionId and project when provided', () => {
      feedbackModule.recordSignal({
        skillName: 'test:skill',
        type: 'lesson',
        summary: 'x',
        sessionId: 'sess-1',
        project: 'my-project',
      });

      const logPath = path.join(tmpDir, 'skill-feedback-log.jsonl');
      const signal = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
      assert.equal(signal.sessionId, 'sess-1');
      assert.equal(signal.project, 'my-project');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/skill-feedback.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `recordSignal` and `getThresholds`**

```js
// server/skill-feedback.js
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const THRESHOLD_COUNT = 3;
const MAX_SIGNALS = 200;
const ROLLING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let baseDir = path.join(os.homedir(), '.claude');

function _setBaseDir(dir) { baseDir = dir; }

function logPath() { return path.join(baseDir, 'skill-feedback-log.jsonl'); }
function thresholdsPath() { return path.join(baseDir, 'skill-feedback-thresholds.json'); }

function readThresholds() {
  try {
    return JSON.parse(fs.readFileSync(thresholdsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeThresholds(data) {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(thresholdsPath(), JSON.stringify(data, null, 2));
}

function recordSignal(signal) {
  const entry = {
    skillName: signal.skillName,
    type: signal.type,
    summary: signal.summary || '',
    timestamp: new Date().toISOString(),
  };
  if (signal.sessionId) entry.sessionId = signal.sessionId;
  if (signal.project) entry.project = signal.project;
  if (signal.skillSource) entry.skillSource = signal.skillSource;

  // Append to JSONL log
  fs.mkdirSync(baseDir, { recursive: true });
  fs.appendFileSync(logPath(), JSON.stringify(entry) + '\n');

  // Evict oldest if over cap
  _evictIfNeeded();

  // Update thresholds for correction/lesson types
  const needsReview = [];
  if (signal.type === 'correction' || signal.type === 'lesson') {
    const thresholds = readThresholds();
    const key = signal.skillName;
    if (!thresholds[key]) {
      thresholds[key] = { corrections: 0, needsReview: false };
    }
    thresholds[key].corrections++;
    thresholds[key].lastSignal = entry.timestamp;
    if (thresholds[key].corrections >= THRESHOLD_COUNT && !thresholds[key].needsReview) {
      thresholds[key].needsReview = true;
      thresholds[key].lastFlagged = entry.timestamp;
      needsReview.push(key);
    }
    writeThresholds(thresholds);
  }

  return { recorded: true, needsReview };
}

function _evictIfNeeded() {
  try {
    const content = fs.readFileSync(logPath(), 'utf8').trim();
    if (!content) return;
    const lines = content.split('\n');
    if (lines.length > MAX_SIGNALS) {
      const trimmed = lines.slice(lines.length - MAX_SIGNALS);
      fs.writeFileSync(logPath(), trimmed.join('\n') + '\n');
    }
  } catch {}
}

function getThresholds() {
  return readThresholds();
}

module.exports = { recordSignal, getThresholds, _setBaseDir };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/skill-feedback.test.js`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/skill-feedback.js tests/skill-feedback.test.js
git commit -m "feat: add skill-feedback module with signal recording and thresholds"
```

---

### Task 2: Add `getHealth` and `clearSkill` to the Feedback Module

**Files:**
- Modify: `server/skill-feedback.js`
- Modify: `tests/skill-feedback.test.js`

- [ ] **Step 1: Write failing tests for `getHealth` and `clearSkill`**

Add to `tests/skill-feedback.test.js` inside the outer `describe`:

```js
  describe('getHealth', () => {
    it('returns empty when no signals exist', () => {
      const health = feedbackModule.getHealth();
      assert.deepStrictEqual(health.flagged, []);
      assert.equal(health.totalSignals, 0);
    });

    it('returns flagged skills and total signal count', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '1' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '2' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '3' });
      feedbackModule.recordSignal({ skillName: 'b:skill', type: 'correction', summary: '1' });

      const health = feedbackModule.getHealth();
      assert.equal(health.flagged.length, 1);
      assert.equal(health.flagged[0].skillName, 'a:skill');
      assert.equal(health.flagged[0].corrections, 3);
      assert.equal(health.totalSignals, 4);
    });
  });

  describe('clearSkill', () => {
    it('resets threshold for a skill', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '1' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '2' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '3' });

      feedbackModule.clearSkill('a:skill');

      const thresholds = feedbackModule.getThresholds();
      assert.equal(thresholds['a:skill'], undefined);
    });

    it('marks signals as resolved in the log', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '1' });
      feedbackModule.recordSignal({ skillName: 'b:skill', type: 'correction', summary: '2' });

      feedbackModule.clearSkill('a:skill');

      const logPath = path.join(tmpDir, 'skill-feedback-log.jsonl');
      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const aSignals = lines.filter(s => s.skillName === 'a:skill');
      assert.ok(aSignals.every(s => s.resolved === true));
      const bSignals = lines.filter(s => s.skillName === 'b:skill');
      assert.ok(bSignals.every(s => !s.resolved));
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/skill-feedback.test.js`
Expected: FAIL — `getHealth` and `clearSkill` not defined

- [ ] **Step 3: Implement `getHealth` and `clearSkill`**

Add to `server/skill-feedback.js` before the `module.exports`:

```js
function getHealth() {
  const thresholds = readThresholds();
  const flagged = [];
  for (const [skillName, data] of Object.entries(thresholds)) {
    if (data.needsReview) {
      flagged.push({ skillName, corrections: data.corrections, lastFlagged: data.lastFlagged });
    }
  }

  let totalSignals = 0;
  try {
    const content = fs.readFileSync(logPath(), 'utf8').trim();
    if (content) totalSignals = content.split('\n').length;
  } catch {}

  return { flagged, totalSignals };
}

function clearSkill(skillName) {
  // Remove from thresholds
  const thresholds = readThresholds();
  delete thresholds[skillName];
  writeThresholds(thresholds);

  // Mark signals as resolved in the log
  try {
    const content = fs.readFileSync(logPath(), 'utf8').trim();
    if (!content) return;
    const lines = content.split('\n').map(line => {
      const signal = JSON.parse(line);
      if (signal.skillName === skillName && !signal.resolved) {
        signal.resolved = true;
      }
      return JSON.stringify(signal);
    });
    fs.writeFileSync(logPath(), lines.join('\n') + '\n');
  } catch {}
}
```

Update `module.exports`:

```js
module.exports = { recordSignal, getThresholds, getHealth, clearSkill, _setBaseDir };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/skill-feedback.test.js`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/skill-feedback.js tests/skill-feedback.test.js
git commit -m "feat: add getHealth and clearSkill to feedback module"
```

---

### Task 3: Add `getSignalsForSkill` and Rolling Window Expiry

**Files:**
- Modify: `server/skill-feedback.js`
- Modify: `tests/skill-feedback.test.js`

- [ ] **Step 1: Write failing tests**

Add to `tests/skill-feedback.test.js`:

```js
  describe('getSignalsForSkill', () => {
    it('returns signals filtered by skill name', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: 'first' });
      feedbackModule.recordSignal({ skillName: 'b:skill', type: 'correction', summary: 'other' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'lesson', summary: 'second' });

      const signals = feedbackModule.getSignalsForSkill('a:skill');
      assert.equal(signals.length, 2);
      assert.equal(signals[0].summary, 'first');
      assert.equal(signals[1].summary, 'second');
    });

    it('excludes resolved signals by default', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '1' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '2' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '3' });
      feedbackModule.clearSkill('a:skill');

      const signals = feedbackModule.getSignalsForSkill('a:skill');
      assert.equal(signals.length, 0);
    });

    it('includes resolved signals when requested', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '1' });
      feedbackModule.clearSkill('a:skill');

      const signals = feedbackModule.getSignalsForSkill('a:skill', { includeResolved: true });
      assert.equal(signals.length, 1);
    });
  });

  describe('rolling window expiry', () => {
    it('does not count corrections older than 7 days toward threshold', () => {
      // Manually write old signals
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const logFile = path.join(tmpDir, 'skill-feedback-log.jsonl');
      fs.writeFileSync(logFile,
        JSON.stringify({ skillName: 'old:skill', type: 'correction', summary: 'old1', timestamp: oldDate }) + '\n' +
        JSON.stringify({ skillName: 'old:skill', type: 'correction', summary: 'old2', timestamp: oldDate }) + '\n'
      );
      // Manually set threshold with old count
      const threshFile = path.join(tmpDir, 'skill-feedback-thresholds.json');
      fs.writeFileSync(threshFile, JSON.stringify({
        'old:skill': { corrections: 2, needsReview: false }
      }));

      // Recount should drop the stale ones
      feedbackModule.recount();
      const thresholds = feedbackModule.getThresholds();
      assert.equal(thresholds['old:skill'], undefined);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/skill-feedback.test.js`
Expected: FAIL — functions not defined

- [ ] **Step 3: Implement `getSignalsForSkill` and `recount`**

Add to `server/skill-feedback.js`:

```js
function readAllSignals() {
  try {
    const content = fs.readFileSync(logPath(), 'utf8').trim();
    if (!content) return [];
    return content.split('\n').map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function getSignalsForSkill(skillName, options) {
  const includeResolved = options && options.includeResolved;
  const signals = readAllSignals();
  return signals.filter(s => {
    if (s.skillName !== skillName) return false;
    if (!includeResolved && s.resolved) return false;
    return true;
  });
}

function recount() {
  const cutoff = new Date(Date.now() - ROLLING_WINDOW_MS).toISOString();
  const signals = readAllSignals();
  const counts = {};

  for (const signal of signals) {
    if (signal.resolved) continue;
    if (signal.timestamp < cutoff) continue;
    if (signal.type !== 'correction' && signal.type !== 'lesson') continue;
    const key = signal.skillName;
    if (!counts[key]) counts[key] = 0;
    counts[key]++;
  }

  const thresholds = {};
  for (const [skillName, count] of Object.entries(counts)) {
    thresholds[skillName] = {
      corrections: count,
      needsReview: count >= THRESHOLD_COUNT,
    };
    if (count >= THRESHOLD_COUNT) {
      thresholds[skillName].lastFlagged = new Date().toISOString();
    }
  }
  writeThresholds(thresholds);
}
```

Update `module.exports`:

```js
module.exports = { recordSignal, getThresholds, getHealth, clearSkill, getSignalsForSkill, recount, _setBaseDir };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/skill-feedback.test.js`
Expected: All 13 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/skill-feedback.js tests/skill-feedback.test.js
git commit -m "feat: add getSignalsForSkill, recount, and rolling window expiry"
```

---

### Task 4: Wire `/skill-feedback` and `/skill-health` Endpoints into Server

**Files:**
- Modify: `server/server.js`
- Modify: `tests/server.test.js`

- [ ] **Step 1: Write failing integration tests**

Add to `tests/server.test.js`:

```js
describe('Skill Feedback Endpoint', () => {
  let harness;
  const PORT = 19782;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {}
    });
  });

  after(() => { stopTestServer(harness); });

  it('POST /skill-feedback records a signal', async () => {
    const res = await request('POST', '/skill-feedback', {
      skillName: 'test:skill',
      type: 'correction',
      summary: 'test signal'
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.recorded, true);
    assert.ok(Array.isArray(res.body.needsReview));
  });

  it('POST /skill-feedback returns 400 without skillName', async () => {
    const res = await request('POST', '/skill-feedback', {
      type: 'correction',
      summary: 'no skill name'
    }, PORT);
    assert.equal(res.status, 400);
  });

  it('GET /skill-health returns health data', async () => {
    const res = await request('GET', '/skill-health', null, PORT);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.flagged));
    assert.equal(typeof res.body.totalSignals, 'number');
  });

  it('POST /skill-feedback/clear resets a skill', async () => {
    // First record enough to flag
    for (let i = 0; i < 3; i++) {
      await request('POST', '/skill-feedback', {
        skillName: 'clear:test', type: 'correction', summary: 'c' + i
      }, PORT);
    }
    // Verify flagged
    let health = await request('GET', '/skill-health', null, PORT);
    assert.ok(health.body.flagged.some(f => f.skillName === 'clear:test'));

    // Clear
    const res = await request('POST', '/skill-feedback/clear', { skillName: 'clear:test' }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.cleared, true);

    // Verify no longer flagged
    health = await request('GET', '/skill-health', null, PORT);
    assert.ok(!health.body.flagged.some(f => f.skillName === 'clear:test'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/server.test.js`
Expected: New tests FAIL (endpoints return empty 200 via fail-open)

- [ ] **Step 3: Wire endpoints into `server.js`**

At the top of `server/server.js`, add the require:

```js
const skillFeedback = require('./skill-feedback');
```

In the `handleRequest` function, add these blocks before the route-table POST handler (before `const route = method === 'POST' && routes[url];`):

```js
  if (method === 'GET' && url === '/skill-health') {
    const health = skillFeedback.getHealth();
    return respond(res, 200, health);
  }

  if (method === 'POST' && url === '/skill-feedback') {
    let body = null;
    try { body = await readBody(req); } catch {}
    if (!body || !body.skillName) {
      return respond(res, 400, { error: 'skillName required' });
    }
    const result = skillFeedback.recordSignal(body);
    return respond(res, 200, result);
  }

  if (method === 'POST' && url === '/skill-feedback/clear') {
    let body = null;
    try { body = await readBody(req); } catch {}
    if (!body || !body.skillName) {
      return respond(res, 400, { error: 'skillName required' });
    }
    skillFeedback.clearSkill(body.skillName);
    return respond(res, 200, { cleared: true });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/server.test.js`
Expected: All tests PASS (new and existing)

- [ ] **Step 5: Commit**

```bash
git add server/server.js tests/server.test.js
git commit -m "feat: wire /skill-feedback, /skill-health, /skill-feedback/clear endpoints"
```

---

### Task 5: Add Activation Logging in `handleActivate`

**Files:**
- Modify: `server/server.js`
- Modify: `tests/server.test.js`

When skills match in `handleActivate`, log an activation signal for each matched skill.

- [ ] **Step 1: Write failing test**

Add to `tests/server.test.js`:

```js
describe('Activation Logging', () => {
  let harness;
  const PORT = 19783;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'log-test-rule': {
          type: 'domain',
          description: 'Test rule for activation logging',
          triggers: { prompt: { keywords: ['activation-log-test'] } }
        }
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('logs activation signals when skills match', async () => {
    await request('POST', '/activate', { prompt: 'activation-log-test' }, PORT);

    const health = await request('GET', '/skill-health', null, PORT);
    assert.ok(health.body.totalSignals >= 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server.test.js`
Expected: FAIL — totalSignals is 0 because no activation logging yet

- [ ] **Step 3: Add activation logging to `handleActivate`**

In `server/server.js`, in the `handleActivate` function, after `recordSessionOnce(session, matches);` (around line 563), add:

```js
  // Log activation signals for feedback tracking
  for (const m of matches) {
    skillFeedback.recordSignal({
      skillName: m.name,
      type: 'activation',
      summary: '',
      sessionId: input.session_id || '',
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/server.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/server.js tests/server.test.js
git commit -m "feat: log activation signals in handleActivate for feedback tracking"
```

---

### Task 6: Add Nudge Threshold Check in `handleActivate`

**Files:**
- Modify: `server/server.js`
- Modify: `tests/server.test.js`

When skills are flagged in the threshold file, append a nudge line to the activate response.

- [ ] **Step 1: Write failing test**

Add to `tests/server.test.js`:

```js
describe('Skill Health Nudge', () => {
  let harness;
  const PORT = 19784;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'filler-rule': {
          type: 'domain',
          description: 'Filler',
          triggers: { prompt: { keywords: ['nudge-test'] } }
        }
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('appends nudge when skills are flagged', async () => {
    // Record 3 corrections to trigger the flag
    for (let i = 0; i < 3; i++) {
      await request('POST', '/skill-feedback', {
        skillName: 'nudge:target', type: 'correction', summary: 'c' + i
      }, PORT);
    }

    const res = await request('POST', '/activate', { prompt: 'nudge-test' }, PORT);
    const context = res.body.hookSpecificOutput && res.body.hookSpecificOutput.additionalContext;
    assert.ok(context, 'Should have additional context');
    assert.ok(context.includes('Skill health'), 'Should include skill health nudge');
    assert.ok(context.includes('nudge:target'), 'Should mention the flagged skill');
  });

  it('does not nudge when no skills are flagged', async () => {
    // Clear the flagged skill
    await request('POST', '/skill-feedback/clear', { skillName: 'nudge:target' }, PORT);

    const res = await request('POST', '/activate', { prompt: 'nudge-test', session_id: 'fresh-session' }, PORT);
    const context = res.body.hookSpecificOutput && res.body.hookSpecificOutput.additionalContext;
    if (context) {
      assert.ok(!context.includes('Skill health'), 'Should not include nudge when nothing flagged');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server.test.js`
Expected: FAIL — no nudge in the output

- [ ] **Step 3: Add nudge check to `handleActivate`**

In `server/server.js`, in the `handleActivate` function, before the final `return` statement (around line 604), add:

```js
  // Append skill-health nudge if skills are flagged
  const health = skillFeedback.getHealth();
  if (health.flagged.length > 0) {
    const skillList = health.flagged.map(f => f.skillName).join(', ');
    lines.push('');
    lines.push('📋 **Skill health:** ' + health.flagged.length + ' skill' +
      (health.flagged.length > 1 ? 's have' : ' has') +
      ' accumulated feedback (' + skillList + ') — run `/skill-engine:skill-improve` to review.');
  }
```

Also add the same check to the early-return path (when no rules match but we still want to nudge). After the `if (!matches.length)` block, replace:

```js
  if (!matches.length) {
    const asyncFindings = input && input.session_id ? asyncManager.drainFindings(input.session_id) : [];
    if (!asyncFindings.length) return {};
    const lines = formatAsyncFindings(asyncFindings);
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lines.join('\n') } };
  }
```

With:

```js
  if (!matches.length) {
    const asyncFindings = input && input.session_id ? asyncManager.drainFindings(input.session_id) : [];
    const health = skillFeedback.getHealth();
    if (!asyncFindings.length && !health.flagged.length) return {};
    const outLines = [];
    if (asyncFindings.length) outLines.push(...formatAsyncFindings(asyncFindings));
    if (health.flagged.length) {
      const skillList = health.flagged.map(f => f.skillName).join(', ');
      outLines.push('');
      outLines.push('📋 **Skill health:** ' + health.flagged.length + ' skill' +
        (health.flagged.length > 1 ? 's have' : ' has') +
        ' accumulated feedback (' + skillList + ') — run `/skill-engine:skill-improve` to review.');
    }
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: outLines.join('\n') } };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/server.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/server.js tests/server.test.js
git commit -m "feat: add skill-health nudge to activate response when skills are flagged"
```

---

### Task 7: Create `skill-improve` SKILL.md

**Files:**
- Create: `skills/skill-improve/SKILL.md`

This is a pure SKILL.md — no code, just instructions for the agent.

- [ ] **Step 1: Create the skill directory**

```bash
mkdir -p skills/skill-improve
```

- [ ] **Step 2: Write the SKILL.md**

```markdown
---
name: skill-improve
description: Review accumulated skill feedback, identify improvement targets, propose and apply targeted skill edits. Use when skills have accumulated feedback or when you want to audit a specific skill.
argument-hint: "[skill-name | --lessons]"
---

# Skill Engine — Skill Improve

Review accumulated feedback about skills and propose targeted improvements. Works with both project-local skills and plugin (boomerang) skills.

**Invoke:** `/skill-engine:skill-improve`

## Finding the Plugin Directory

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Invocation Modes

- **(default)** — audit mode: reads feedback log, processes all flagged skills
- **`<skill-name>`** — target a specific skill by name
- **`--lessons`** — interactive: asks what went wrong, then finds relevant skill(s)

## Process

### Step 1: Gather Context

Check the skill-engine server for accumulated feedback:

```bash
curl -s http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-health
```

If invoked with a specific skill name, also fetch its signals:

```bash
curl -s "http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-feedback/signals?skill=<skill-name>"
```

If `--lessons` mode, ask the user: "What went wrong or could be improved?" Then search installed skills for relevance.

**Early exit:** If no flagged skills and no specific target, tell the user: "No skills have accumulated feedback. Use `/skill-engine:debrief` after sessions to capture feedback, or invoke with a specific skill name." Stop here.

For each flagged skill (or the targeted skill):
- Read the full SKILL.md content — check both plugin cache and project-local `.claude/skills/`
- Collect all unresolved signals for that skill from the feedback log

### Step 2: Dispatch Analysis Subagent

For each flagged skill, dispatch a `general-purpose` subagent with the skill content and all signals. Use this prompt:

~~~
You are a skill quality analyst. Review this skill definition and the accumulated user feedback to identify specific improvements.

## Skill Content

[Insert full SKILL.md content here]

## Accumulated Feedback Signals

[Insert all signals for this skill here]

## Analysis Instructions

1. For each feedback signal, identify which section of the skill is responsible. Quote the relevant lines.
2. Propose a **concrete edit** for each issue — show what the text says now and what it should say. Keep edits minimal and targeted.
3. Look for structural issues beyond what the signals report: overly rigid steps, vague instructions, missing edge cases, contradictory guidance.
4. **Boomerang check:** These skills run across many projects. Flag any proposed edit that seems project-specific vs. universally beneficial. Only propose universal improvements.
5. **Infrastructure gaps:** If the real fix isn't a skill edit but rather a skill-engine feature (e.g., conditional steps, project-type detection), flag it separately.

## Output Format

For each finding:

**Finding N: [title]**
- Signals: [which signals relate to this]
- Location: [line numbers or section name in the skill]
- Current text: [quote what's there now]
- Proposed edit: [what it should say instead]
- Scope: universal | project-specific
- Type: skill-edit | infrastructure-suggestion

End with a one-line summary: "N findings: X skill-edits, Y infrastructure suggestions"
~~~

### Step 3: Present Findings

For each skill, present the subagent's findings grouped:

```
[skill-name] — N corrections, M activations last 7 days

Skill Edits:
1. [title] (lines X-Y) — N signals
   Current: "..."
   Proposed: "..."

Infrastructure Suggestions:
- [description]
```

### Step 4: User Approves Per-Finding

For each finding, ask: **approve / edit / skip**

Apply approved edits to the skill file.

### Step 5: Edit Target Logic

- **Project-local skills** (`.claude/skills/`) → edit in place
- **Plugin skills** (in plugin cache at `~/.claude/plugins/cache/`) → check if the source repo exists locally (look for common paths like `~/source/repos/HurleySk/<plugin-name>`). If found, apply edit there and commit. If not, save proposed diffs to `pending-skill-improvements.md` in the current project for later application.

### Step 6: Clear Processed Feedback

After the user processes all findings for a skill, clear it:

```bash
curl -s -X POST http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-feedback/clear \
  -H 'Content-Type: application/json' \
  -d '{"skillName":"<skill-name>"}'
```

### Step 7: Summary

```
Skill improvement complete.
- [skill]: N edits applied, M skipped
- Infrastructure suggestions: N (saved to memory)
- Feedback log: N signals resolved, M remaining
```
```

- [ ] **Step 3: Commit**

```bash
git add skills/skill-improve/SKILL.md
git commit -m "feat: add skill-improve skill for feedback-driven skill improvement"
```

---

### Task 8: Create Enhanced Debrief SKILL.md (replace existing)

**Files:**
- Modify: `skills/debrief/SKILL.md`

The current debrief is at `skills/debrief/SKILL.md`. We replace its content entirely, preserving all existing functionality and adding three new sections.

- [ ] **Step 1: Read the current debrief for reference**

Read `skills/debrief/SKILL.md` to confirm the existing steps (already read during planning — Steps 1-5: Session Scan, Lesson Framing, Fix-Level Evaluation, Present and Confirm, Persist).

- [ ] **Step 2: Write the enhanced debrief**

Replace `skills/debrief/SKILL.md` with:

```markdown
---
name: debrief
description: End-of-session lesson capture with holistic review, skill improvement routing, and skill health reporting. Use when a session surfaced lessons worth capturing — crashes, gotchas, code review findings, architectural discoveries, user corrections.
---

# Session Debrief

Systematically capture session lessons, assess overall skill effectiveness, and route each lesson to the right persistence mechanism. Prefer code fixes over rules, rules over documentation.

**Invoke manually:** `/skill-engine:debrief`

## Finding the Plugin Directory

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Process

### Step 1: Session Scan

Review the conversation for notable events:
- Crashes, exceptions, or build failures
- Code review findings
- Workarounds or gotchas discovered
- Architectural constraints learned
- User corrections or preference signals
- Patterns that recurred (same mistake made twice)
- **Skills that misfired, were too rigid, or had gaps**
- **Moments where the agent deviated from a skill's instructions**

List each event as a one-line summary. If nothing notable happened, tell the user and stop.

### Step 2: Lesson Framing

For each event, frame the lesson: "What went wrong, and what would prevent it in the future?"

### Step 3: Fix-Level Evaluation

For each lesson, evaluate these fix levels and recommend the best one:

| Fix Level | When to Recommend |
|---|---|
| **Code fix** | The fix is straightforward, mechanical, and fits existing code patterns. Makes the problem structurally impossible or detectable at runtime. |
| **Test** | Session revealed a test coverage gap — an assertion or test case would catch this in the future. |
| **Skill-engine rule** | Pattern is detectable in file content or tool input. A code fix would be disproportionate effort or fragile. |
| **Memory** | Contextual knowledge not expressible as code or rules (project state, user preferences, architectural decisions). |
| **CLAUDE.md / config** | New safety boundary or project-wide instruction (safety-rules.json, settings.json). |
| **New skill** | Reusable multi-step workflow pattern that applies across sessions. |
| **Skill improvement** | The lesson points to a gap, rigidity, or failure in an existing skill's instructions — not a new skill, but an improvement to one that exists. |

**You must recommend one with reasoning.** Evaluate:
- Engineering effort vs. value
- Fragility and edge cases of a code fix
- How well it fits existing patterns
- Whether the pattern is mechanical (rule-friendly) or judgment-dependent (memory-friendly)
- **Whether an existing skill was involved and could be improved to prevent recurrence**

**Example reasoning:**

> Null reference crash is a one-line guard in a method that already handles optional parameters. **Recommend: Code fix** — apply directly.

> Auto-converting between query formats would need to handle syntax differences, pagination semantics — high effort, fragile. A rule that warns on the risky pattern is 90% of the value for 5% of the effort. **Recommend: rule.**

> "User prefers bundled PRs over small ones for refactors" — not enforceable in code or rules, purely a collaboration preference. **Recommend: feedback memory.**

> The brainstorming skill asked a visual companion question for a CLI-only project. This is a gap in the skill's conditional logic, not a new skill. **Recommend: Skill improvement** — the skill needs a gate on visual companion offers.

### Step 4: Present and Confirm

Present all lessons in a table:

| # | Lesson | Recommendation | Reasoning |
|---|---|---|---|
| 1 | ... | Code fix | ... |
| 2 | ... | Rule | ... |
| 3 | ... | Skill improvement | ... |

Ask the user to approve, edit, redirect, or skip each item.

### Step 4.5: Holistic Session Assessment

Step back from individual lessons. Consider the session as a whole:

- Did the overall workflow feel right, or was there friction between skills?
- Were skills invoked in the right order? Did one skill's output feed cleanly into the next?
- Were there moments where no skill applied but should have?
- Did the agent struggle with something that a skill-engine infrastructure improvement would fix?

Present holistic observations as a separate section. These are strategic observations — not routed to fix levels, but shared for the user to consider.

### Step 5: Persist

For each approved item, route to the appropriate mechanism:

| Fix Level | Action |
|---|---|
| Code fix (small, < ~20 lines) | Apply the fix directly, run tests, commit |
| Code fix (large or design needed) | Save to project memory with file:line references and scope for a future session |
| Test | Write the test case, run it, commit |
| Skill-engine rule | Invoke `/skill-engine:learn-rule` with the lesson context |
| Memory | Write to memory system (project, feedback, or user type as appropriate) |
| CLAUDE.md | Propose the edit, apply after user approval |
| Config (safety-rules.json, settings) | Propose the edit, apply after user approval |
| New skill | Invoke `/skill-engine:learn-skill` with the workflow description |
| Skill improvement | Post feedback to the server, then ask: route to `/skill-engine:skill-improve` now, or batch for later? |

**For skill improvement items**, post the signal:

```bash
curl -s -X POST http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName":"<skill-name>","type":"correction","summary":"<lesson summary>"}'
```

### Step 6: Skill Health Check

After persisting all items, check the current skill health:

```bash
curl -s http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-health
```

If any skills are flagged, present:

```
Skill Health:
- [skill-name] — N corrections (needs review)
- [skill-name] — N corrections (monitoring)
- All other skills healthy

Run /skill-engine:skill-improve to address flagged skills.
```

After processing all items (or if the user declines all), summarize:

> **Debrief complete.** Fixed: N | Skipped: N | Skill feedback recorded: N | Remaining recommendations: [list if any]
```

- [ ] **Step 3: Commit**

```bash
git add skills/debrief/SKILL.md
git commit -m "feat: enhanced debrief with skill improvement routing and holistic review"
```

---

### Task 9: Create `using-skill-engine-skills` Meta-Skill

**Files:**
- Create: `skills/using-skill-engine-skills/SKILL.md`

- [ ] **Step 1: Create the skill directory**

```bash
mkdir -p skills/using-skill-engine-skills
```

- [ ] **Step 2: Write the SKILL.md**

```markdown
---
name: using-skill-engine-skills
description: Session-start orientation on the skill-engine ecosystem — skill inventory, decision tree, feedback loop awareness. Use when starting a session in a project with skill-engine installed.
---

# Using Skill Engine Skills

This skill orients you on the skill-engine ecosystem so you know what tools are available and when to use them.

## Skill Inventory

| Skill | Slug | Purpose |
|---|---|---|
| **learn** | `skill-engine:learn` | Capture a lesson as a rule or skill — classifies and routes |
| **learn-rule** | `skill-engine:learn-rule` | Create or update enforcement rules |
| **learn-skill** | `skill-engine:learn-skill` | Scaffold a reusable SKILL.md |
| **review** | `skill-engine:review` | Holistic audit of Claude config (CLAUDE.md, skills, rules, hooks, MCP) |
| **skill-improve** | `skill-engine:skill-improve` | Review accumulated feedback and propose targeted skill edits |
| **debrief** | `skill-engine:debrief` | End-of-session lesson capture + holistic review + skill health |
| **rule-review** | `skill-engine:rule-review` | Audit rules for validity, conflicts, dead patterns |
| **rule-consistency** | `skill-engine:rule-consistency` | Detect semantically contradictory or redundant rules |
| **perf-check** | `skill-engine:perf-check` | Performance audit of hooks, MCP servers, plugin config |
| **start** | `skill-engine:start` | Start or resume the skill-engine server |
| **stop** | `skill-engine:stop` | Pause the skill-engine server |
| **status** | `skill-engine:status` | Server diagnostics — port, uptime, rules, sessions |

## Decision Tree

Use this to decide which skill to invoke:

- **Session start + nudge received** → `/skill-engine:skill-improve` (address flagged skills)
- **Mid-session, learned something** → `/skill-engine:learn` (capture as rule or skill)
- **A skill led you astray** → note it for debrief, or post feedback directly via curl to `/skill-feedback`
- **Session end** → `/skill-engine:debrief` (capture lessons, review skill health)
- **Skills or config feel stale** → `/skill-engine:review` (full audit)
- **Specific skill needs improvement** → `/skill-engine:skill-improve <name>`
- **Rules seem contradictory** → `/skill-engine:rule-consistency`
- **Performance concern** → `/skill-engine:perf-check`
- **Server not running** → `/skill-engine:start`

## Feedback Loop Awareness

The skill-engine accumulates feedback about skill performance over time. When you notice a skill misfiring, being too rigid, or having gaps:

1. **During a session:** Note it mentally for the debrief
2. **During debrief:** Classify it as "Skill improvement" — this posts a signal to the server
3. **When thresholds are crossed:** The server will nudge at session start
4. **When nudged:** Run `/skill-engine:skill-improve` to review and apply fixes

The key habit: **if a skill led you astray, that's a signal worth recording, not just something to work around and forget.**

## Skill-Engine vs. Superpowers Boundary

- **Superpowers skills** (brainstorming, TDD, writing-plans, debugging, etc.) are *consumed* by projects but *maintained* in the superpowers-marketplace repo
- **Skill-engine skills** (this inventory) are the *meta-layer* — they improve, audit, and manage everything else
- When `skill-improve` proposes edits to a superpowers skill, those edits need to go to the superpowers source repo, not just the local plugin cache
```

- [ ] **Step 3: Commit**

```bash
git add skills/using-skill-engine-skills/SKILL.md
git commit -m "feat: add using-skill-engine-skills meta-skill for session orientation"
```

---

### Task 10: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add new endpoints and skills to the Architecture section**

In `CLAUDE.md`, update the server bullet to include the new endpoints:

Add after the existing endpoint list in the `- server/server.js` line:

```
- `server/skill-feedback.js` — feedback signal recording, threshold tracking, health reporting (`/skill-feedback`, `/skill-health`, `/skill-feedback/clear`)
```

- [ ] **Step 2: Add new skills to the skills section**

Add to the skills documentation:

```
- `skills/skill-improve/` — feedback-driven skill improvement: reads accumulated signals, dispatches analysis, proposes targeted edits
- `skills/using-skill-engine-skills/` — session-start orientation meta-skill: skill inventory, decision tree, feedback loop awareness
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add feedback loop endpoints and skills to CLAUDE.md"
```

---

### Task 11: Run Full Test Suite and Verify

**Files:**
- All modified files

- [ ] **Step 1: Run all tests**

Run: `node --test tests/*.test.js`
Expected: All tests PASS

- [ ] **Step 2: Start the server and verify health**

```bash
node server/server.js &
sleep 1
curl -s http://localhost:19750/health | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const h=JSON.parse(d);console.log('version:',h.version,'rules:',h.rulesLoaded)"
```

- [ ] **Step 3: Test the feedback flow end-to-end**

```bash
# Record 3 corrections
for i in 1 2 3; do
  curl -s -X POST http://localhost:19750/skill-feedback \
    -H 'Content-Type: application/json' \
    -d "{\"skillName\":\"test:manual\",\"type\":\"correction\",\"summary\":\"test $i\"}"
done

# Check health
curl -s http://localhost:19750/skill-health

# Verify nudge appears in activate
curl -s -X POST http://localhost:19750/activate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"hello"}'

# Clear and verify
curl -s -X POST http://localhost:19750/skill-feedback/clear \
  -H 'Content-Type: application/json' \
  -d '{"skillName":"test:manual"}'
curl -s http://localhost:19750/skill-health
```

- [ ] **Step 4: Kill the test server**

```bash
kill %1 2>/dev/null || true
```

- [ ] **Step 5: Final commit with release tag**

```bash
git add -A
git commit -m "feat: skill feedback loop — signal accumulation, threshold nudges, skill-improve workflow [release]"
```
