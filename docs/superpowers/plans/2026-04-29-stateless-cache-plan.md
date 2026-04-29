# Stateless Per-Request Cache — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Verification gate:** After each task, run `node --test tests/server.test.js` and confirm all tests pass before moving to the next task. Do not proceed if tests are failing — fix the issue first.

**Goal:** Eliminate stale-state bugs by making the skill-engine server derive project context and rule freshness per-request instead of holding module-level singleton state.

**Architecture:** Replace file watchers and `/reload` with an mtime-gated `RuleCache` class. Each handler derives `projectRoot` from the request environment instead of reading globals. Session state is keyed by `(sessionId, projectRoot)`. The duplicated route dispatch code is consolidated into a table-driven loop.

**Tech Stack:** Node.js built-in modules only (http, fs, path, os). No dependencies.

---

### Task 1: Add RuleCache class and mtime-gated loading

**Files:**
- Modify: `server/server.js:59-149` (replace module-level cache globals and `loadAndCompile` with `RuleCache` class)

- [ ] **Step 1: Write the failing test — mtime-based auto-reload**

Add a new test suite to `tests/server.test.js` that verifies the server picks up rule changes without a `/reload` call. This is the core behavioral change.

```js
describe('Mtime-Based Auto-Reload', () => {
  let serverProcess;
  let tmpDir;
  let rulesDir;
  let rulesFile;
  const PORT = 19766;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-mtime-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    rulesFile = path.join(rulesDir, 'skill-rules.json');
    fs.writeFileSync(rulesFile, JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'old-rule': {
          type: 'domain',
          description: 'Old rule',
          triggers: { prompt: { keywords: ['old'] } }
        }
      }
    }));
    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT)], {
      stdio: 'pipe',
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir }
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

  it('picks up rule file changes without reload', async () => {
    const before = await request('POST', '/activate', { prompt: 'old keyword here' }, PORT);
    assert.ok(before.body.hookSpecificOutput.additionalContext.includes('old-rule'), 'old-rule should match before change');

    // Overwrite rules file — ensure mtime changes (some OS have 1s resolution)
    const newRules = {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'new-rule': {
          type: 'domain',
          description: 'New rule',
          triggers: { prompt: { keywords: ['new'] } }
        }
      }
    };
    // Ensure mtime differs: wait 1.1s for filesystems with 1s mtime resolution
    await new Promise(r => setTimeout(r, 1100));
    fs.writeFileSync(rulesFile, JSON.stringify(newRules));

    const oldCheck = await request('POST', '/activate', { prompt: 'old keyword here' }, PORT);
    assert.ok(!oldCheck.body.hookSpecificOutput, 'old-rule should not match after file change');

    const newCheck = await request('POST', '/activate', { prompt: 'new keyword here' }, PORT);
    assert.ok(newCheck.body.hookSpecificOutput.additionalContext.includes('new-rule'), 'new-rule should match after file change');
  });
});
```

Append this to the end of `tests/server.test.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server.test.js`
Expected: The new `Mtime-Based Auto-Reload` test fails because the server currently requires `--rules-dir` and doesn't auto-reload on mtime change.

- [ ] **Step 3: Implement RuleCache class**

In `server/server.js`, replace the module-level cache globals (lines 59-64) and `loadAndCompile()` function (lines 125-149) with a `RuleCache` class. Also remove `RULES_DIR`, `PROJECT_ROOT`, `deriveProjectRoot()`, and `argVal()`.

Replace the entire block from line 13 (`function argVal`) through line 149 (end of `loadAndCompile`) with:

