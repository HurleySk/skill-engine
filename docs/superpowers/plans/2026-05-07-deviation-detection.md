# Deviation Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add passive, debrief-time deviation detection — skills declare checkpoints in frontmatter, the debrief auto-checks them, and confirmed deviations feed into the existing skill-feedback loop with self-tuning dismissal suppression.

**Architecture:** Two small server additions (one new field in `recordSignal`, one new query endpoint) plus a debrief skill enhancement. Checkpoints live in SKILL.md frontmatter and are evaluated by the agent at debrief time — no hot-path changes. Dismissal signals use the existing feedback infrastructure with a new `"dismissal"` type.

**Tech Stack:** Node.js built-in modules (fs, path, os, url). Zero new dependencies.

---

## File Structure

| File | Role |
|------|------|
| `server/skill-feedback.js` (modify) | Add `checkpointId` passthrough in `recordSignal`, add `getSignalsForSession()` function |
| `server/server.js` (modify) | Add `GET /skill-feedback/signals` query endpoint |
| `tests/skill-feedback.test.js` (modify) | Unit tests for `checkpointId` persistence and `getSignalsForSession` |
| `tests/server.test.js` (modify) | Integration tests for the new endpoint |
| `skills/debrief/SKILL.md` (modify) | Add Step 0.5: Automated Deviation Check |
| `CLAUDE.md` (modify) | Document new endpoint |

---

### Task 1: Add `checkpointId` Passthrough to `recordSignal`

**Files:**
- Modify: `server/skill-feedback.js:31-40`
- Modify: `tests/skill-feedback.test.js`

The existing `recordSignal` passes through `sessionId`, `project`, and `skillSource`. Add `checkpointId` to the same pattern.

- [ ] **Step 1: Write failing test for `checkpointId` persistence**

Add to `tests/skill-feedback.test.js` inside the `recordSignal` describe block, after the existing `'includes sessionId and project when provided'` test:

```js
    it('includes checkpointId when provided', () => {
      feedbackModule.recordSignal({
        skillName: 'test:skill',
        type: 'dismissal',
        summary: 'User override',
        checkpointId: 'task-checklist',
        sessionId: 'sess-1',
      });

      const logFile = path.join(tmpDir, 'skill-feedback-log.jsonl');
      const signal = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
      assert.equal(signal.checkpointId, 'task-checklist');
      assert.equal(signal.type, 'dismissal');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/skill-feedback.test.js`
Expected: FAIL — `signal.checkpointId` is `undefined`

- [ ] **Step 3: Add `checkpointId` passthrough to `recordSignal`**

In `server/skill-feedback.js`, in the `recordSignal` function, after line 40 (`if (signal.skillSource) entry.skillSource = signal.skillSource;`), add:

```js
  if (signal.checkpointId) entry.checkpointId = signal.checkpointId;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/skill-feedback.test.js`
Expected: All tests PASS

- [ ] **Step 5: Write test that dismissal type does not increment threshold**

Add to `tests/skill-feedback.test.js` inside the `recordSignal` describe block:

```js
    it('does not increment threshold for dismissal type', () => {
      feedbackModule.recordSignal({ skillName: 'test:skill', type: 'dismissal', summary: 'skip', checkpointId: 'cp1' });

      const thresholds = feedbackModule.getThresholds();
      assert.equal(thresholds['test:skill'], undefined);
    });
```

- [ ] **Step 6: Run test to verify it passes (already correct behavior)**

Run: `node --test tests/skill-feedback.test.js`
Expected: PASS — `recordSignal` only increments thresholds for `correction` and `lesson` types, so `dismissal` is already handled correctly.

- [ ] **Step 7: Commit**

```bash
git add server/skill-feedback.js tests/skill-feedback.test.js
git commit -m "feat: add checkpointId passthrough to recordSignal"
```

---

### Task 2: Add `getSignalsForSession` Function

**Files:**
- Modify: `server/skill-feedback.js`
- Modify: `tests/skill-feedback.test.js`

- [ ] **Step 1: Write failing tests for `getSignalsForSession`**

Add a new describe block to `tests/skill-feedback.test.js` inside the outer `describe('Skill Feedback Module')`:

```js
  describe('getSignalsForSession', () => {
    it('returns signals filtered by sessionId', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'activation', summary: '', sessionId: 'sess-1' });
      feedbackModule.recordSignal({ skillName: 'b:skill', type: 'activation', summary: '', sessionId: 'sess-2' });
      feedbackModule.recordSignal({ skillName: 'c:skill', type: 'correction', summary: 'x', sessionId: 'sess-1' });

      const signals = feedbackModule.getSignalsForSession('sess-1');
      assert.equal(signals.length, 2);
      assert.ok(signals.every(s => s.sessionId === 'sess-1'));
    });

    it('returns empty array when no signals match sessionId', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'activation', summary: '', sessionId: 'sess-1' });

      const signals = feedbackModule.getSignalsForSession('sess-99');
      assert.equal(signals.length, 0);
    });

    it('filters by type when provided', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'activation', summary: '', sessionId: 'sess-1' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: 'x', sessionId: 'sess-1' });
      feedbackModule.recordSignal({ skillName: 'b:skill', type: 'activation', summary: '', sessionId: 'sess-1' });

      const signals = feedbackModule.getSignalsForSession('sess-1', { type: 'activation' });
      assert.equal(signals.length, 2);
      assert.ok(signals.every(s => s.type === 'activation'));
    });

    it('excludes resolved signals by default', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '1', sessionId: 'sess-1' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '2', sessionId: 'sess-1' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '3', sessionId: 'sess-1' });
      feedbackModule.clearSkill('a:skill');

      const signals = feedbackModule.getSignalsForSession('sess-1');
      assert.equal(signals.length, 0);
    });

    it('includes resolved signals when requested', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '1', sessionId: 'sess-1' });
      feedbackModule.clearSkill('a:skill');

      const signals = feedbackModule.getSignalsForSession('sess-1', { includeResolved: true });
      assert.equal(signals.length, 1);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/skill-feedback.test.js`
Expected: FAIL — `feedbackModule.getSignalsForSession is not a function`

- [ ] **Step 3: Implement `getSignalsForSession`**

Add to `server/skill-feedback.js`, after the `getSignalsForSkill` function (before `function recount()`):

```js
function getSignalsForSession(sessionId, options) {
  const includeResolved = options && options.includeResolved;
  const typeFilter = options && options.type;
  const signals = readAllSignals();
  return signals.filter(s => {
    if (s.sessionId !== sessionId) return false;
    if (!includeResolved && s.resolved) return false;
    if (typeFilter && s.type !== typeFilter) return false;
    return true;
  });
}
```

Update `module.exports` to include `getSignalsForSession`:

```js
module.exports = { recordSignal, getThresholds, getHealth, clearSkill, getSignalsForSkill, getSignalsForSession, recount, _setBaseDir };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/skill-feedback.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/skill-feedback.js tests/skill-feedback.test.js
git commit -m "feat: add getSignalsForSession to feedback module"
```

---

### Task 3: Add `GET /skill-feedback/signals` Endpoint

**Files:**
- Modify: `server/server.js:981-1005`
- Modify: `tests/server.test.js`

- [ ] **Step 1: Write failing integration tests**

Add a new describe block to `tests/server.test.js`:

```js
describe('Skill Feedback Signals Query Endpoint', () => {
  let harness;
  const PORT = 19785;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {}
    });
  });

  after(() => { stopTestServer(harness); });

  it('GET /skill-feedback/signals returns all signals when no filters', async () => {
    await request('POST', '/skill-feedback', {
      skillName: 'a:skill', type: 'activation', summary: '', sessionId: 'sess-q1'
    }, PORT);
    await request('POST', '/skill-feedback', {
      skillName: 'b:skill', type: 'correction', summary: 'x', sessionId: 'sess-q2'
    }, PORT);

    const res = await request('GET', '/skill-feedback/signals', null, PORT);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 2);
  });

  it('GET /skill-feedback/signals?sessionId=X filters by session', async () => {
    await request('POST', '/skill-feedback', {
      skillName: 'c:skill', type: 'activation', summary: '', sessionId: 'sess-filter-1'
    }, PORT);
    await request('POST', '/skill-feedback', {
      skillName: 'd:skill', type: 'activation', summary: '', sessionId: 'sess-filter-2'
    }, PORT);

    const res = await request('GET', '/skill-feedback/signals?sessionId=sess-filter-1', null, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.every(s => s.sessionId === 'sess-filter-1'));
  });

  it('GET /skill-feedback/signals?skillName=X filters by skill', async () => {
    await request('POST', '/skill-feedback', {
      skillName: 'filter:target', type: 'correction', summary: 'a', sessionId: 'sess-f'
    }, PORT);

    const res = await request('GET', '/skill-feedback/signals?skillName=filter:target', null, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.length >= 1);
    assert.ok(res.body.every(s => s.skillName === 'filter:target'));
  });

  it('GET /skill-feedback/signals?type=activation filters by type', async () => {
    const res = await request('GET', '/skill-feedback/signals?type=activation', null, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.every(s => s.type === 'activation'));
  });

  it('GET /skill-feedback/signals?sessionId=X&type=Y combines filters', async () => {
    await request('POST', '/skill-feedback', {
      skillName: 'combo:skill', type: 'activation', summary: '', sessionId: 'sess-combo'
    }, PORT);
    await request('POST', '/skill-feedback', {
      skillName: 'combo:skill', type: 'correction', summary: 'y', sessionId: 'sess-combo'
    }, PORT);

    const res = await request('GET', '/skill-feedback/signals?sessionId=sess-combo&type=activation', null, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.length >= 1);
    assert.ok(res.body.every(s => s.sessionId === 'sess-combo' && s.type === 'activation'));
  });

  it('preserves checkpointId in round-trip', async () => {
    await request('POST', '/skill-feedback', {
      skillName: 'cp:skill', type: 'dismissal', summary: 'override',
      checkpointId: 'design-spec', sessionId: 'sess-cp'
    }, PORT);

    const res = await request('GET', '/skill-feedback/signals?sessionId=sess-cp', null, PORT);
    assert.equal(res.status, 200);
    const match = res.body.find(s => s.skillName === 'cp:skill' && s.checkpointId === 'design-spec');
    assert.ok(match, 'Should find signal with checkpointId');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/server.test.js`
Expected: New tests FAIL — `GET /skill-feedback/signals` returns 404

- [ ] **Step 3: Wire the endpoint into `server.js`**

In `server/server.js`, add the new endpoint in the skill feedback section. Insert after the `GET /skill-health` block (after line 985) and before the `POST /skill-feedback` block:

```js
  if (method === 'GET' && (url === '/skill-feedback/signals' || url.startsWith('/skill-feedback/signals?'))) {
    const params = new URL(url, 'http://localhost').searchParams;
    const sessionId = params.get('sessionId');
    const skillName = params.get('skillName');
    const type = params.get('type');

    let signals;
    if (sessionId) {
      signals = skillFeedback.getSignalsForSession(sessionId, { type: type || undefined });
      if (skillName) signals = signals.filter(s => s.skillName === skillName);
    } else if (skillName) {
      signals = skillFeedback.getSignalsForSkill(skillName);
      if (type) signals = signals.filter(s => s.type === type);
    } else {
      signals = skillFeedback.getSignalsForSession(null, {});
    }

    return respond(res, 200, signals);
  }
```

**Important:** This task also adds `getAllSignals` to `server/skill-feedback.js` (needed for the no-filter case). Add this function before `module.exports`:

```js
function getAllSignals(options) {
  const includeResolved = options && options.includeResolved;
  const typeFilter = options && options.type;
  const signals = readAllSignals();
  return signals.filter(s => {
    if (!includeResolved && s.resolved) return false;
    if (typeFilter && s.type !== typeFilter) return false;
    return true;
  });
}
```

Update `module.exports` to include both new functions:

```js
module.exports = { recordSignal, getThresholds, getHealth, clearSkill, getSignalsForSkill, getSignalsForSession, getAllSignals, recount, _setBaseDir };
```

Then use `getAllSignals` in the endpoint for the no-filter fallback. The complete endpoint code:

```js
  if (method === 'GET' && (url === '/skill-feedback/signals' || url.startsWith('/skill-feedback/signals?'))) {
    const params = new URL(url, 'http://localhost').searchParams;
    const sessionId = params.get('sessionId');
    const skillName = params.get('skillName');
    const type = params.get('type');

    let signals;
    if (sessionId) {
      signals = skillFeedback.getSignalsForSession(sessionId, { type: type || undefined });
      if (skillName) signals = signals.filter(s => s.skillName === skillName);
    } else if (skillName) {
      signals = skillFeedback.getSignalsForSkill(skillName);
      if (type) signals = signals.filter(s => s.type === type);
    } else {
      signals = skillFeedback.getAllSignals({ type: type || undefined });
    }

    return respond(res, 200, signals);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/server.test.js`
Expected: All tests PASS (new and existing)

- [ ] **Step 5: Commit**

```bash
git add server/skill-feedback.js server/server.js tests/server.test.js
git commit -m "feat: add GET /skill-feedback/signals query endpoint"
```

---

### Task 4: Add `getAllSignals` Unit Tests

**Files:**
- Modify: `tests/skill-feedback.test.js`

- [ ] **Step 1: Write tests for `getAllSignals`**

Add a new describe block to `tests/skill-feedback.test.js`:

```js
  describe('getAllSignals', () => {
    it('returns all unresolved signals', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '1', sessionId: 's1' });
      feedbackModule.recordSignal({ skillName: 'b:skill', type: 'activation', summary: '', sessionId: 's2' });

      const signals = feedbackModule.getAllSignals();
      assert.equal(signals.length, 2);
    });

    it('filters by type', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '1' });
      feedbackModule.recordSignal({ skillName: 'b:skill', type: 'activation', summary: '' });
      feedbackModule.recordSignal({ skillName: 'c:skill', type: 'dismissal', summary: 'skip', checkpointId: 'cp1' });

      const signals = feedbackModule.getAllSignals({ type: 'dismissal' });
      assert.equal(signals.length, 1);
      assert.equal(signals[0].type, 'dismissal');
    });

    it('excludes resolved signals by default', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '1' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '2' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '3' });
      feedbackModule.clearSkill('a:skill');

      const signals = feedbackModule.getAllSignals();
      assert.equal(signals.length, 0);
    });

    it('includes resolved when requested', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '1' });
      feedbackModule.clearSkill('a:skill');

      const signals = feedbackModule.getAllSignals({ includeResolved: true });
      assert.equal(signals.length, 1);
    });
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --test tests/skill-feedback.test.js`
Expected: All tests PASS (these test the function added in Task 3)

- [ ] **Step 3: Commit**

```bash
git add tests/skill-feedback.test.js
git commit -m "test: add unit tests for getAllSignals"
```

---

### Task 5: Update Debrief SKILL.md with Step 0.5

**Files:**
- Modify: `skills/debrief/SKILL.md`

- [ ] **Step 1: Read current debrief for insertion point**

Read `skills/debrief/SKILL.md` to confirm the structure. Step 0.5 goes between the "## Process" heading and the existing "### Step 1: Session Scan".

- [ ] **Step 2: Insert Step 0.5 into the debrief skill**

After the line `## Process` and before `### Step 1: Session Scan`, insert:

```markdown
### Step 0.5: Automated Deviation Check

Before the freeform session scan, run structured checkpoint evaluation against skills that were activated this session.

**1. Query activated skills:**

```bash
curl -s "http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-feedback/signals?sessionId=${CLAUDE_SESSION_ID}&type=activation"
```

This returns an array of activation signals. Extract the unique `skillName` values — these are the skills to check.

**Early exit:** If no skills were activated this session, skip to Step 1.

**2. For each activated skill, read its checkpoints:**

Find the SKILL.md file (check both plugin cache and project-local `.claude/skills/`):

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/*/superpowers/*/ 2>/dev/null | sort -V | tail -1)
# Check: $PLUGIN_DIR/skills/<skill-name>/SKILL.md
# Also check: .claude/skills/<skill-name>/SKILL.md
```

Parse the YAML frontmatter for a `checkpoints` key. If no checkpoints defined, skip this skill.

**3. Evaluate each checkpoint against conversation history:**

