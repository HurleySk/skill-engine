# Learn Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break `/skill-engine:learn` into a triage router plus three sub-skills (learn-rule, learn-hook, learn-skill) with backing code modules.

**Architecture:** The existing `learn/SKILL.md` becomes a lightweight classifier that routes lessons to focused sub-skills. Each sub-skill has its own SKILL.md for conversation and a backing Node.js module for deterministic file I/O. `learn.js` gains `update` and `promote` methods. Two new modules (`hook-manager.js`, `skill-scaffold.js`) handle settings.json and SKILL.md generation respectively.

**Tech Stack:** Node.js (CommonJS, `node:test`), bash hook scripts, SKILL.md (Claude Code skill format)

---

### Task 1: Add `update` to learn.js

**Files:**
- Modify: `hooks/lib/learn.js:9-94` (add `update` function and export)
- Test: `tests/learn.test.js`

- [ ] **Step 1: Write failing tests for `update`**

Add a new `describe('update')` block in `tests/learn.test.js` after the existing `describe('remove')` block:

```javascript
describe('update', () => {
  let tmpDir;
  let learnedFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-test-'));
    learnedFile = path.join(tmpDir, 'learned-rules.json');
    // Seed a rule to update
    learn.add('sql-warn', {
      type: 'guardrail',
      enforcement: 'warn',
      priority: 'medium',
      description: 'Warn on SQL files',
      triggers: { file: { pathPatterns: ['**/*.sql'] } }
    }, learnedFile);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges new pathPatterns into existing triggers', () => {
    const result = learn.update('sql-warn', {
      triggers: { file: { pathPatterns: ['**/*.psql'] } }
    }, learnedFile);
    assert.equal(result.ok, true);
    const data = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    const patterns = data.rules['sql-warn'].triggers.file.pathPatterns;
    assert.deepEqual(patterns, ['**/*.sql', '**/*.psql']);
  });

  it('updates top-level fields without touching triggers', () => {
    const result = learn.update('sql-warn', {
      enforcement: 'block',
      priority: 'high'
    }, learnedFile);
    assert.equal(result.ok, true);
    const data = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    assert.equal(data.rules['sql-warn'].enforcement, 'block');
    assert.equal(data.rules['sql-warn'].priority, 'high');
    assert.deepEqual(data.rules['sql-warn'].triggers.file.pathPatterns, ['**/*.sql']);
  });

  it('adds prompt triggers to a rule that only had file triggers', () => {
    const result = learn.update('sql-warn', {
      triggers: { prompt: { keywords: ['sql', 'query'] } }
    }, learnedFile);
    assert.equal(result.ok, true);
    const data = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    assert.deepEqual(data.rules['sql-warn'].triggers.prompt.keywords, ['sql', 'query']);
    assert.deepEqual(data.rules['sql-warn'].triggers.file.pathPatterns, ['**/*.sql']);
  });

  it('errors when rule does not exist', () => {
    const result = learn.update('nonexistent', { enforcement: 'block' }, learnedFile);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('not found'));
  });

  it('errors when file does not exist', () => {
    const result = learn.update('anything', { enforcement: 'block' }, '/nonexistent/file.json');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('not found'));
  });

  it('normalizes backslash paths in updated triggers', () => {
    const result = learn.update('sql-warn', {
      triggers: { file: { pathPatterns: ['src\\db\\**\\*.psql'] } }
    }, learnedFile);
    assert.equal(result.ok, true);
    const data = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    assert.ok(data.rules['sql-warn'].triggers.file.pathPatterns.includes('src/db/**/*.psql'));
  });

  it('deduplicates pathPatterns on merge', () => {
    const result = learn.update('sql-warn', {
      triggers: { file: { pathPatterns: ['**/*.sql', '**/*.psql'] } }
    }, learnedFile);
    assert.equal(result.ok, true);
    const data = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    const patterns = data.rules['sql-warn'].triggers.file.pathPatterns;
    assert.equal(patterns.filter(p => p === '**/*.sql').length, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/learn.test.js 2>&1 | grep -E "(update|fail)"`
Expected: Multiple FAIL lines — `learn.update is not a function`

- [ ] **Step 3: Implement `update` in learn.js**

Add this function in `hooks/lib/learn.js` after the `remove` function (after line 92):

```javascript
function update(ruleName, updates, filePath) {
  const data = loadLearnedFile(filePath);
  if (!data || !data.rules[ruleName]) {
    return { ok: false, error: `Rule "${ruleName}" not found.` };
  }

  const rule = data.rules[ruleName];

  // Merge triggers specially — append arrays, don't replace
  if (updates.triggers) {
    if (!rule.triggers) rule.triggers = {};
    for (const [triggerType, triggerUpdates] of Object.entries(updates.triggers)) {
      if (!rule.triggers[triggerType]) {
        rule.triggers[triggerType] = triggerUpdates;
      } else {
        for (const [key, value] of Object.entries(triggerUpdates)) {
          if (Array.isArray(value) && Array.isArray(rule.triggers[triggerType][key])) {
            const merged = [...rule.triggers[triggerType][key], ...value];
            rule.triggers[triggerType][key] = [...new Set(merged)];
          } else {
            rule.triggers[triggerType][key] = value;
          }
        }
      }
    }
  }

  // Merge top-level fields (skip triggers — already handled)
  for (const [key, value] of Object.entries(updates)) {
    if (key !== 'triggers') {
      rule[key] = value;
    }
  }

  // Normalize paths after merge
  data.rules[ruleName] = normalizeTriggerPaths(rule);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true };
}
```

Update the `module.exports` line to include `update`:

```javascript
module.exports = { validateRule, normalizeTriggerPaths, loadLearnedFile, add, list, remove, update };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/learn.test.js`
Expected: All tests pass, 0 failures

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/learn.js tests/learn.test.js
git commit -m "feat: add update() to learn.js — merge triggers into existing rules"
```

---

### Task 2: Add `promote` to learn.js

**Files:**
- Modify: `hooks/lib/learn.js` (add `promote` function and export)
- Test: `tests/learn.test.js`

- [ ] **Step 1: Write failing tests for `promote`**

Add a new `describe('promote')` block in `tests/learn.test.js` after the `describe('update')` block:

```javascript
describe('promote', () => {
  let tmpDir;
  let learnedFile;
  let rulesFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-test-'));
    learnedFile = path.join(tmpDir, 'learned-rules.json');
    rulesFile = path.join(tmpDir, 'skill-rules.json');
    // Seed a learned rule
    learn.add('promote-me', {
      type: 'guardrail',
      enforcement: 'warn',
      priority: 'medium',
      description: 'A rule to promote',
      triggers: { file: { pathPatterns: ['**/*.sql'] } }
    }, learnedFile);
    // Seed an empty skill-rules.json
    fs.writeFileSync(rulesFile, JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {}
    }, null, 2), 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('moves rule from learned to skill-rules', () => {
    const result = learn.promote('promote-me', learnedFile, rulesFile);
    assert.equal(result.ok, true);
    const learned = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    assert.equal(learned.rules['promote-me'], undefined);
    const rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
    assert.ok(rules.rules['promote-me']);
    assert.equal(rules.rules['promote-me'].description, 'A rule to promote');
  });

  it('preserves existing rules in target file', () => {
    // Add an existing rule to target
    const rulesData = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
    rulesData.rules['existing'] = {
      type: 'domain',
      description: 'Already here',
      triggers: { prompt: { keywords: ['test'] } }
    };
    fs.writeFileSync(rulesFile, JSON.stringify(rulesData, null, 2), 'utf8');

    learn.promote('promote-me', learnedFile, rulesFile);
    const rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
    assert.ok(rules.rules['existing']);
    assert.ok(rules.rules['promote-me']);
  });

  it('errors when rule does not exist in source', () => {
    const result = learn.promote('nonexistent', learnedFile, rulesFile);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('not found'));
  });

  it('errors when source file does not exist', () => {
    const result = learn.promote('anything', '/nonexistent/file.json', rulesFile);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('not found'));
  });

  it('errors when rule name already exists in target', () => {
    const rulesData = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
    rulesData.rules['promote-me'] = {
      type: 'domain',
      description: 'Conflict',
      triggers: { prompt: { keywords: ['conflict'] } }
    };
    fs.writeFileSync(rulesFile, JSON.stringify(rulesData, null, 2), 'utf8');

    const result = learn.promote('promote-me', learnedFile, rulesFile);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('already exists'));
    // Source should be untouched
    const learned = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    assert.ok(learned.rules['promote-me']);
  });

  it('creates target file if it does not exist', () => {
    const newTarget = path.join(tmpDir, 'new-rules.json');
    const result = learn.promote('promote-me', learnedFile, newTarget);
    assert.equal(result.ok, true);
    const rules = JSON.parse(fs.readFileSync(newTarget, 'utf8'));
    assert.ok(rules.rules['promote-me']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/learn.test.js 2>&1 | grep -E "(promote|fail)"`
Expected: Multiple FAIL lines — `learn.promote is not a function`

- [ ] **Step 3: Implement `promote` in learn.js**

Add this function after `update` in `hooks/lib/learn.js`:

```javascript
function promote(ruleName, fromPath, toPath) {
  const sourceData = loadLearnedFile(fromPath);
  if (!sourceData || !sourceData.rules[ruleName]) {
    return { ok: false, error: `Rule "${ruleName}" not found in source file.` };
  }

  const rule = sourceData.rules[ruleName];

  // Load or create target
  let targetData = loadLearnedFile(toPath);
  if (!targetData) {
    targetData = { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {} };
  }

  if (targetData.rules[ruleName]) {
    return { ok: false, error: `Rule "${ruleName}" already exists in target file.` };
  }

  // Write target first — if this fails, source is untouched
  targetData.rules[ruleName] = rule;
  const targetDir = path.dirname(toPath);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(toPath, JSON.stringify(targetData, null, 2), 'utf8');

  // Remove from source
  delete sourceData.rules[ruleName];
  try {
    fs.writeFileSync(fromPath, JSON.stringify(sourceData, null, 2), 'utf8');
  } catch (err) {
    return { ok: false, error: `Rule added to target but failed to remove from source: ${err.message}` };
  }

  return { ok: true };
}
```

Update `module.exports` to include `promote`:

```javascript
module.exports = { validateRule, normalizeTriggerPaths, loadLearnedFile, add, list, remove, update, promote };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/learn.test.js`
Expected: All tests pass, 0 failures

- [ ] **Step 5: Add CLI support for `update` and `promote`**

In the `if (require.main === module)` block of `hooks/lib/learn.js`, add two new command branches before the `else` fallback:

```javascript
  } else if (command === 'update') {
    const ruleName = args[1];
    let updatesJson;
    try {
      updatesJson = JSON.parse(args[2]);
    } catch {
      process.stderr.write('Error: Invalid JSON for updates.\n');
      process.exit(1);
    }
    const result = update(ruleName, updatesJson, filePath);
    if (result.ok) {
      process.stdout.write(`Rule "${ruleName}" updated in ${filePath}\n`);
    } else {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(1);
    }
  } else if (command === 'promote') {
    const ruleName = args[1];
    // --to flag for target file
    const toIdx = args.indexOf('--to');
    let toPath;
    if (toIdx !== -1 && args[toIdx + 1]) {
      toPath = args[toIdx + 1];
    } else {
      const { findRulesFile } = require('./engine.js');
      const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
      const rulesFile = findRulesFile(cwd);
      toPath = rulesFile || path.join(cwd, '.claude', 'skills', 'skill-rules.json');
    }
    const result = promote(ruleName, filePath, toPath);
    if (result.ok) {
      process.stdout.write(`Rule "${ruleName}" promoted from ${filePath} to ${toPath}\n`);
    } else {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(1);
    }
```

Update the usage message:

```javascript
  } else {
    process.stderr.write('Usage: node learn.js <add|list|remove|update|promote> [args] [--file path]\n');
    process.exit(1);
  }
```

- [ ] **Step 6: Write CLI tests for update and promote**

Add to the `describe('CLI')` block in `tests/learn.test.js`:

```javascript
  it('update via CLI merges triggers', () => {
    // Seed a rule first
    const seedJson = JSON.stringify({
      type: 'guardrail', description: 'CLI update test',
      triggers: { file: { pathPatterns: ['**/*.sql'] } }
    });
    execSync(
      `node "${learnScript}" add cli-update '${seedJson}' --file "${learnedFile}"`,
      { encoding: 'utf8', shell: 'bash' }
    );
    const updateJson = JSON.stringify({
      triggers: { file: { pathPatterns: ['**/*.psql'] } }
    });
    const output = execSync(
      `node "${learnScript}" update cli-update '${updateJson}' --file "${learnedFile}"`,
      { encoding: 'utf8', shell: 'bash' }
    );
    assert.ok(output.includes('cli-update'));
    const data = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    assert.ok(data.rules['cli-update'].triggers.file.pathPatterns.includes('**/*.psql'));
    assert.ok(data.rules['cli-update'].triggers.file.pathPatterns.includes('**/*.sql'));
  });

  it('promote via CLI moves rule to target file', () => {
    const seedJson = JSON.stringify({
      type: 'guardrail', description: 'CLI promote test',
      triggers: { file: { pathPatterns: ['**/*.sql'] } }
    });
    execSync(
      `node "${learnScript}" add cli-promote '${seedJson}' --file "${learnedFile}"`,
      { encoding: 'utf8', shell: 'bash' }
    );
    const targetFile = path.join(tmpDir, 'skill-rules.json');
    fs.writeFileSync(targetFile, JSON.stringify({ version: '1.0', defaults: {}, rules: {} }), 'utf8');
    const output = execSync(
      `node "${learnScript}" promote cli-promote --file "${learnedFile}" --to "${targetFile}"`,
      { encoding: 'utf8', shell: 'bash' }
    );
    assert.ok(output.includes('promoted'));
    const target = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    assert.ok(target.rules['cli-promote']);
    const source = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    assert.equal(source.rules['cli-promote'], undefined);
  });
```

- [ ] **Step 7: Run all tests**

Run: `node --test tests/learn.test.js`
Expected: All tests pass, 0 failures

- [ ] **Step 8: Commit**

```bash
git add hooks/lib/learn.js tests/learn.test.js
git commit -m "feat: add promote() to learn.js, CLI support for update and promote"
```

---

### Task 3: Create hook-manager.js

**Files:**
- Create: `hooks/lib/hook-manager.js`
- Create: `tests/hook-manager.test.js`
- Create: `tests/fixtures/sample-settings.json`

- [ ] **Step 1: Create test fixture**

Create `tests/fixtures/sample-settings.json`:

```json
{
  "permissions": {
    "allow": ["Read", "Glob", "Grep"]
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/skill-engine/activate.sh\""
      }
    ],
    "PreToolUse": [
      {
        "matcher": ["Edit", "Write", "MultiEdit"],
        "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/skill-engine/enforce.sh\""
      }
    ]
  }
}
```

- [ ] **Step 2: Write failing tests**

Create `tests/hook-manager.test.js`:

```javascript
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const hookManager = require(path.resolve(__dirname, '..', 'hooks', 'lib', 'hook-manager.js'));