```js
const PORT = (() => {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return parseInt(process.env.SKILL_ENGINE_PORT || '19750', 10);
})();
const IS_WIN = process.platform === 'win32';

// --- Version from plugin.json (read once at startup) ---
const PLUGIN_JSON = path.resolve(__dirname, '..', '.claude-plugin', 'plugin.json');
let SERVER_VERSION = 'unknown';
try {
  SERVER_VERSION = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).version || 'unknown';
} catch {}

// --- Response timing ---
let totalResponseTimeNs = BigInt(0);
let timedResponses = 0;

// --- Priority helpers ---
const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
function getPriority(rule, defaults) {
  return rule.priority || (defaults && defaults.priority) || 'medium';
}
function getEnforcement(rule, defaults) {
  return rule.enforcement || (defaults && defaults.enforcement) || 'suggest';
}

// --- Mtime-gated rule cache ---
class RuleCache {
  constructor() {
    this._rulesDir = null;
    this._mainMtime = null;
    this._learnedMtime = null;
    this._compiledRules = [];
    this._rulesData = { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {} };
    this._hasToolTriggerRules = false;
    this._hasOutputTriggerRules = false;
    this._hasStopRules = false;
  }

  getRules(rulesDir) {
    const mainPath = rulesDir ? path.join(rulesDir, 'skill-rules.json') : null;
    const learnedPath = rulesDir ? path.join(rulesDir, 'learned-rules.json') : null;

    let mainMtime = null;
    let learnedMtime = null;
    try { mainMtime = mainPath ? fs.statSync(mainPath).mtimeMs : null; } catch {}
    try { learnedMtime = learnedPath ? fs.statSync(learnedPath).mtimeMs : null; } catch {}

    const dirChanged = rulesDir !== this._rulesDir;
    const mtimeChanged = mainMtime !== this._mainMtime || learnedMtime !== this._learnedMtime;

    if (!dirChanged && !mtimeChanged) {
      return {
        compiledRules: this._compiledRules,
        rulesData: this._rulesData,
        hasToolTriggerRules: this._hasToolTriggerRules,
        hasOutputTriggerRules: this._hasOutputTriggerRules,
        hasStopRules: this._hasStopRules,
      };
    }

    // Recompile
    this._rulesDir = rulesDir;
    this._mainMtime = mainMtime;
    this._learnedMtime = learnedMtime;

    const mainData = loadRules(mainPath);
    const learnedData = loadRules(learnedPath);

    if (!mainData && !learnedData) {
      this._rulesData = { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {} };
    } else if (!mainData) {
      this._rulesData = { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: learnedData.rules };
    } else {
      this._rulesData = { ...mainData };
      if (learnedData) {
        this._rulesData.rules = { ...learnedData.rules, ...mainData.rules };
      }
    }

    this._compiledRules = compileRules(this._rulesData);
    this._hasToolTriggerRules = this._compiledRules.some(e => e.toolTriggerNamesSet || (e.inputRe && e.inputRe.length));
    this._hasOutputTriggerRules = this._compiledRules.some(e => e.outputToolNamesSet || (e.outputRe && e.outputRe.length));
    this._hasStopRules = this._compiledRules.some(e => e.hookEventsSet && e.hookEventsSet.has('Stop'));

    return {
      compiledRules: this._compiledRules,
      rulesData: this._rulesData,
      hasToolTriggerRules: this._hasToolTriggerRules,
      hasOutputTriggerRules: this._hasOutputTriggerRules,
      hasStopRules: this._hasStopRules,
    };
  }
}

const ruleCache = new RuleCache();
```

Note: `compileRules()` stays exactly as-is (lines 66-123 in the original). Move the tri-state flag computation (`hasToolTriggerRules`, etc.) out of `compileRules()` and into `RuleCache.getRules()` as shown above. `compileRules()` should just return the compiled array without setting globals.

Update `compileRules()` to remove the three global assignments at the end (lines 118-120):

```js
function compileRules(data) {
  if (!data || !data.rules) return [];
  const compiled = [];
  for (const [name, rule] of Object.entries(data.rules)) {
    // ... same loop body as before ...
    compiled.push(entry);
  }
  // Removed: hasToolTriggerRules, hasOutputTriggerRules, hasStopRules assignments
  return compiled;
}
```

- [ ] **Step 4: Add getRequestContext helper**

Add this function after the `RuleCache` class in `server/server.js`:

```js
function getRequestContext(input) {
  const projectDir = (input && input.env && input.env.CLAUDE_PROJECT_DIR)
                     || process.env.CLAUDE_PROJECT_DIR
                     || null;
  const rulesDir = projectDir ? normalizePath(projectDir) + '/.claude/skills' : null;
  const projectRoot = projectDir ? normalizePath(projectDir) : null;
  const cached = ruleCache.getRules(rulesDir);
  return { projectRoot, rulesDir, ...cached };
}

function ruleMatchesProject(entry, projectRoot) {
  if (!entry.sourceRepo) return true;
  if (!projectRoot) return true;
  if (IS_WIN) return entry.sourceRepo.toLowerCase() === projectRoot.toLowerCase();
  return entry.sourceRepo === projectRoot;
}
```

Note: `ruleMatchesProject` now takes `projectRoot` as a parameter instead of reading the global.

- [ ] **Step 5: Run test to check progress**

Run: `node --test tests/server.test.js`
Expected: The new mtime test may still fail because handlers haven't been updated to use `getRequestContext` yet. That's fine — we'll update them in Task 2.

- [ ] **Step 6: Commit**

```bash
git add server/server.js tests/server.test.js
git commit -m "feat: add RuleCache class with mtime-gated loading"
```

---

### Task 2: Update all handlers to use per-request context

**Files:**
- Modify: `server/server.js:188-411` (all handler functions) and `server/server.js:677-733` (handlePreWrite)

Every handler currently reads from module-level globals (`compiledRules`, `rulesData`, `PROJECT_ROOT`). Update each one to call `getRequestContext(input)` and use the returned context.

- [ ] **Step 1: Update matchFileCompiled to accept projectRoot parameter**

Change the signature and body:

```js
function matchFileCompiled(filePath, entry, projectRoot, rulesData) {
  let normalized = normalizePath(filePath);
  if (projectRoot) {
    const root = IS_WIN ? projectRoot.toLowerCase() : projectRoot;
    const test = IS_WIN ? normalized.toLowerCase() : normalized;
    if (test.startsWith(root + '/')) {
      normalized = normalized.slice(projectRoot.length + 1);
    }
  }
  if (entry.exclRe && entry.exclRe.some(re => re.test(normalized))) return false;
  if (!entry.pathRe || !entry.pathRe.length) return false;
  if (!entry.pathRe.some(re => re.test(normalized))) return false;
  const enforcement = getEnforcement(entry.rule, rulesData.defaults);
  if (enforcement === 'block' && entry.contentRe && entry.contentRe.length) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return entry.contentRe.some(re => re.test(content));
    } catch { return false; }
  }
  return true;
}
```

- [ ] **Step 2: Update handleActivate**

```js
function handleActivate(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const prompt = input && input.prompt;
  if (!prompt) return {};

  const ctx = getRequestContext(input);
  const session = getSession(input.session_id, ctx.projectRoot);
  const matches = [];

  for (const entry of ctx.compiledRules) {
    if (!ruleMatchesProject(entry, ctx.projectRoot)) continue;
    if (checkSkip(entry.name, entry.rule, session)) continue;
    if (!entry.keywordsLower && !entry.intentRe) continue;
    if (!matchPromptCompiled(prompt, entry)) continue;
    const priority = getPriority(entry.rule, ctx.rulesData.defaults);
    const enforcement = getEnforcement(entry.rule, ctx.rulesData.defaults);
    matches.push({ name: entry.name, rule: entry.rule, priority, enforcement });
  }

  if (!matches.length) return {};

  matches.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));

  if (session) {
    for (const m of matches) {
      if (m.rule.skipConditions && m.rule.skipConditions.sessionOnce) {
        session.firedRules.add(m.name);
      }
    }
  }

  const count = matches.length;
  const lines = [
    '⚡ Skill Engine — ' + count + ' relevant skill' + (count > 1 ? 's' : '') + ' detected:',
    ''
  ];
  for (const m of matches) {
    const typeLabel = m.rule.type === 'guardrail' ? ' (guardrail)' : '';
    lines.push('[' + m.priority.toUpperCase() + '] ' + m.name + typeLabel);
    lines.push('  ' + m.rule.description);
    if (m.rule.skillPath) lines.push('  → Read: ' + m.rule.skillPath);
    lines.push('');
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: lines.join('\n')
    }
  };
}
```

- [ ] **Step 3: Update handleEnforceTool**

```js
function handleEnforceTool(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const ctx = getRequestContext(input);
  if (!ctx.hasToolTriggerRules) return {};
  const toolName = input && input.tool_name;
  const toolInput = input && input.tool_input;
  if (!toolName && !toolInput) return {};

  const inputStr = toolInput ? JSON.stringify(toolInput) : '';
  const session = getSession(input.session_id, ctx.projectRoot);
  const matches = [];

  for (const entry of ctx.compiledRules) {
    if (!ruleMatchesProject(entry, ctx.projectRoot)) continue;
    if (!entry.toolTriggerNamesSet && (!entry.inputRe || !entry.inputRe.length)) continue;
    if (entry.rule.type !== 'guardrail') continue;
    const enforcement = getEnforcement(entry.rule, ctx.rulesData.defaults);
    if (enforcement !== 'block' && enforcement !== 'warn') continue;
    if (checkSkip(entry.name, entry.rule, session)) continue;
    if (entry.toolTriggerNamesSet && toolName && !entry.toolTriggerNamesSet.has(toolName)) continue;
    if (entry.toolTriggerNamesSet && !toolName) continue;
    if (entry.inputRe && entry.inputRe.length && !entry.inputRe.some(re => re.test(inputStr))) continue;
    const priority = getPriority(entry.rule, ctx.rulesData.defaults);
    matches.push({ name: entry.name, rule: entry.rule, priority, enforcement });
  }

  if (!matches.length) return {};

  matches.sort((a, b) => {
    if (a.enforcement === 'block' && b.enforcement !== 'block') return -1;
    if (a.enforcement !== 'block' && b.enforcement === 'block') return 1;
    return (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2);
  });

  const blockMatch = matches.find(m => m.enforcement === 'block');
  if (blockMatch) {
    const reason = blockMatch.rule.blockMessage || ('Blocked by rule: ' + blockMatch.name);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason
      }
    };
  }

  const warnings = matches
    .filter(m => m.enforcement === 'warn')
    .map(m => '⚠️ ' + m.name + ': ' + m.rule.description);
  const joined = warnings.join('\n');
  if (joined) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext: joined
      }
    };
  }
  return {};
}
```

- [ ] **Step 4: Update handlePostTool**