| Check type | How to evaluate |
|---|---|
| `tool_used` | Scan your conversation for tool calls matching the `value` (e.g., `TaskCreate`, `Bash`) |
| `file_pattern` | Scan Write/Edit tool calls for file paths matching the glob pattern in `value`. Pipe-delimited patterns mean match ANY. |
| `keyword` | Scan user messages for text matching the regex pattern in `value`. Pipe-delimited alternatives. |

Mark each checkpoint as **met** or **unmet**.

**4. Filter auto-suppressed checkpoints:**

For each unmet checkpoint, query for prior dismissals:

```bash
curl -s "http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-feedback/signals?skillName=<skill-name>"
```

Count signals where `type` is `"dismissal"` and `checkpointId` matches this checkpoint's `id`. If 3 or more dismissals, auto-suppress:

> *Auto-suppressed: "<label>" has been dismissed N times previously.*

**5. Present unmet checkpoints as questions:**

For each unmet, non-suppressed checkpoint, ask:

> **[skill-name]** was activated but: *<label>* — was this intentional?
> - **Yes, intentional** (user override / not applicable) → record dismissal
> - **No, that was a deviation** → record correction

**6. Post signals for each response:**

Confirmed deviation:
```bash
curl -s -X POST http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName":"<skill-name>","type":"correction","summary":"<label>","checkpointId":"<id>","sessionId":"<session-id>"}'
```

Dismissed:
```bash
curl -s -X POST http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName":"<skill-name>","type":"dismissal","summary":"User override — <label>","checkpointId":"<id>","sessionId":"<session-id>"}'
```

**7. Continue to Step 1.** The automated check surfaces mechanical deviations; the freeform session scan in Step 1 catches judgment-based issues.
```

- [ ] **Step 3: Commit**

```bash
git add skills/debrief/SKILL.md
git commit -m "feat: add automated deviation check (Step 0.5) to debrief skill"
```

---

### Task 6: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the new endpoint to the Architecture section**

In `CLAUDE.md`, update the `server/server.js` endpoint list to include `/skill-feedback/signals`. Find the line that lists the server endpoints and add `/skill-feedback/signals` to the list. The line currently reads:

```
- `server/server.js` — HTTP server: `/health`, `/activate`, `/pre-tool`, `/enforce`, `/enforce-tool`, `/post-tool`, `/pre-write`, `/stop`, `/register-session`, `/pause`, `/resume`, `/skill-feedback`, `/skill-health`, `/skill-feedback/clear` (`/set-project` deprecated)
```

Update to:

```
- `server/server.js` — HTTP server: `/health`, `/activate`, `/pre-tool`, `/enforce`, `/enforce-tool`, `/post-tool`, `/pre-write`, `/stop`, `/register-session`, `/pause`, `/resume`, `/skill-feedback`, `/skill-health`, `/skill-feedback/clear`, `/skill-feedback/signals` (`/set-project` deprecated)
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add /skill-feedback/signals endpoint to CLAUDE.md"
```

---

### Task 7: Run Full Test Suite and Verify

**Files:**
- All modified files

- [ ] **Step 1: Run all tests**

Run: `node --test tests/*.test.js`
Expected: All tests PASS

- [ ] **Step 2: Verify the new endpoint manually**

```bash
node server/server.js &
sleep 1

# Record some test signals
curl -s -X POST http://localhost:19750/skill-feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName":"test:manual","type":"activation","summary":"","sessionId":"manual-test"}'

curl -s -X POST http://localhost:19750/skill-feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName":"test:manual","type":"dismissal","summary":"override","checkpointId":"cp-1","sessionId":"manual-test"}'

# Query by session
curl -s "http://localhost:19750/skill-feedback/signals?sessionId=manual-test" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');console.log(JSON.parse(d).length, 'signals')"

# Query by type
curl -s "http://localhost:19750/skill-feedback/signals?type=dismissal" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const s=JSON.parse(d);console.log(s.length, 'dismissals');console.log('checkpointId:', s[0] && s[0].checkpointId)"

# Cleanup
kill %1 2>/dev/null || true
```

Expected: 2 signals for session query, dismissal query shows `checkpointId: cp-1`

- [ ] **Step 3: Final commit**

```bash
git add -A
git status
# If any unstaged changes remain, stage them
git commit -m "feat: deviation detection — checkpoint-based passive monitoring at debrief time [release]"
```