describe('validate', () => {
  it('accepts valid PreToolUse entry with matcher', () => {
    const result = hookManager.validate('PreToolUse', {
      command: 'bash run-lint.sh',
      matcher: ['Edit', 'Write']
    });
    assert.equal(result.ok, true);
  });

  it('accepts valid UserPromptSubmit entry without matcher', () => {
    const result = hookManager.validate('UserPromptSubmit', {
      command: 'bash check-prompt.sh'
    });
    assert.equal(result.ok, true);
  });

  it('rejects unknown hook type', () => {
    const result = hookManager.validate('InvalidHook', { command: 'bash foo.sh' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('Unknown hook type'));
  });

  it('rejects empty command', () => {
    const result = hookManager.validate('PreToolUse', { command: '' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('command'));
  });

  it('rejects missing command', () => {
    const result = hookManager.validate('PreToolUse', {});
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('command'));
  });

  it('rejects non-array matcher', () => {
    const result = hookManager.validate('PreToolUse', {
      command: 'bash foo.sh',
      matcher: 'Edit'
    });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('matcher'));
  });
});

describe('add', () => {
  let tmpDir;
  let settingsPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-mgr-'));
    settingsPath = path.join(tmpDir, 'settings.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates settings.json with hook entry when file does not exist', () => {
    const result = hookManager.add('PreToolUse', {
      command: 'bash lint.sh',
      matcher: ['Edit']
    }, settingsPath);
    assert.equal(result.ok, true);
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(data.hooks.PreToolUse.length, 1);
    assert.equal(data.hooks.PreToolUse[0].command, 'bash lint.sh');
  });

  it('appends to existing hook array without clobbering', () => {
    // Seed with existing settings
    const fixtureDir = path.resolve(__dirname, 'fixtures');
    const sample = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'sample-settings.json'), 'utf8'));
    fs.writeFileSync(settingsPath, JSON.stringify(sample, null, 2), 'utf8');

    const result = hookManager.add('PreToolUse', {
      command: 'bash lint-bicep.sh',
      matcher: ['Edit', 'Write']
    }, settingsPath);
    assert.equal(result.ok, true);
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(data.hooks.PreToolUse.length, 2);
    assert.equal(data.hooks.PreToolUse[1].command, 'bash lint-bicep.sh');
  });

  it('preserves non-hook settings keys', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['Read'] },
      hooks: {}
    }, null, 2), 'utf8');

    hookManager.add('UserPromptSubmit', { command: 'bash check.sh' }, settingsPath);
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(data.permissions, { allow: ['Read'] });
  });

  it('detects duplicate command in same hook type', () => {
    hookManager.add('PreToolUse', { command: 'bash lint.sh', matcher: ['Edit'] }, settingsPath);
    const result = hookManager.add('PreToolUse', { command: 'bash lint.sh', matcher: ['Edit'] }, settingsPath);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('duplicate'));
  });

  it('adds to empty hooks object', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2), 'utf8');
    const result = hookManager.add('PostToolUse', { command: 'bash post.sh' }, settingsPath);
    assert.equal(result.ok, true);
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(data.hooks.PostToolUse.length, 1);
  });

  it('adds hooks key to existing settings without hooks', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ permissions: {} }, null, 2), 'utf8');
    const result = hookManager.add('PreToolUse', { command: 'bash lint.sh' }, settingsPath);
    assert.equal(result.ok, true);
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(data.hooks.PreToolUse);
    assert.ok(data.permissions);
  });

  it('rejects invalid hook type via validation', () => {
    const result = hookManager.add('FakeHook', { command: 'bash foo.sh' }, settingsPath);
    assert.equal(result.ok, false);
  });
});

describe('list', () => {
  let tmpDir;
  let settingsPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-mgr-'));
    settingsPath = path.join(tmpDir, 'settings.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists all hook entries grouped by type', () => {
    const fixtureDir = path.resolve(__dirname, 'fixtures');
    fs.copyFileSync(path.join(fixtureDir, 'sample-settings.json'), settingsPath);
    const result = hookManager.list(settingsPath);
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('UserPromptSubmit'));
    assert.ok(result.output.includes('PreToolUse'));
    assert.ok(result.output.includes('activate.sh'));
  });

  it('returns empty message when no hooks', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2), 'utf8');
    const result = hookManager.list(settingsPath);
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('No hooks'));
  });

  it('returns empty message when file does not exist', () => {
    const result = hookManager.list('/nonexistent/settings.json');
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('No hooks'));
  });
});

describe('remove', () => {
  let tmpDir;
  let settingsPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-mgr-'));
    settingsPath = path.join(tmpDir, 'settings.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes hook entry by command match', () => {
    hookManager.add('PreToolUse', { command: 'bash lint.sh', matcher: ['Edit'] }, settingsPath);
    hookManager.add('PreToolUse', { command: 'bash fmt.sh', matcher: ['Write'] }, settingsPath);
    const result = hookManager.remove('PreToolUse', 'bash lint.sh', settingsPath);
    assert.equal(result.ok, true);
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(data.hooks.PreToolUse.length, 1);
    assert.equal(data.hooks.PreToolUse[0].command, 'bash fmt.sh');
  });

  it('errors when command not found', () => {
    hookManager.add('PreToolUse', { command: 'bash lint.sh' }, settingsPath);
    const result = hookManager.remove('PreToolUse', 'bash nonexistent.sh', settingsPath);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('not found'));
  });

  it('errors when hook type has no entries', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2), 'utf8');
    const result = hookManager.remove('PreToolUse', 'bash foo.sh', settingsPath);
    assert.equal(result.ok, false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/hook-manager.test.js 2>&1 | head -5`
Expected: Error — cannot find module `hook-manager.js`

- [ ] **Step 4: Implement hook-manager.js**

Create `hooks/lib/hook-manager.js`:

```javascript
'use strict';

const fs = require('fs');
const path = require('path');

const KNOWN_HOOK_TYPES = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop'
];