```js
function handlePostTool(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const ctx = getRequestContext(input);
  if (!ctx.hasOutputTriggerRules) return {};
  const toolName = input && input.tool_name;
  const toolOutput = input && input.tool_output;

  const outputStr = typeof toolOutput === 'string' ? toolOutput : (toolOutput ? JSON.stringify(toolOutput) : '');
  const session = getSession(input && input.session_id, ctx.projectRoot);
  const matches = [];

  for (const entry of ctx.compiledRules) {
    if (!ruleMatchesProject(entry, ctx.projectRoot)) continue;
    if (!entry.outputToolNamesSet && (!entry.outputRe || !entry.outputRe.length)) continue;
    if (checkSkip(entry.name, entry.rule, session)) continue;
    if (entry.outputToolNamesSet && toolName && !entry.outputToolNamesSet.has(toolName)) continue;
    if (entry.outputToolNamesSet && !toolName) continue;
    if (entry.outputRe && entry.outputRe.length && !entry.outputRe.some(re => re.test(outputStr))) continue;
    const priority = getPriority(entry.rule, ctx.rulesData.defaults);
    matches.push({ name: entry.name, rule: entry.rule, priority });
  }

  if (!matches.length) return {};

  matches.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));

  if (session) {
    for (const m of matches) {
      if (m.rule.skipConditions && m.rule.skipConditions.sessionOnce) {
        session.firedRules.add(m.name);
      }
    }
  }

  const lines = matches.map(m => m.rule.guidance || m.rule.description);
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: lines.join('\n')
    }
  };
}
```

- [ ] **Step 5: Update handleStop**

```js
function handleStop(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const ctx = getRequestContext(input);
  if (!ctx.hasStopRules) return {};

  const session = getSession(input && input.session_id, ctx.projectRoot);
  const matches = [];

  for (const entry of ctx.compiledRules) {
    if (!ruleMatchesProject(entry, ctx.projectRoot)) continue;
    if (!entry.hookEventsSet || !entry.hookEventsSet.has('Stop')) continue;
    if (checkSkip(entry.name, entry.rule, session)) continue;
    const priority = getPriority(entry.rule, ctx.rulesData.defaults);
    matches.push({ name: entry.name, rule: entry.rule, priority });
  }

  if (!matches.length) return {};

  matches.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));

  if (session) {
    for (const m of matches) {
      if (m.rule.skipConditions && m.rule.skipConditions.sessionOnce) {
        session.firedRules.add(m.name);
      }
    }
  }

  const lines = matches.map(m => m.rule.guidance || m.rule.description);
  return {
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: lines.join('\n')
    }
  };
}
```

- [ ] **Step 6: Update handleEnforce**

```js
function handleEnforce(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const filePath = input && input.tool_input && input.tool_input.file_path;
  if (!filePath) return {};
  const toolName = input && input.tool_name;
  const writeContent = input && input.tool_input && (input.tool_input.content || input.tool_input.new_string || '');

  const ctx = getRequestContext(input);
  const session = getSession(input.session_id, ctx.projectRoot);
  const matches = [];

  for (const entry of ctx.compiledRules) {
    if (!ruleMatchesProject(entry, ctx.projectRoot)) continue;
    if (entry.rule.type !== 'guardrail') continue;
    const enforcement = getEnforcement(entry.rule, ctx.rulesData.defaults);
    if (enforcement !== 'block' && enforcement !== 'warn') continue;
    if (!entry.pathRe || !entry.pathRe.length) continue;
    if (checkSkip(entry.name, entry.rule, session)) continue;
    if (entry.toolNamesSet && toolName && !entry.toolNamesSet.has(toolName)) continue;
    if (!matchFileCompiled(filePath, entry, ctx.projectRoot, ctx.rulesData)) continue;
    if (entry.contentRe && entry.contentRe.length > 0) {
      if (!writeContent) continue;
      const contentMatched = entry.contentRe.some(re => re.test(writeContent));
      if (!contentMatched) continue;
    }
    const priority = getPriority(entry.rule, ctx.rulesData.defaults);
    matches.push({ name: entry.name, rule: entry.rule, priority, enforcement });
  }

  if (!matches.length) return {};

  matches.sort((a, b) => {
    if (a.enforcement === 'block' && b.enforcement !== 'block') return -1;
    if (a.enforcement !== 'block' && b.enforcement === 'block') return 1;
    return (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2);
  });

  const blockMatch = matches.find(m => m.enforcement === 'block');
  if (blockMatch) {
    const reason = blockMatch.rule.blockMessage || ('Blocked by rule: ' + blockMatch.name);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason
      }
    };
  }

  const warnings = matches
    .filter(m => m.enforcement === 'warn')
    .map(m => '⚠️ ' + m.name + ': ' + m.rule.description);
  const joined = warnings.join('\n');
  if (joined) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext: joined
      }
    };
  }
  return {};
}
```

- [ ] **Step 7: Update handlePreWrite**

The `handlePreWrite` function uses `PROJECT_ROOT` and `process.env.CLAUDE_PROJECT_DIR` directly. Update it to use `getRequestContext`:

```js
function handlePreWrite(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};

  const toolInput = input && input.tool_input;
  if (!toolInput) return {};

  const filePath = toolInput.file_path || toolInput.file || '';
  if (!filePath) return {};

  const ctx = getRequestContext(input);
  const normalized = normalizePath(filePath);

  let relPath = normalized;
  if (ctx.projectRoot) {
    const normalizedRoot = ctx.projectRoot;
    const rootTest = IS_WIN ? normalizedRoot.toLowerCase() : normalizedRoot;
    const pathTest = IS_WIN ? normalized.toLowerCase() : normalized;
    if (pathTest.startsWith(rootTest + '/')) {
      relPath = normalized.slice(normalizedRoot.length + 1);
    }
  }

  let check = null;
  if (/^tasks\/.*\.json$/.test(relPath)) {
    check = 'task';
  } else if (/work-repo-staging\/.*ADFCreateAndPopulateSecurityModelConfig/.test(relPath)) {
    check = 'secmodel';
  }

  if (!check) return {};

  const content = toolInput.content || toolInput.new_string || '';
  if (!content) return {};

  const projectDir = ctx.projectRoot;
  const rules = loadSafetyRules(projectDir);

  if (check === 'task') {
    const result = validateTaskSteps(content, rules, projectDir);
    if (result) {
      return result.decision === 'deny' ? preWriteDeny(result.reason) : preWriteAsk(result.reason);
    }
  }

  if (check === 'secmodel') {
    const result = validateSecurityModelConfig(content, rules);
    if (result) {
      return result.decision === 'deny' ? preWriteDeny(result.reason) : preWriteAsk(result.reason);
    }
  }

  return {};
}
```

- [ ] **Step 8: Run all tests**

Run: `node --test tests/server.test.js`
Expected: Some existing tests will fail because they still spawn with `--rules-dir` which no longer exists. That's expected — we fix those in Task 4.

- [ ] **Step 9: Commit**

```bash
git add server/server.js
git commit -m "feat: update all handlers to use per-request context"
```

---

### Task 3: Project-scoped session keys and route table

**Files:**
- Modify: `server/server.js` (session management and request router)

- [ ] **Step 1: Write failing test — project-scoped sessionOnce**

Add to `tests/server.test.js`:

```js
describe('Project-Scoped Session State', () => {
  let serverProcess;
  let tmpDirA;
  let tmpDirB;
  const PORT = 19767;

  before(async () => {
    tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'se-sess-a-'));
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'se-sess-b-'));
    const rulesDirA = path.join(tmpDirA, '.claude', 'skills');
    const rulesDirB = path.join(tmpDirB, '.claude', 'skills');
    fs.mkdirSync(rulesDirA, { recursive: true });
    fs.mkdirSync(rulesDirB, { recursive: true });
    const rules = JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'once-rule': {
          type: 'domain',
          description: 'Session once rule',
          triggers: { prompt: { keywords: ['trigger'] } },
          skipConditions: { sessionOnce: true }
        }
      }
    });
    fs.writeFileSync(path.join(rulesDirA, 'skill-rules.json'), rules);
    fs.writeFileSync(path.join(rulesDirB, 'skill-rules.json'), rules);

    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT)], {
      stdio: 'pipe',
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDirA }
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
    fs.rmSync(tmpDirA, { recursive: true, force: true });
    fs.rmSync(tmpDirB, { recursive: true, force: true });
  });

  it('sessionOnce rule fires again in different project context', async () => {
    // Fire in project A
    const firstA = await request('POST', '/activate', {
      prompt: 'trigger keyword',
      session_id: 'shared-sess',
      env: { CLAUDE_PROJECT_DIR: tmpDirA }
    }, PORT);
    assert.ok(firstA.body.hookSpecificOutput, 'should fire in project A');

    // Second call in project A — should NOT fire (sessionOnce)
    const secondA = await request('POST', '/activate', {
      prompt: 'trigger keyword',
      session_id: 'shared-sess',
      env: { CLAUDE_PROJECT_DIR: tmpDirA }
    }, PORT);
    assert.ok(!secondA.body.hookSpecificOutput, 'should not fire again in project A');

    // First call in project B with same session — should fire again
    const firstB = await request('POST', '/activate', {
      prompt: 'trigger keyword',
      session_id: 'shared-sess',
      env: { CLAUDE_PROJECT_DIR: tmpDirB }
    }, PORT);
    assert.ok(firstB.body.hookSpecificOutput, 'should fire in project B despite same session_id');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server.test.js`
Expected: Fails because session keys don't include projectRoot yet.

- [ ] **Step 3: Update getSession to include projectRoot**

In `server/server.js`, replace the session management:

```js
const sessions = new Map();

function getSession(sessionId, projectRoot) {
  if (!sessionId) return null;
  const key = sessionId + '|' + (projectRoot || '');
  let s = sessions.get(key);
  if (!s) {
    s = { firedRules: new Set(), lastSeen: Date.now() };
    sessions.set(key, s);
  }
  s.lastSeen = Date.now();
  return s;
}
```

The cleanup function stays the same — it iterates all entries regardless of key format.

- [ ] **Step 4: Replace route dispatch boilerplate with route table**

Replace the entire block of 6 repeated `if (method === 'POST' && url === '/...')` blocks (lines ~794-888 in original) with:

```js
const routes = {
  '/activate':     { handler: handleActivate,    event: 'activate' },
  '/enforce':      { handler: handleEnforce,     event: 'enforce' },
  '/enforce-tool': { handler: handleEnforceTool, event: 'enforce-tool' },
  '/post-tool':    { handler: handlePostTool,    event: 'post-tool' },
  '/pre-write':    { handler: handlePreWrite,    event: 'pre-write' },
  '/stop':         { handler: handleStop,        event: 'stop' },
};

async function handleRequest(req, res) {
  const url = req.url;
  const method = req.method;
  const startNs = process.hrtime.bigint();

  if (method === 'GET' && url === '/health') {
    const ctx = getRequestContext(null);
    const avgMs = timedResponses > 0
      ? Number(totalResponseTimeNs / BigInt(timedResponses)) / 1e6
      : 0;
    return respond(res, 200, {
      version: SERVER_VERSION,
      pid: process.pid,
      uptime: process.uptime(),
      rulesLoaded: ctx.compiledRules.length,
      port: PORT,
      lastEvent,
      eventsProcessed,
      activeSessions: sessions.size,
      avgResponseTimeMs: Math.round(avgMs * 100) / 100,
      paused,
      rulesDir: ctx.rulesDir || null,
      projectRoot: ctx.projectRoot || null,
      hasToolTriggerRules: ctx.hasToolTriggerRules,
      hasOutputTriggerRules: ctx.hasOutputTriggerRules,
      hasStopRules: ctx.hasStopRules,
    });
  }

  const route = routes[url];
  if (method === 'POST' && route) {
    try {
      const body = await readBody(req);
      eventsProcessed++;
      lastEvent = route.event;
      const result = route.handler(body);
      const elapsed = process.hrtime.bigint() - startNs;
      totalResponseTimeNs += elapsed;
      timedResponses++;
      res.setHeader('X-Response-Time', (Number(elapsed) / 1e6).toFixed(2) + 'ms');
      return respond(res, 200, result);
    } catch {
      return respond(res, 400, { error: 'Invalid JSON' });
    }
  }

  if (method === 'POST' && url === '/pause') {
    paused = true;
    return respond(res, 200, { paused: true });
  }

  if (method === 'POST' && url === '/resume') {
    paused = false;
    return respond(res, 200, { paused: false });
  }

  if (method === 'POST') return respond(res, 200, {});
  respond(res, 404, { error: 'Not found' });
}
```

- [ ] **Step 5: Remove file watcher infrastructure and /reload endpoint**

Delete these sections entirely from `server/server.js`:
- The `/reload` route handler (previously around line 890)
- The `activeWatchers` variable, `closeWatchers()`, and `watchRuleFiles()` functions (previously lines 919-954)
- The `activeWatchers = watchRuleFiles();` call in the server listen callback
- The initial `loadAndCompile();` call before `http.createServer` (no longer needed — first request triggers compilation)

The server startup becomes:

```js
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    if (!res.writableEnded) respond(res, 500, { error: 'Internal error' });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('skill-engine server listening on port ' + PORT + '\n');
});
```

Also update the shutdown function to remove watcher cleanup:

```js
function shutdown() {
  clearInterval(cleanupInterval);
  server.close();
}
```

- [ ] **Step 6: Run tests**

Run: `node --test tests/server.test.js`
Expected: New tests pass. Many existing tests still fail due to `--rules-dir` CLI arg usage in test setup. That's Task 4.

- [ ] **Step 7: Commit**

```bash
git add server/server.js tests/server.test.js
git commit -m "feat: project-scoped sessions and route table dispatch"
```

---

### Task 4: Update existing tests for new server interface

**Files:**
- Modify: `tests/server.test.js`

The server no longer accepts `--rules-dir`. Tests must pass `CLAUDE_PROJECT_DIR` via env instead. The `Reload Endpoint` and `Reload with rulesDir` suites are replaced by the mtime auto-reload test from Task 1.

- [ ] **Step 1: Update test helper spawn to use env instead of --rules-dir**

Every test suite's `before()` block spawns the server with `--rules-dir`. Change all of them to use `CLAUDE_PROJECT_DIR` env var. The pattern changes from:

```js
// OLD
serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT), '--rules-dir', rulesDir], { stdio: 'pipe' });
```

to:

```js
// NEW
serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT)], {
  stdio: 'pipe',
  env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir }
});
```

Note: `tmpDir` not `rulesDir` — the env var points to the project root, not the `.claude/skills` subdirectory.