function validate(hookType, entry) {
  if (!KNOWN_HOOK_TYPES.includes(hookType)) {
    return { ok: false, error: `Unknown hook type: "${hookType}". Known types: ${KNOWN_HOOK_TYPES.join(', ')}` };
  }
  if (!entry || typeof entry.command !== 'string' || !entry.command.trim()) {
    return { ok: false, error: 'Hook entry must have a non-empty command string.' };
  }
  if (entry.matcher !== undefined && !Array.isArray(entry.matcher)) {
    return { ok: false, error: 'Hook matcher must be an array of strings.' };
  }
  if (entry.matcher && !entry.matcher.every(m => typeof m === 'string')) {
    return { ok: false, error: 'Hook matcher must be an array of strings.' };
  }
  return { ok: true };
}

function loadSettings(settingsPath) {
  if (!settingsPath || !fs.existsSync(settingsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return null;
  }
}

function saveSettings(settingsPath, data) {
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf8');
}

function add(hookType, entry, settingsPath) {
  const validation = validate(hookType, entry);
  if (!validation.ok) return validation;

  const settings = loadSettings(settingsPath) || {};
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks[hookType]) settings.hooks[hookType] = [];

  // Check for duplicate command
  const isDuplicate = settings.hooks[hookType].some(h => h.command === entry.command);
  if (isDuplicate) {
    return { ok: false, error: `A hook with this command already exists in ${hookType} (duplicate).` };
  }

  // Build clean entry — only include defined fields
  const clean = { command: entry.command };
  if (entry.matcher) clean.matcher = entry.matcher;

  settings.hooks[hookType].push(clean);
  saveSettings(settingsPath, settings);
  return { ok: true };
}

function list(settingsPath) {
  const settings = loadSettings(settingsPath);
  if (!settings || !settings.hooks || !Object.keys(settings.hooks).length) {
    return { ok: true, output: 'No hooks configured.' };
  }

  const lines = ['Hooks:', ''];
  for (const [hookType, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries) || !entries.length) continue;
    lines.push(`  ${hookType}:`);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      lines.push(`    [${i}] ${e.command}`);
      if (e.matcher) {
        lines.push(`        matcher: ${e.matcher.join(', ')}`);
      }
    }
    lines.push('');
  }
  return { ok: true, output: lines.join('\n') };
}

function remove(hookType, command, settingsPath) {
  const settings = loadSettings(settingsPath);
  if (!settings || !settings.hooks || !settings.hooks[hookType] || !settings.hooks[hookType].length) {
    return { ok: false, error: `No hooks found for type "${hookType}".` };
  }

  const idx = settings.hooks[hookType].findIndex(h => h.command === command);
  if (idx === -1) {
    return { ok: false, error: `Hook with command "${command}" not found in ${hookType}.` };
  }

  settings.hooks[hookType].splice(idx, 1);
  saveSettings(settingsPath, settings);
  return { ok: true };
}

module.exports = { validate, add, list, remove, KNOWN_HOOK_TYPES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  const fileIdx = args.indexOf('--file');
  let settingsPath;
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    settingsPath = args[fileIdx + 1];
  } else {
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    settingsPath = path.join(cwd, '.claude', 'settings.json');
  }

  if (command === 'add') {
    const hookType = args[1];
    let entry;
    try {
      entry = JSON.parse(args[2]);
    } catch {
      process.stderr.write('Error: Invalid JSON for hook entry.\n');
      process.exit(1);
    }
    const result = add(hookType, entry, settingsPath);
    if (result.ok) {
      process.stdout.write(`Hook added to ${hookType} in ${settingsPath}\n`);
    } else {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(1);
    }
  } else if (command === 'list') {
    const result = list(settingsPath);
    process.stdout.write(result.output + '\n');
  } else if (command === 'remove') {
    const hookType = args[1];
    const cmd = args[2];
    const result = remove(hookType, cmd, settingsPath);
    if (result.ok) {
      process.stdout.write(`Hook removed from ${hookType}\n`);
    } else {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(1);
    }
  } else {
    process.stderr.write('Usage: node hook-manager.js <add|list|remove> [args] [--file path]\n');
    process.exit(1);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/hook-manager.test.js`
Expected: All tests pass, 0 failures

- [ ] **Step 6: Commit**

```bash
git add hooks/lib/hook-manager.js tests/hook-manager.test.js tests/fixtures/sample-settings.json
git commit -m "feat: add hook-manager.js — CRUD for Claude Code hooks in settings.json"
```

---

### Task 4: Create skill-scaffold.js

**Files:**
- Create: `hooks/lib/skill-scaffold.js`
- Create: `tests/skill-scaffold.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/skill-scaffold.test.js`:

```javascript
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scaffold = require(path.resolve(__dirname, '..', 'hooks', 'lib', 'skill-scaffold.js'));

describe('validate', () => {
  it('accepts valid inputs', () => {
    const result = scaffold.validate('my-skill', 'A useful skill', 'Do the thing.');
    assert.equal(result.ok, true);
  });

  it('rejects empty name', () => {
    const result = scaffold.validate('', 'desc', 'body');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('name'));
  });

  it('rejects empty description', () => {
    const result = scaffold.validate('name', '', 'body');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('description'));
  });

  it('rejects empty body', () => {
    const result = scaffold.validate('name', 'desc', '');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('body'));
  });

  it('rejects multi-line description', () => {
    const result = scaffold.validate('name', 'line one\nline two', 'body');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('description'));
  });

  it('rejects description with frontmatter-breaking characters', () => {
    const result = scaffold.validate('name', 'has --- dashes', 'body');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('description'));
  });
});

describe('slugify', () => {
  it('converts spaces to hyphens', () => {
    assert.equal(scaffold.slugify('My Cool Skill'), 'my-cool-skill');
  });

  it('removes special characters', () => {
    assert.equal(scaffold.slugify('skill@v2.0!'), 'skillv20');
  });

  it('collapses multiple hyphens', () => {
    assert.equal(scaffold.slugify('a - - b'), 'a-b');
  });

  it('trims leading/trailing hyphens', () => {
    assert.equal(scaffold.slugify(' -hello- '), 'hello');
  });
});