Apply this to every `describe` block:
- `Server Health` (PORT 19751): change spawn, use `tmpDir`
- `Activate Endpoint` (PORT 19752): change spawn, use `tmpDir`
- `Enforce Endpoint` (PORT 19753): change spawn, use `tmpDir`
- `Kill Switch` (PORT 19755): change spawn, use `tmpDir` (already has `env` override — merge `CLAUDE_PROJECT_DIR` into it)
- `Pause / Resume` (PORT 19756): change spawn, use `tmpDir`
- `Tool Name Filtering` (PORT 19757): change spawn, use `tmpDir`
- `Enforce-Tool Endpoint` (PORT 19759): change spawn, use `tmpDir`
- `Enforce-Tool Short-Circuit` (PORT 19760): change spawn, use `tmpDir`
- `Post-Tool Endpoint` (PORT 19761): change spawn, use `tmpDir`
- `Stop Endpoint` (PORT 19762): change spawn, use `tmpDir`
- `Pre-Write Endpoint — Task Safety` (PORT 19764): already uses `CLAUDE_PROJECT_DIR`, keep as-is
- `Pre-Write Endpoint — Security Model Config` (PORT 19765): already uses `CLAUDE_PROJECT_DIR`, keep as-is

- [ ] **Step 2: Remove Reload Endpoint test suite**

Delete the entire `describe('Reload Endpoint', ...)` block (PORT 19754). Its behavior is now covered by the `Mtime-Based Auto-Reload` test from Task 1.

- [ ] **Step 3: Replace Reload with rulesDir test suite with cross-project env switching test**

Delete the entire `describe('Reload with rulesDir', ...)` block (PORT 19758). Replace it with a test that verifies cross-project switching via the `env` field in the request body:

```js
describe('Cross-Project Env Switching', () => {
  let serverProcess;
  let tmpDirA;
  let tmpDirB;
  const PORT = 19758;

  before(async () => {
    tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'se-switch-a-'));
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'se-switch-b-'));
    const rulesDirA = path.join(tmpDirA, '.claude', 'skills');
    const rulesDirB = path.join(tmpDirB, '.claude', 'skills');
    fs.mkdirSync(rulesDirA, { recursive: true });
    fs.mkdirSync(rulesDirB, { recursive: true });
    fs.writeFileSync(path.join(rulesDirA, 'skill-rules.json'), JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'rule-a': { type: 'domain', description: 'Rule A', triggers: { prompt: { keywords: ['alpha'] } } } }
    }));
    fs.writeFileSync(path.join(rulesDirB, 'skill-rules.json'), JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'rule-b': { type: 'domain', description: 'Rule B', triggers: { prompt: { keywords: ['beta'] } } } }
    }));
    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT)], {
      stdio: 'pipe',
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDirA }
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
    fs.rmSync(tmpDirA, { recursive: true, force: true });
    fs.rmSync(tmpDirB, { recursive: true, force: true });
  });

  it('request with env.CLAUDE_PROJECT_DIR switches project context per-request', async () => {
    const resA = await request('POST', '/activate', {
      prompt: 'alpha keyword',
      env: { CLAUDE_PROJECT_DIR: tmpDirA }
    }, PORT);
    assert.ok(resA.body.hookSpecificOutput.additionalContext.includes('rule-a'), 'rule-a should match for project A');

    const resB = await request('POST', '/activate', {
      prompt: 'beta keyword',
      env: { CLAUDE_PROJECT_DIR: tmpDirB }
    }, PORT);
    assert.ok(resB.body.hookSpecificOutput.additionalContext.includes('rule-b'), 'rule-b should match for project B');

    const resBnoA = await request('POST', '/activate', {
      prompt: 'alpha keyword',
      env: { CLAUDE_PROJECT_DIR: tmpDirB }
    }, PORT);
    assert.ok(!resBnoA.body.hookSpecificOutput, 'rule-a should not match in project B context');
  });
});
```

- [ ] **Step 4: Update Cross-Repo Rule Isolation test suite**

This suite (PORT 19763) uses `/reload` to switch between repos. Rewrite it to use per-request `env.CLAUDE_PROJECT_DIR` instead:

In the `before()` block, change spawn to not use `--rules-dir`:

```js
serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT)], {
  stdio: 'pipe',
  env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDirA }
});
```

Update each test to pass `env` in the request body instead of calling `/reload`:

- `'rule with matching sourceRepo fires when server is in that repo'` — add `env: { CLAUDE_PROJECT_DIR: tmpDirA }` to the request body
- `'rule with non-matching sourceRepo is skipped after reload to different repo'` — remove the `/reload` call, instead pass `env: { CLAUDE_PROJECT_DIR: tmpDirB }` in the request body
- `'rule without sourceRepo (global) fires in any repo'` — pass `env: { CLAUDE_PROJECT_DIR: tmpDirB }` in the request body
- `'scoped activation rule is skipped in different repo'` — pass `env: { CLAUDE_PROJECT_DIR: tmpDirB }` in the request body
- `'global activation rule fires in any repo'` — pass `env: { CLAUDE_PROJECT_DIR: tmpDirB }` in the request body
- `'health shows projectRoot matching current repo'` — remove this test (health now shows the server's env-based default, not a per-request override)
- `'reload back to repo A re-enables scoped rules'` — rename to `'switching env back to repo A re-enables scoped rules'`, pass `env: { CLAUDE_PROJECT_DIR: tmpDirA }` instead of `/reload`

- [ ] **Step 5: Run all tests**

Run: `node --test tests/server.test.js`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/server.test.js
git commit -m "test: update all tests for per-request context (remove --rules-dir)"
```

---

### Task 5: Simplify start-server.sh

**Files:**
- Modify: `hooks/start-server.sh`

- [ ] **Step 1: Rewrite start-server.sh**

Replace the entire file with:

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

  _kill_pid() {
    if command -v powershell.exe >/dev/null 2>&1; then
      powershell.exe -NoProfile -Command "Stop-Process -Id $1 -Force -ErrorAction SilentlyContinue" 2>/dev/null
    else
      kill "$1" 2>/dev/null
    fi
  }

  if [ -n "$OLD_PID" ]; then
    _kill_pid "$OLD_PID"
    sleep 1
  else
    if command -v powershell.exe >/dev/null 2>&1; then
      powershell.exe -NoProfile -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort $PORT -ErrorAction SilentlyContinue).OwningProcess -Force -ErrorAction SilentlyContinue" 2>/dev/null
    elif command -v lsof >/dev/null 2>&1; then
      kill $(lsof -ti "tcp:$PORT") 2>/dev/null
    fi
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
nohup node "$SERVER_JS" --port "$PORT" > /dev/null 2>&1 &
disown

# Wait briefly for server to come up (max 3 seconds)
for i in 1 2 3; do
  sleep 1
  if curl -s --max-time 1 "http://localhost:$PORT/health" > /dev/null 2>&1; then
    exit 0
  fi
done

exit 0
```

Key changes from original:
- Removed `PROJECT_DIR` and `RULES_DIR` variables
- Removed the `/reload` curl call on same-version match (line 23-25 in original)
- Removed `--rules-dir "$RULES_DIR"` from the nohup launch command
- Everything else stays the same (version mismatch detection, cross-platform kill, health polling)

- [ ] **Step 2: Run all tests**

Run: `node --test tests/server.test.js`
Expected: All tests still pass. The test suite doesn't exercise start-server.sh directly.

- [ ] **Step 3: Run remaining test suites to check for regressions**

Run: `node --test tests/learn.test.js tests/glob-match.test.js tests/rules-io.test.js tests/skill-scaffold.test.js`
Expected: All pass (these don't touch the server).

- [ ] **Step 4: Commit**

```bash
git add hooks/start-server.sh
git commit -m "refactor: simplify start-server.sh — remove /reload and --rules-dir"
```

---

### Task 6: Update CLAUDE.md and final verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md architecture section**

In the `## Architecture` section, update the bullet for `server/server.js`:

Change:
```
- `server/server.js` — HTTP server: `/health`, `/activate`, `/enforce`, `/enforce-tool`, `/post-tool`, `/pre-write`, `/stop`, `/reload`, `/pause`, `/resume`
```

To:
```
- `server/server.js` — HTTP server: `/health`, `/activate`, `/enforce`, `/enforce-tool`, `/post-tool`, `/pre-write`, `/stop`, `/pause`, `/resume`
```

- [ ] **Step 2: Update Cross-Repo Rule Scoping section**

Replace the existing section with:

```markdown
## Cross-Repo Rule Scoping

Learned rules are auto-stamped with `sourceRepo` (the normalized `CLAUDE_PROJECT_DIR` at learn time). At enforcement time, each request derives its project root from `env.CLAUDE_PROJECT_DIR` (in the hook input) or `process.env.CLAUDE_PROJECT_DIR` (fallback). Rules with a `sourceRepo` that doesn't match the request's project root are skipped. Rules without `sourceRepo` are treated as global and match everywhere (backward compatible).
```

- [ ] **Step 3: Update Performance section**

Replace:
```
- Rules are pre-compiled at startup (regex patterns, keyword lowercase, toolNames Sets)
- No per-request allocation or I/O beyond the rule evaluation itself
```

With:
```
- Rules are compiled on first access and cached; `fs.statSync` (~0.1ms) on each request checks if rule files changed
- No recompilation unless file mtime actually changes
```

- [ ] **Step 4: Run full test suite one final time**

Run: `node --test tests/*.test.js`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for stateless per-request cache architecture"
```

---

### Task 7: Release commit

**Files:** None (commit only)

- [ ] **Step 1: Create release commit**

```bash
git commit --allow-empty -m "feat: stateless per-request cache — eliminate stale-state bugs [release]"
```

This triggers CI to bump the version in `plugin.json` and push to the marketplace.

- [ ] **Step 2: Push**

```bash
git push
```

- [ ] **Step 3: Pull version bump**

Wait for CI to complete (~1 minute), then:

```bash
git pull
```