describe('create', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates directory and SKILL.md with valid frontmatter', () => {
    const result = scaffold.create('Deploy Staging', 'Guide for staging deployments', 'Step 1: Do the thing.\n\nStep 2: Check it.', tmpDir);
    assert.equal(result.ok, true);
    assert.ok(result.path.endsWith('deploy-staging/SKILL.md'));
    const content = fs.readFileSync(result.path, 'utf8');
    assert.ok(content.startsWith('---\n'));
    assert.ok(content.includes('name: Deploy Staging'));
    assert.ok(content.includes('description: Guide for staging deployments'));
    assert.ok(content.includes('Step 1: Do the thing.'));
  });

  it('does not overwrite existing skill', () => {
    scaffold.create('my-skill', 'First version', 'Body 1.', tmpDir);
    const result = scaffold.create('my-skill', 'Second version', 'Body 2.', tmpDir);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('already exists'));
  });

  it('creates nested output directory if needed', () => {
    const nested = path.join(tmpDir, 'deep', 'nested');
    const result = scaffold.create('nested-skill', 'desc', 'body', nested);
    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(result.path));
  });
});

describe('list', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists all skills with name and description', () => {
    scaffold.create('skill-one', 'First skill', 'Body.', tmpDir);
    scaffold.create('skill-two', 'Second skill', 'Body.', tmpDir);
    const result = scaffold.list(tmpDir);
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('skill-one'));
    assert.ok(result.output.includes('First skill'));
    assert.ok(result.output.includes('skill-two'));
  });

  it('returns empty message when no skills exist', () => {
    const result = scaffold.list(tmpDir);
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('No skills'));
  });

  it('returns empty message for nonexistent directory', () => {
    const result = scaffold.list('/nonexistent/dir');
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('No skills'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/skill-scaffold.test.js 2>&1 | head -5`
Expected: Error — cannot find module `skill-scaffold.js`

- [ ] **Step 3: Implement skill-scaffold.js**

Create `hooks/lib/skill-scaffold.js`:

```javascript
'use strict';

const fs = require('fs');
const path = require('path');

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function validate(name, description, body) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'Skill name must be non-empty.' };
  }
  if (!description || typeof description !== 'string' || !description.trim()) {
    return { ok: false, error: 'Skill description must be non-empty.' };
  }
  if (description.includes('\n')) {
    return { ok: false, error: 'Skill description must be a single line.' };
  }
  if (description.includes('---')) {
    return { ok: false, error: 'Skill description must not contain "---" (breaks frontmatter).' };
  }
  if (!body || typeof body !== 'string' || !body.trim()) {
    return { ok: false, error: 'Skill body must be non-empty.' };
  }
  return { ok: true };
}

function create(name, description, body, outputDir) {
  const validation = validate(name, description, body);
  if (!validation.ok) return validation;

  const slug = slugify(name);
  const skillDir = path.join(outputDir, slug);
  const skillPath = path.join(skillDir, 'SKILL.md');

  if (fs.existsSync(skillPath)) {
    return { ok: false, error: `Skill "${slug}" already exists at ${skillPath}.` };
  }

  const content = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    body,
    ''
  ].join('\n');

  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillPath, content, 'utf8');
  return { ok: true, path: skillPath };
}

function list(outputDir) {
  if (!outputDir || !fs.existsSync(outputDir)) {
    return { ok: true, output: 'No skills found.' };
  }

  let entries;
  try {
    entries = fs.readdirSync(outputDir, { withFileTypes: true });
  } catch {
    return { ok: true, output: 'No skills found.' };
  }

  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(outputDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const content = fs.readFileSync(skillPath, 'utf8');
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const descMatch = content.match(/^description:\s*(.+)$/m);
    skills.push({
      slug: entry.name,
      name: nameMatch ? nameMatch[1].trim() : entry.name,
      description: descMatch ? descMatch[1].trim() : '(no description)'
    });
  }

  if (!skills.length) {
    return { ok: true, output: 'No skills found.' };
  }

  const lines = ['Skills:', ''];
  for (const s of skills) {
    lines.push(`  ${s.name}`);
    lines.push(`    ${s.description}`);
    lines.push('');
  }
  return { ok: true, output: lines.join('\n') };
}

module.exports = { slugify, validate, create, list };

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  const dirIdx = args.indexOf('--dir');
  let outputDir;
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    outputDir = args[dirIdx + 1];
  } else {
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    outputDir = path.join(cwd, '.claude', 'skills');
  }

  if (command === 'create') {
    const name = args[1];
    const description = args[2];
    const body = args[3];
    const result = create(name, description, body, outputDir);
    if (result.ok) {
      process.stdout.write(`Skill created at ${result.path}\n`);
    } else {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(1);
    }
  } else if (command === 'list') {
    const result = list(outputDir);
    process.stdout.write(result.output + '\n');
  } else {
    process.stderr.write('Usage: node skill-scaffold.js <create|list> [args] [--dir path]\n');
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/skill-scaffold.test.js`
Expected: All tests pass, 0 failures

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/skill-scaffold.js tests/skill-scaffold.test.js
git commit -m "feat: add skill-scaffold.js — create and list SKILL.md files"
```

---

### Task 5: Write learn-rule SKILL.md

**Files:**
- Create: `skills/learn-rule/SKILL.md`

- [ ] **Step 1: Write the skill definition**

Create `skills/learn-rule/SKILL.md`:

```markdown
---
name: learn-rule
description: Capture a lesson as an enforcement rule, update an existing rule's triggers, or promote a learned rule to permanent. Operates on learned-rules.json and skill-rules.json.
argument-hint: "[update <rule-name>|promote <rule-name>]"
---

# Skill Engine — Learn Rule

You help users capture lessons as enforcement rules, update existing rules, or promote learned rules to permanent status.

## Commands

- **(default)**: Capture a new lesson as a rule
- **update `<rule-name>`**: Modify an existing rule's triggers, enforcement, or priority
- **promote `<rule-name>`**: Move a learned rule from learned-rules.json to skill-rules.json

## Finding the Plugin Directory

To run backing code, find the skill-engine plugin directory:
```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Capturing a New Rule

### Step 1: Understand the Lesson

If the user provided the lesson as context from the triage router or as an argument, use that. Otherwise ask:

> "What should be enforced going forward?"

Accept natural language. Examples:
- "always use parameterized queries in SQL files"
- "don't modify files in the legacy/ directory"
- "warn when editing config files without a backup"

### Step 2: Infer Rule Details

Based on the lesson and conversation context, infer:

1. **Rule name**: Slugified from the lesson (e.g., `parameterized-queries-sql`). Lowercase, hyphens, no special characters.
2. **Type**: Almost always `guardrail` — the user wants enforcement.
3. **Enforcement**: Default to `warn` unless the user explicitly says "block" or "prevent."
4. **Priority**: Default to `medium`. Use `high` if emphasized. Use `critical` only for absolute statements.
5. **Triggers**:
   - Derive `pathPatterns` from file extensions or directories in context.
   - If specific content patterns mentioned, derive `contentPatterns`.
   - Keep patterns relative — use `**/*.sql` not absolute paths.
   - **CRITICAL (Windows):** All path patterns must use forward slashes. Never write backslashes.
6. **Description**: Clear, human-readable sentence that appears as the warning message.

### Step 3: Present the Proposed Rule

Show the complete rule for confirmation:

```
Proposed rule: parameterized-queries-sql
Type: guardrail | Enforcement: warn | Priority: medium
Triggers: **/*.sql files
Message: "Use parameterized queries — avoid string concatenation in SQL"

Full JSON:
{
  "type": "guardrail",
  "enforcement": "warn",
  "priority": "medium",
  "description": "Use parameterized queries — avoid string concatenation in SQL",
  "triggers": {
    "file": {
      "pathPatterns": ["**/*.sql"]
    }
  }
}

Want to adjust anything, or should I save this?
```

### Step 4: Save

On confirmation:

```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" add "<rule-name>" '<rule-json>'
```

Tell the user: Rule saved. It will fire next time a matching file is edited.

## Updating an Existing Rule

### Step 1: Identify the Rule

If a rule name was provided, look it up. Otherwise list rules and let the user pick:

```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" list
```

### Step 2: Show Current State

Display the rule's current configuration.

### Step 3: Collect Changes

Ask what to change. Common updates:
- Add file patterns: "also cover .psql files"
- Change enforcement: "make this a block instead of warn"
- Add prompt keywords: "also trigger on 'database' keyword"
- Change priority

### Step 4: Build Update JSON

Build a partial update object. For trigger arrays, only include new values to append — the backing code merges them:

```json
{
  "triggers": { "file": { "pathPatterns": ["**/*.psql"] } }
}
```

Show a before/after comparison and get confirmation.

### Step 5: Save

```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" update "<rule-name>" '<updates-json>'
```

To update a rule in skill-rules.json instead of learned-rules.json, use the `--file` flag:

```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" update "<rule-name>" '<updates-json>' --file .claude/skills/skill-rules.json
```

## Promoting a Learned Rule

### Step 1: Identify the Rule

If a rule name was provided, look it up. Otherwise list learned rules and let the user pick:

```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" list
```

### Step 2: Confirm Promotion

Show the rule and explain: "This will move the rule from learned-rules.json (auto-generated) to skill-rules.json (permanent, version-controlled). The rule behavior stays the same."

### Step 3: Promote

```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" promote "<rule-name>"
```

If the `--to` flag is not provided, the CLI auto-detects the project's skill-rules.json.

## Notes

- All path patterns must use forward slashes, even on Windows
- Update merges trigger arrays — existing patterns are preserved, new ones are appended
- Promote checks for name conflicts in the target file before moving
```

- [ ] **Step 2: Verify frontmatter is valid**

Run: `node -e "const f=require('fs').readFileSync('skills/learn-rule/SKILL.md','utf8'); const m=f.match(/^---\\n([\\s\\S]*?)\\n---/); console.log(m ? 'Valid frontmatter' : 'INVALID'); if(m) console.log(m[1])"`
Expected: "Valid frontmatter" followed by name, description, argument-hint

- [ ] **Step 3: Commit**

```bash
git add skills/learn-rule/SKILL.md
git commit -m "feat: add learn-rule skill — create, update, promote rules"
```

---

### Task 6: Write learn-hook SKILL.md

**Files:**
- Create: `skills/learn-hook/SKILL.md`

- [ ] **Step 1: Write the skill definition**

Create `skills/learn-hook/SKILL.md`:

```markdown
---
name: learn-hook
description: Capture a lesson as a Claude Code hook entry in settings.json. Creates PreToolUse, PostToolUse, or UserPromptSubmit hooks that run shell commands automatically.
argument-hint: "[list|remove]"
---

# Skill Engine — Learn Hook

You help users capture lessons as Claude Code hook entries in `.claude/settings.json`. Hooks run shell commands automatically in response to events — before tool use, after tool use, or on prompt submit.

## Commands

- **(default)**: Capture a new lesson as a hook
- **list**: Show all configured hooks
- **remove**: Remove a hook entry

## Finding the Plugin Directory

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Listing Hooks

```bash
node "$PLUGIN_DIR/hooks/lib/hook-manager.js" list
```

Show the output to the user.

## Removing a Hook

First list hooks to identify the entry. Then:

```bash
node "$PLUGIN_DIR/hooks/lib/hook-manager.js" remove "<hookType>" "<command>"
```

Where `<hookType>` is e.g. `PreToolUse` and `<command>` is the exact command string.

## Capturing a New Hook

### Step 1: Understand the Lesson

If the user provided context from the triage router, use that. Otherwise ask:

> "What should happen automatically? For example: 'lint Bicep files before saving', 'run tests after editing source files'"

### Step 2: Determine Hook Configuration

Based on the lesson, determine:

1. **Hook type** — When should this run?
   - `PreToolUse`: Before Claude uses a tool (Edit, Write, etc.) — good for linting, validation
   - `PostToolUse`: After Claude uses a tool — good for formatting, post-processing
   - `UserPromptSubmit`: When the user sends a message — good for context injection, checks

2. **Command** — What shell command should run?
   - Must be a valid bash command
   - Use `$CLAUDE_PROJECT_DIR` for project-relative paths
   - Example: `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/lint-bicep.sh"`

3. **Matcher** (PreToolUse and PostToolUse only) — Which tools trigger this?
   - Common matchers: `["Edit", "Write", "MultiEdit"]`, `["Bash"]`, `["Read"]`
   - Omit for UserPromptSubmit hooks

### Step 3: Present the Proposed Hook

Show the complete hook entry for confirmation:

```
Proposed hook:
  Type: PreToolUse
  Matcher: Edit, Write
  Command: bash "$CLAUDE_PROJECT_DIR/.claude/hooks/lint-bicep.sh"

JSON entry:
{
  "matcher": ["Edit", "Write"],
  "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/lint-bicep.sh\""
}

This will be added to .claude/settings.json under hooks.PreToolUse.
Want to adjust anything, or should I save this?
```

### Step 4: Check if the Hook Script Exists

If the command references a script file (e.g., `.claude/hooks/lint-bicep.sh`), check if it exists:
- If it exists, proceed to save.
- If it doesn't, ask: "The script doesn't exist yet. Want me to create a basic template?"
  - If yes, create the script with a shebang and placeholder logic, then `chmod +x` it.

### Step 5: Save

On confirmation, save via the backing code — **never construct settings.json manually**:

```bash
node "$PLUGIN_DIR/hooks/lib/hook-manager.js" add "<hookType>" '<entry-json>'
```

Where `<entry-json>` is the hook entry as a single-quoted JSON string.

Tell the user: Hook saved. It will fire automatically on the next matching event.

## Important

- **Never edit settings.json directly** — always use hook-manager.js to ensure safe read-modify-write.
- Hook entries are appended to existing arrays — other hooks are never removed or modified.
- The `command` field must be a string, `matcher` must be an array of tool name strings.
- Known hook types: UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop.
```

- [ ] **Step 2: Verify frontmatter is valid**

Run: `node -e "const f=require('fs').readFileSync('skills/learn-hook/SKILL.md','utf8'); const m=f.match(/^---\\n([\\s\\S]*?)\\n---/); console.log(m ? 'Valid frontmatter' : 'INVALID'); if(m) console.log(m[1])"`
Expected: "Valid frontmatter"

- [ ] **Step 3: Commit**

```bash
git add skills/learn-hook/SKILL.md
git commit -m "feat: add learn-hook skill — capture lessons as Claude Code hooks"
```

---

### Task 7: Write learn-skill SKILL.md

**Files:**
- Create: `skills/learn-skill/SKILL.md`

- [ ] **Step 1: Write the skill definition**

Create `skills/learn-skill/SKILL.md`:

```markdown
---
name: learn-skill
description: Capture a multi-step workflow or process as a reusable SKILL.md file. Scaffolds project-local skills in .claude/skills/.
argument-hint: "[list]"
---

# Skill Engine — Learn Skill

You help users capture workflows, processes, and multi-step knowledge as reusable SKILL.md files. Skills are project-local and auto-discovered by Claude Code.

## Commands

- **(default)**: Capture a new workflow as a skill
- **list**: Show all project-local skills

## Finding the Plugin Directory

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Listing Skills

```bash
node "$PLUGIN_DIR/hooks/lib/skill-scaffold.js" list --dir .claude/skills
```

## Capturing a New Skill

### Step 1: Understand the Workflow

If the user provided context from the triage router, use that. Otherwise ask:

> "What workflow or process should be captured? Describe it as you'd explain it to a colleague."

Probe for specifics:
- What triggers this workflow? ("When deploying...", "When debugging...", "When setting up...")
- What are the steps?
- Are there gotchas or things that commonly go wrong?
- What does success look like?

### Step 2: Draft the Skill Content

Write the skill body as clear instructions that another Claude session could follow. Structure it as:

1. **When to use** — one paragraph on when this skill applies
2. **Steps** — numbered steps with enough detail to execute without prior context
3. **Key principles** — important constraints or patterns to follow
4. **Common mistakes** — things that go wrong and how to avoid them (if applicable)

Keep it focused. A skill should capture one workflow, not an encyclopedia. Aim for 50-150 lines of useful content.

### Step 3: Choose a Name and Description

- **Name**: Short, descriptive. "Deploy Staging", "Debug Pipeline", "Setup Dev Environment"
- **Description**: One line explaining when to use this skill. This is what Claude Code shows in the skill list, so make it actionable: "Use when deploying changes to the staging environment" not "Staging deployment skill."

### Step 4: Present for Review

Show the complete SKILL.md content including frontmatter:

```
---
name: Deploy Staging
description: Use when deploying changes to the staging environment — covers cache flush, migrations, and smoke tests.
---

# Deploy Staging

## When to Use
...

## Steps
1. ...
2. ...

## Key Principles
- ...
```

Ask: "Want to adjust anything, or should I save this?"

### Step 5: Save

On confirmation:

```bash
node "$PLUGIN_DIR/hooks/lib/skill-scaffold.js" create "<name>" "<description>" "<body>" --dir .claude/skills
```

**Note:** For long body content that would exceed command-line argument limits, write the body to a temp file first, then use node to read and pass it:

```bash
# Write body to temp file
cat > /tmp/skill-body.md << 'SKILLEOF'
[body content here]
SKILLEOF

# Create via node directly
node -e "
const s = require('$PLUGIN_DIR/hooks/lib/skill-scaffold.js');
const fs = require('fs');
const body = fs.readFileSync('/tmp/skill-body.md', 'utf8');
const r = s.create('$NAME', '$DESC', body, '.claude/skills');
if (r.ok) console.log('Skill created at ' + r.path);
else { console.error('Error: ' + r.error); process.exit(1); }
"
```

Tell the user: Skill created at `.claude/skills/<slug>/SKILL.md`. It will be auto-discovered by Claude Code — no registration needed.

## Notes

- Skills are saved to `.claude/skills/<slug>/SKILL.md` — project-local, not part of the plugin
- Claude Code auto-discovers skills in `.claude/skills/` — no registration step needed
- The scaffold validates frontmatter structure before writing
- Skill names are slugified for the directory name (e.g., "Deploy Staging" → `deploy-staging/`)
```

- [ ] **Step 2: Verify frontmatter is valid**

Run: `node -e "const f=require('fs').readFileSync('skills/learn-skill/SKILL.md','utf8'); const m=f.match(/^---\\n([\\s\\S]*?)\\n---/); console.log(m ? 'Valid frontmatter' : 'INVALID'); if(m) console.log(m[1])"`
Expected: "Valid frontmatter"

- [ ] **Step 3: Commit**

```bash
git add skills/learn-skill/SKILL.md
git commit -m "feat: add learn-skill skill — scaffold SKILL.md files from lessons"
```

---

### Task 8: Rewrite learn/SKILL.md as Triage Router

**Files:**
- Modify: `skills/learn/SKILL.md` (full rewrite)

- [ ] **Step 1: Rewrite the skill definition**

Replace the entire contents of `skills/learn/SKILL.md` with:

```markdown
---
name: learn
description: Use when the user wants to capture a lesson learned as an enforcement rule. Persists best practices from the current session into learned-rules.json so they are automatically enforced in future edits.
argument-hint: "[list|remove <rule-name>]"
---

# Skill Engine — Learn

You help users capture lessons learned during agent sessions and persist them as the right artifact — a rule, a hook, or a skill.

## Commands

- **(default)**: Capture a new lesson (classifies and routes)
- **list**: Show all learned rules
- **remove `<rule-name>`**: Remove a learned rule

## Finding the Plugin Directory

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Listing Learned Rules

Run:
```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" list
```

Show the output to the user.

## Removing a Learned Rule

Run:
```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" remove "<rule-name>"
```

Confirm to the user that the rule was removed.

## Capturing a New Lesson

### Step 1: Understand the Lesson

If the user provided the lesson as an argument, use that. Otherwise ask:

> "What did you learn that should be captured for future sessions?"

### Step 2: Classify the Lesson

Based on what the user described, determine the best artifact type:

| Signal | Artifact | Route to |
|---|---|---|
| "warn/block/never/always when editing X files" | Enforcement rule | `/skill-engine:learn-rule` |
| "run [tool] before/after [action]", automate a command | Claude Code hook | `/skill-engine:learn-hook` |
| "when doing X, follow these steps", multi-step process | Reusable skill | `/skill-engine:learn-skill` |
| "update/change that rule to also cover..." | Rule update | `/skill-engine:learn-rule update` |
| "make that learned rule permanent" | Rule promotion | `/skill-engine:learn-rule promote` |

**If ambiguous**, ask one clarifying question. Example:

> "Should this lint Bicep files automatically (a hook that runs the linter), or warn you when editing Bicep files without linting (a rule)?"

### Step 3: Route

Once classified, tell the user what you're doing and follow the appropriate sub-skill:

- **Rule**: Follow `/skill-engine:learn-rule`
- **Hook**: Follow `/skill-engine:learn-hook`
- **Skill**: Follow `/skill-engine:learn-skill`

Pass along the lesson context so the user doesn't have to re-explain.
```

- [ ] **Step 2: Verify frontmatter is valid**

Run: `node -e "const f=require('fs').readFileSync('skills/learn/SKILL.md','utf8'); const m=f.match(/^---\\n([\\s\\S]*?)\\n---/); console.log(m ? 'Valid frontmatter' : 'INVALID'); if(m) console.log(m[1])"`
Expected: "Valid frontmatter"

- [ ] **Step 3: Commit**

```bash
git add skills/learn/SKILL.md
git commit -m "refactor: rewrite learn skill as triage router for rule/hook/skill"
```

---

### Task 9: Update plugin.json Registration

**Files:**
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Read current plugin.json**

Read `.claude-plugin/plugin.json` to confirm current structure.

- [ ] **Step 2: Update plugin.json**

The plugin.json currently has `name`, `version`, `description`, `author`, `license`, `homepage`, `repository`, `keywords`. Skills are auto-discovered from the `skills/` directory by Claude Code's plugin system — each subdirectory with a `SKILL.md` is registered automatically.

Bump the version to `1.2.0` since this adds new features (three new skills, two new backing modules):

Update the `version` field from `"1.1.0"` to `"1.2.0"`.

Update the `description` to reflect the expanded capabilities:

```
"description": "Hook-driven skill activation, guardrail enforcement, lesson capture (rules, hooks, skills), and shared hook utilities for Claude Code projects."
```

- [ ] **Step 3: Verify skills are discoverable**

Confirm all skill directories exist and have valid SKILL.md files:

```bash
for dir in skills/*/; do
  if [ -f "$dir/SKILL.md" ]; then
    name=$(grep "^name:" "$dir/SKILL.md" | head -1 | sed 's/name: *//')
    echo "OK: $dir -> $name"
  else
    echo "MISSING: $dir"
  fi
done
```

Expected output:
```
OK: skills/learn/ -> learn
OK: skills/learn-hook/ -> learn-hook
OK: skills/learn-rule/ -> learn-rule
OK: skills/learn-skill/ -> learn-skill
OK: skills/rules/ -> rules
OK: skills/setup/ -> setup
```

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json
git commit -m "chore: bump to v1.2.0 — learn expansion with sub-skills"
```

---

### Task 10: Run Full Test Suite and Integration Verification

**Files:**
- No new files — verification only

- [ ] **Step 1: Run all unit tests**

```bash
node --test tests/learn.test.js tests/hook-manager.test.js tests/skill-scaffold.test.js tests/engine.test.js tests/glob-match.test.js
```

Expected: All tests pass, 0 failures across all test files.

- [ ] **Step 2: Run integration tests**

```bash
bash tests/test-hooks.sh
```

Expected: All existing integration tests pass (these test the engine hooks, which are unchanged).

- [ ] **Step 3: Manual smoke test — learn.js update and promote via CLI**

```bash
TMPDIR=$(mktemp -d)
LEARNED="$TMPDIR/learned-rules.json"
RULES="$TMPDIR/skill-rules.json"

# Create a learned rule
node hooks/lib/learn.js add smoke-test '{"type":"guardrail","description":"Smoke test","triggers":{"file":{"pathPatterns":["**/*.txt"]}}}' --file "$LEARNED"

# Update it
node hooks/lib/learn.js update smoke-test '{"triggers":{"file":{"pathPatterns":["**/*.md"]}}}' --file "$LEARNED"

# Verify merged triggers
node hooks/lib/learn.js list --file "$LEARNED"

# Create target and promote
echo '{"version":"1.0","defaults":{},"rules":{}}' > "$RULES"
node hooks/lib/learn.js promote smoke-test --file "$LEARNED" --to "$RULES"

# Verify promotion
node -e "const d=JSON.parse(require('fs').readFileSync('$RULES','utf8')); console.log(d.rules['smoke-test'] ? 'PROMOTE OK' : 'PROMOTE FAIL')"
node hooks/lib/learn.js list --file "$LEARNED"

rm -rf "$TMPDIR"
```

Expected: Merged triggers show both `**/*.txt` and `**/*.md`. Promotion moves the rule. Learned file shows "No learned rules yet" after promotion.

- [ ] **Step 4: Manual smoke test — hook-manager.js**

```bash
TMPDIR=$(mktemp -d)
SETTINGS="$TMPDIR/settings.json"

# Add a hook
node hooks/lib/hook-manager.js add PreToolUse '{"command":"bash lint.sh","matcher":["Edit"]}' --file "$SETTINGS"

# List hooks
node hooks/lib/hook-manager.js list --file "$SETTINGS"

# Remove it
node hooks/lib/hook-manager.js remove PreToolUse "bash lint.sh" --file "$SETTINGS"

# Verify empty
node hooks/lib/hook-manager.js list --file "$SETTINGS"

rm -rf "$TMPDIR"
```

Expected: Hook is added, listed, removed, then "No hooks configured."

- [ ] **Step 5: Manual smoke test — skill-scaffold.js**

```bash
TMPDIR=$(mktemp -d)

# Create a skill
node hooks/lib/skill-scaffold.js create "Test Skill" "A test skill for verification" "Step 1: Do the thing." --dir "$TMPDIR"

# List skills
node hooks/lib/skill-scaffold.js list --dir "$TMPDIR"

# Verify file contents
cat "$TMPDIR/test-skill/SKILL.md"

rm -rf "$TMPDIR"
```

Expected: Skill is created with valid frontmatter, listed with name and description.

---

### Task 11: Update setup/SKILL.md to Copy New Modules

**Files:**
- Modify: `skills/setup/SKILL.md`

- [ ] **Step 1: Update the copy section**

In `skills/setup/SKILL.md`, the Step 2 section copies hook files to the project. Add the two new modules to the copy list. After the existing line that copies `learn.js`, add:

```bash
cp "$PLUGIN_HOOKS/lib/hook-manager.js" .claude/hooks/skill-engine/lib/
cp "$PLUGIN_HOOKS/lib/skill-scaffold.js" .claude/hooks/skill-engine/lib/
```

- [ ] **Step 2: Update the uninstall section**

The uninstall section deletes `.claude/hooks/skill-engine/`. Since the new files live inside that directory, no change is needed — the recursive delete already covers them.

- [ ] **Step 3: Commit**

```bash
git add skills/setup/SKILL.md
git commit -m "chore: setup skill copies hook-manager.js and skill-scaffold.js"
```
