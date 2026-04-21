# Learn Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/skill-engine:learn` skill that captures lessons learned during agent sessions and persists them as enforcement rules in `learned-rules.json`.

**Architecture:** SKILL.md handles conversational UX (capture, infer, present, confirm). `learn.js` helper handles mechanical ops (validate, normalize, merge, write). Engine loads both `skill-rules.json` and `learned-rules.json`, merging them for matching.

**Tech Stack:** Node.js (no dependencies), node:test for testing, bash hooks.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `hooks/lib/learn.js` | Create | CLI helper: add, list, remove learned rules |
| `hooks/lib/engine.js` | Modify | Add `findLearnedRulesFile()`, merge learned rules in `activate()` and `enforce()` |
| `skills/learn/SKILL.md` | Create | Conversational UX for `/skill-engine:learn` |
| `tests/learn.test.js` | Create | Unit tests for learn.js |
| `tests/engine.test.js` | Modify | Tests for learned-rules loading + merge |
| `tests/test-hooks.sh` | Modify | Integration test: learn.js add -> enforce.sh fires |

---

### Task 1: learn.js — Core CRUD Functions

**Files:**
- Create: `hooks/lib/learn.js`
- Test: `tests/learn.test.js`

This task builds the three core functions (`add`, `list`, `remove`) with schema validation and path normalization. No CLI entry point yet — that's Task 2.

- [ ] **Step 1: Write the failing test for `add` — valid rule**

Create `tests/learn.test.js`:

```js
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const learn = require(path.resolve(__dirname, '..', 'hooks', 'lib', 'learn.js'));

describe('add', () => {
  let tmpDir;
  let learnedFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-test-'));
    learnedFile = path.join(tmpDir, 'learned-rules.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a valid rule to a new file', () => {
    const rule = {
      type: 'guardrail',
      enforcement: 'warn',
      priority: 'medium',
      description: 'Always use parameterized queries',
      triggers: {
        file: { pathPatterns: ['**/*.sql'] }
      }
    };
    const result = learn.add('parameterized-queries', rule, learnedFile);
    assert.equal(result.ok, true);

    const data = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    assert.equal(data.version, '1.0');
    assert.ok(data.rules['parameterized-queries']);
    assert.equal(data.rules['parameterized-queries'].description, 'Always use parameterized queries');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/learn.test.js`
Expected: FAIL — `learn.js` does not exist yet.

- [ ] **Step 3: Write minimal `add` implementation**

Create `hooks/lib/learn.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizePath } = require('./engine.js');

const REQUIRED_FIELDS = ['type', 'description', 'triggers'];

function validateRule(rule) {
  for (const field of REQUIRED_FIELDS) {
    if (!rule[field]) return { ok: false, error: `Missing required field: ${field}` };
  }
  if (rule.type !== 'domain' && rule.type !== 'guardrail') {
    return { ok: false, error: `Invalid type: ${rule.type}. Must be "domain" or "guardrail"` };
  }
  return { ok: true };
}

function normalizeTriggerPaths(rule) {
  const file = rule.triggers && rule.triggers.file;
  if (!file) return rule;
  const copy = JSON.parse(JSON.stringify(rule));
  if (copy.triggers.file.pathPatterns) {
    copy.triggers.file.pathPatterns = copy.triggers.file.pathPatterns.map(p => normalizePath(p));
  }
  if (copy.triggers.file.pathExclusions) {
    copy.triggers.file.pathExclusions = copy.triggers.file.pathExclusions.map(p => normalizePath(p));
  }
  return copy;
}

function loadLearnedFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data.version !== '1.0' || !data.rules) return null;
    return data;
  } catch {
    return null;
  }
}

function add(ruleName, rule, filePath) {
  const validation = validateRule(rule);
  if (!validation.ok) return validation;

  const normalized = normalizeTriggerPaths(rule);
  const data = loadLearnedFile(filePath) || { version: '1.0', rules: {} };

  if (data.rules[ruleName]) {
    return { ok: false, error: `Rule "${ruleName}" already exists. Remove it first.` };
  }

  data.rules[ruleName] = normalized;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true };
}

module.exports = { validateRule, normalizeTriggerPaths, loadLearnedFile, add };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/learn.test.js`
Expected: PASS

- [ ] **Step 5: Write failing tests for `add` — error cases and path normalization**

Add to `tests/learn.test.js` inside the `describe('add')` block:

```js
  it('rejects rule missing required fields', () => {
    const rule = { type: 'guardrail', description: 'test' };
    const result = learn.add('bad-rule', rule, learnedFile);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('triggers'));
    assert.equal(fs.existsSync(learnedFile), false);
  });

  it('rejects rule with invalid type', () => {
    const rule = {
      type: 'invalid',
      description: 'test',
      triggers: { file: { pathPatterns: ['**/*.sql'] } }
    };
    const result = learn.add('bad-type', rule, learnedFile);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('Invalid type'));
  });

  it('rejects duplicate rule name', () => {
    const rule = {
      type: 'guardrail',
      description: 'test',
      triggers: { file: { pathPatterns: ['**/*.sql'] } }
    };
    learn.add('my-rule', rule, learnedFile);
    const result = learn.add('my-rule', rule, learnedFile);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('already exists'));
  });

  it('normalizes backslash paths to forward slashes', () => {
    const rule = {
      type: 'guardrail',
      description: 'test',
      triggers: {
        file: {
          pathPatterns: ['src\\db\\**\\*.sql'],
          pathExclusions: ['src\\db\\migrations\\**']
        }
      }
    };
    learn.add('backslash-rule', rule, learnedFile);
    const data = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    assert.deepEqual(data.rules['backslash-rule'].triggers.file.pathPatterns, ['src/db/**/*.sql']);
    assert.deepEqual(data.rules['backslash-rule'].triggers.file.pathExclusions, ['src/db/migrations/**']);
  });

  it('merges into existing file without clobbering', () => {
    const rule1 = {
      type: 'guardrail',
      description: 'first rule',
      triggers: { file: { pathPatterns: ['**/*.sql'] } }
    };
    const rule2 = {
      type: 'guardrail',
      description: 'second rule',
      triggers: { file: { pathPatterns: ['**/*.js'] } }
    };
    learn.add('first', rule1, learnedFile);
    learn.add('second', rule2, learnedFile);
    const data = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    assert.ok(data.rules['first']);
    assert.ok(data.rules['second']);
    assert.equal(Object.keys(data.rules).length, 2);
  });

  it('creates parent directory if it does not exist', () => {
    const nested = path.join(tmpDir, 'deep', 'nested', 'learned-rules.json');
    const rule = {
      type: 'guardrail',
      description: 'test',
      triggers: { file: { pathPatterns: ['**/*.sql'] } }
    };
    const result = learn.add('nested-rule', rule, nested);
    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(nested));
  });
```

- [ ] **Step 6: Run tests to verify they pass** (implementation already handles these cases)

Run: `node --test tests/learn.test.js`
Expected: PASS

- [ ] **Step 7: Write failing tests for `list`**

Add to `tests/learn.test.js`:

```js
describe('list', () => {
  let tmpDir;
  let learnedFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-test-'));
    learnedFile = path.join(tmpDir, 'learned-rules.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns formatted list of rules', () => {
    const rule = {
      type: 'guardrail',
      enforcement: 'warn',
      priority: 'medium',
      description: 'Always use parameterized queries',
      triggers: { file: { pathPatterns: ['**/*.sql'] } }
    };
    learn.add('param-queries', rule, learnedFile);
    const result = learn.list(learnedFile);
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('param-queries'));
    assert.ok(result.output.includes('warn'));
    assert.ok(result.output.includes('Always use parameterized queries'));
    assert.ok(result.output.includes('**/*.sql'));
  });

  it('returns empty message when no rules exist', () => {
    const result = learn.list(learnedFile);
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('No learned rules yet'));
  });

  it('returns empty message for missing file', () => {
    const result = learn.list('/nonexistent/learned-rules.json');
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('No learned rules yet'));
  });
});
```

- [ ] **Step 8: Implement `list`**

Add to `hooks/lib/learn.js`:

```js
function list(filePath) {
  const data = loadLearnedFile(filePath);
  if (!data || !Object.keys(data.rules).length) {
    return { ok: true, output: 'No learned rules yet.' };
  }

  const lines = ['Learned rules:', ''];
  for (const [name, rule] of Object.entries(data.rules)) {
    const enforcement = rule.enforcement || 'warn';
    const priority = rule.priority || 'medium';
    lines.push(`  ${name}`);
    lines.push(`    Type: ${rule.type} | Enforcement: ${enforcement} | Priority: ${priority}`);
    lines.push(`    ${rule.description}`);
    const file = rule.triggers && rule.triggers.file;
    if (file && file.pathPatterns) {
      lines.push(`    Files: ${file.pathPatterns.join(', ')}`);
    }
    const prompt = rule.triggers && rule.triggers.prompt;
    if (prompt && prompt.keywords) {
      lines.push(`    Keywords: ${prompt.keywords.join(', ')}`);
    }
    lines.push('');
  }
  return { ok: true, output: lines.join('\n') };
}
```

Add `list` to `module.exports`.

- [ ] **Step 9: Run tests to verify `list` passes**

Run: `node --test tests/learn.test.js`
Expected: PASS

- [ ] **Step 10: Write failing tests for `remove`**

Add to `tests/learn.test.js`:

```js
describe('remove', () => {
  let tmpDir;
  let learnedFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-test-'));
    learnedFile = path.join(tmpDir, 'learned-rules.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes an existing rule', () => {
    const rule = {
      type: 'guardrail',
      description: 'test',
      triggers: { file: { pathPatterns: ['**/*.sql'] } }
    };
    learn.add('to-remove', rule, learnedFile);
    const result = learn.remove('to-remove', learnedFile);
    assert.equal(result.ok, true);
    const data = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    assert.equal(data.rules['to-remove'], undefined);
  });

  it('errors when rule does not exist', () => {
    const result = learn.remove('nonexistent', learnedFile);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('not found'));
  });

  it('errors when file does not exist', () => {
    const result = learn.remove('anything', '/nonexistent/learned-rules.json');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('not found'));
  });
});
```

- [ ] **Step 11: Implement `remove`**

Add to `hooks/lib/learn.js`:

```js
function remove(ruleName, filePath) {
  const data = loadLearnedFile(filePath);
  if (!data || !data.rules[ruleName]) {
    return { ok: false, error: `Rule "${ruleName}" not found.` };
  }

  delete data.rules[ruleName];
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true };
}
```

Add `remove` to `module.exports`.

- [ ] **Step 12: Run tests to verify `remove` passes**

Run: `node --test tests/learn.test.js`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add hooks/lib/learn.js tests/learn.test.js
git commit -m "feat: learn.js CRUD — add, list, remove learned rules"
```

---

### Task 2: learn.js — CLI Entry Point

**Files:**
- Modify: `hooks/lib/learn.js`

This task adds the `if (require.main === module)` CLI entry point so the agent can invoke `learn.js` from bash. Follows the same pattern as `engine.js:282-305`.

- [ ] **Step 1: Write integration test for CLI**

Add to `tests/learn.test.js`:

```js
const { execSync } = require('child_process');

describe('CLI', () => {
  let tmpDir;
  let learnedFile;
  const learnScript = path.resolve(__dirname, '..', 'hooks', 'lib', 'learn.js');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-cli-'));
    learnedFile = path.join(tmpDir, 'learned-rules.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('add via CLI writes rule to file', () => {
    const ruleJson = JSON.stringify({
      type: 'guardrail',
      description: 'CLI test rule',
      triggers: { file: { pathPatterns: ['**/*.sql'] } }
    });
    const output = execSync(
      `node "${learnScript}" add cli-rule '${ruleJson}' --file "${learnedFile}"`,
      { encoding: 'utf8' }
    );
    assert.ok(output.includes('cli-rule'));
    const data = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    assert.ok(data.rules['cli-rule']);
  });

  it('list via CLI shows rules', () => {
    const ruleJson = JSON.stringify({
      type: 'guardrail',
      description: 'List test',
      triggers: { file: { pathPatterns: ['**/*.js'] } }
    });
    execSync(
      `node "${learnScript}" add list-test '${ruleJson}' --file "${learnedFile}"`,
      { encoding: 'utf8' }
    );
    const output = execSync(
      `node "${learnScript}" list --file "${learnedFile}"`,
      { encoding: 'utf8' }
    );
    assert.ok(output.includes('list-test'));
    assert.ok(output.includes('List test'));
  });

  it('remove via CLI deletes rule', () => {
    const ruleJson = JSON.stringify({
      type: 'guardrail',
      description: 'Remove me',
      triggers: { file: { pathPatterns: ['**/*.txt'] } }
    });
    execSync(
      `node "${learnScript}" add to-delete '${ruleJson}' --file "${learnedFile}"`,
      { encoding: 'utf8' }
    );
    const output = execSync(
      `node "${learnScript}" remove to-delete --file "${learnedFile}"`,
      { encoding: 'utf8' }
    );
    assert.ok(output.includes('to-delete'));
    const data = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    assert.equal(data.rules['to-delete'], undefined);
  });

  it('add via CLI exits 1 on validation error', () => {
    const ruleJson = JSON.stringify({ type: 'guardrail', description: 'missing triggers' });
    assert.throws(() => {
      execSync(
        `node "${learnScript}" add bad-rule '${ruleJson}' --file "${learnedFile}"`,
        { encoding: 'utf8' }
      );
    });
  });
});
```

- [ ] **Step 2: Run tests to verify CLI tests fail**

Run: `node --test tests/learn.test.js`
Expected: FAIL — no CLI entry point yet.

- [ ] **Step 3: Implement CLI entry point**

Add to the bottom of `hooks/lib/learn.js`:

```js
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  // Parse --file flag
  const fileIdx = args.indexOf('--file');
  let filePath;
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    filePath = args[fileIdx + 1];
  } else {
    // Default: find .claude/skills/ from cwd using engine's findRulesFile
    const { findRulesFile } = require('./engine.js');
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const rulesFile = findRulesFile(cwd);
    if (rulesFile) {
      filePath = path.join(path.dirname(rulesFile), 'learned-rules.json');
    } else {
      filePath = path.join(cwd, '.claude', 'skills', 'learned-rules.json');
    }
  }

  if (command === 'add') {
    const ruleName = args[1];
    let ruleJson;
    try {
      ruleJson = JSON.parse(args[2]);
    } catch {
      process.stderr.write('Error: Invalid JSON for rule.\n');
      process.exit(1);
    }
    const result = add(ruleName, ruleJson, filePath);
    if (result.ok) {
      process.stdout.write(`Rule "${ruleName}" saved to ${filePath}\n`);
    } else {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(1);
    }
  } else if (command === 'list') {
    const result = list(filePath);
    process.stdout.write(result.output + '\n');
  } else if (command === 'remove') {
    const ruleName = args[1];
    const result = remove(ruleName, filePath);
    if (result.ok) {
      process.stdout.write(`Rule "${ruleName}" removed from ${filePath}\n`);
    } else {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(1);
    }
  } else {
    process.stderr.write('Usage: node learn.js <add|list|remove> [args] [--file path]\n');
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run tests to verify CLI tests pass**

Run: `node --test tests/learn.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/learn.js tests/learn.test.js
git commit -m "feat: learn.js CLI entry point — add, list, remove commands"
```

---

### Task 3: Engine Changes — Load and Merge Learned Rules

**Files:**
- Modify: `hooks/lib/engine.js:6-16` (add `findLearnedRulesFile`)
- Modify: `hooks/lib/engine.js:178-221` (modify `activate`)
- Modify: `hooks/lib/engine.js:224-261` (modify `enforce`)
- Modify: `hooks/lib/engine.js:263-280` (update exports)
- Modify: `hooks/lib/engine.js:282-305` (update CLI)
- Test: `tests/engine.test.js`

- [ ] **Step 1: Write failing test for `findLearnedRulesFile`**

Add to `tests/engine.test.js` inside the `describe('Rules Loading')` block:

```js
  it('findLearnedRulesFile finds learned-rules.json walking up directories', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'se-test-'));
    const projectDir = path.join(tmpBase, 'project');
    const srcDir = path.join(projectDir, 'src', 'deep');
    const rulesDir = path.join(projectDir, '.claude', 'skills');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(rulesDir, { recursive: true });
    const learnedFile = path.join(rulesDir, 'learned-rules.json');
    fs.writeFileSync(learnedFile, '{"version":"1.0","rules":{}}');
    const found = engine.findLearnedRulesFile(srcDir);
    assert.equal(found, learnedFile);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('findLearnedRulesFile returns null when no file exists', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'se-test-'));
    const result = engine.findLearnedRulesFile(tmpBase);
    assert.equal(result, null);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/engine.test.js`
Expected: FAIL — `findLearnedRulesFile` is not a function.

- [ ] **Step 3: Implement `findLearnedRulesFile`**

Add to `hooks/lib/engine.js` after `findRulesFile` (after line 16):

```js
function findLearnedRulesFile(startDir) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, '.claude', 'skills', 'learned-rules.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir || dir === root) return null;
    dir = parent;
  }
}
```

Add `findLearnedRulesFile` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/engine.test.js`
Expected: PASS

- [ ] **Step 5: Write failing tests for merged activate/enforce**

Add a new `describe('Learned Rules Merge')` block at the end of `tests/engine.test.js`:

```js
describe('Learned Rules Merge', () => {
  let tmpBase;
  let rulesDir;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'se-merge-'));
    rulesDir = path.join(tmpBase, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  function writeRulesFiles(mainRules, learnedRules) {
    if (mainRules) {
      fs.writeFileSync(
        path.join(rulesDir, 'skill-rules.json'),
        JSON.stringify({ version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: mainRules }, null, 2)
      );
    }
    if (learnedRules) {
      fs.writeFileSync(
        path.join(rulesDir, 'learned-rules.json'),
        JSON.stringify({ version: '1.0', rules: learnedRules }, null, 2)
      );
    }
  }

  it('activate matches rules from both files', () => {
    writeRulesFiles(
      { 'main-rule': { type: 'domain', description: 'Main rule', triggers: { prompt: { keywords: ['main'] } } } },
      { 'learned-rule': { type: 'domain', description: 'Learned rule', triggers: { prompt: { keywords: ['learned'] } } } }
    );
    const mainData = engine.loadRules(path.join(rulesDir, 'skill-rules.json'));
    const learnedData = engine.loadRules(path.join(rulesDir, 'learned-rules.json'));
    const merged = { ...mainData, rules: { ...learnedData.rules, ...mainData.rules } };

    const out1 = engine.activate({ prompt: 'test main topic', session_id: 'merge-1' }, merged);
    assert.ok(out1.includes('main-rule'));
    const out2 = engine.activate({ prompt: 'test learned topic', session_id: 'merge-2' }, merged);
    assert.ok(out2.includes('learned-rule'));
  });

  it('enforce fires warn from learned rules', () => {
    writeRulesFiles(
      {},
      {
        'learned-warn': {
          type: 'guardrail',
          enforcement: 'warn',
          description: 'Learned warning',
          triggers: { file: { pathPatterns: ['**/*.sql'] } }
        }
      }
    );
    const mainData = engine.loadRules(path.join(rulesDir, 'skill-rules.json'));
    const learnedData = engine.loadRules(path.join(rulesDir, 'learned-rules.json'));
    const merged = { ...mainData, rules: { ...mainData.rules, ...learnedData.rules } };

    const result = engine.enforce(
      { tool_name: 'Edit', tool_input: { file_path: '/any/path/file.sql' }, session_id: 'merge-3' },
      merged
    );
    assert.equal(result.exit, 0);
    assert.ok(result.stderr.includes('learned-warn'));
  });

  it('skill-rules.json wins on name collision', () => {
    writeRulesFiles(
      { 'collision': { type: 'domain', description: 'Main wins', triggers: { prompt: { keywords: ['collision'] } } } },
      { 'collision': { type: 'domain', description: 'Learned loses', triggers: { prompt: { keywords: ['collision'] } } } }
    );
    const mainData = engine.loadRules(path.join(rulesDir, 'skill-rules.json'));
    const learnedData = engine.loadRules(path.join(rulesDir, 'learned-rules.json'));
    // main spread last = main wins
    const merged = { ...mainData, rules: { ...learnedData.rules, ...mainData.rules } };

    const out = engine.activate({ prompt: 'test collision', session_id: 'merge-4' }, merged);
    assert.ok(out.includes('Main wins'));
    assert.ok(!out.includes('Learned loses'));
  });

  it('activate works when learned-rules.json is missing', () => {
    writeRulesFiles(
      { 'only-main': { type: 'domain', description: 'Solo rule', triggers: { prompt: { keywords: ['solo'] } } } },
      null
    );
    const mainData = engine.loadRules(path.join(rulesDir, 'skill-rules.json'));
    // No learned file — merge with empty
    const merged = { ...mainData };
    const out = engine.activate({ prompt: 'test solo', session_id: 'merge-5' }, merged);
    assert.ok(out.includes('only-main'));
  });

  it('activate works when learned-rules.json is malformed', () => {
    writeRulesFiles(
      { 'only-main': { type: 'domain', description: 'Solo rule', triggers: { prompt: { keywords: ['solo'] } } } },
      null
    );
    fs.writeFileSync(path.join(rulesDir, 'learned-rules.json'), 'not valid json');
    const mainData = engine.loadRules(path.join(rulesDir, 'skill-rules.json'));
    const learnedData = engine.loadRules(path.join(rulesDir, 'learned-rules.json'));
    assert.equal(learnedData, null);
    // Merge with null handled gracefully
    const merged = { ...mainData, rules: { ...(learnedData ? learnedData.rules : {}), ...mainData.rules } };
    const out = engine.activate({ prompt: 'test solo', session_id: 'merge-6' }, merged);
    assert.ok(out.includes('only-main'));
  });
});
```

- [ ] **Step 6: Run tests — these should all pass already**

The tests above manually build merged objects to verify that the activate/enforce functions work with merged data. This validates the approach. The actual merge logic in the CLI entry point is next.

Run: `node --test tests/engine.test.js`
Expected: PASS (these test the existing functions with pre-merged data).

- [ ] **Step 7: Add `beforeEach` import at top of engine.test.js**

The new test block uses `beforeEach`/`afterEach`. Make sure the import at the top includes them:

Change line 1 of `tests/engine.test.js`:
```js
const { describe, it, after, beforeEach, afterEach } = require('node:test');
```

- [ ] **Step 8: Update engine.js CLI entry point to load and merge both files**

Modify the `if (require.main === module)` block in `hooks/lib/engine.js` (lines 282-305):

```js
if (require.main === module) {
  const mode = process.argv[2];
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const rulesFile = findRulesFile(cwd);
  const rulesData = loadRules(rulesFile);
  if (!rulesData) process.exit(0);

  // Merge learned rules if they exist
  const learnedFile = findLearnedRulesFile(cwd);
  const learnedData = loadRules(learnedFile);
  if (learnedData) {
    // Learned rules go first in spread so main rules win on collision
    rulesData.rules = { ...learnedData.rules, ...rulesData.rules };
  }

  if (mode === 'activate') {
    const output = activate(input, rulesData);
    if (output) process.stdout.write(output);
    process.exit(0);
  } else if (mode === 'enforce') {
    const result = enforce(input, rulesData);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exit);
  }
  process.exit(0);
}
```

- [ ] **Step 9: Run all tests**

Run: `node --test tests/engine.test.js && node --test tests/learn.test.js`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add hooks/lib/engine.js tests/engine.test.js
git commit -m "feat: engine loads and merges learned-rules.json alongside skill-rules.json"
```

---

### Task 4: Integration Test — learn.js add -> enforce.sh fires

**Files:**
- Modify: `tests/test-hooks.sh`

- [ ] **Step 1: Add integration test to `test-hooks.sh`**

Add a new section before the `=== Results ===` line in `tests/test-hooks.sh`:

```bash
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
```

- [ ] **Step 2: Run integration tests**

Run: `bash tests/test-hooks.sh`
Expected: PASS — all existing tests still pass, new integration test passes.

- [ ] **Step 3: Commit**

```bash
git add tests/test-hooks.sh
git commit -m "test: integration test for learned rule enforcement via learn.js + enforce.sh"
```

---

### Task 5: Learn SKILL.md

**Files:**
- Create: `skills/learn/SKILL.md`

This is the conversational skill definition that guides the agent through the learn workflow.

- [ ] **Step 1: Create the SKILL.md**

Create `skills/learn/SKILL.md`:

```markdown
---
name: learn
description: Use when the user wants to capture a lesson learned as an enforcement rule. Persists best practices from the current session into learned-rules.json so they are automatically enforced in future edits.
argument-hint: "[list|remove <rule-name>]"
---

# Skill Engine — Learn

You help users capture lessons learned during agent sessions and persist them as enforcement rules. Rules are saved to `learned-rules.json` and automatically enforced by the existing skill-engine hooks.

## Commands

- **(default)**: Capture a new lesson as a rule
- **list**: Show all learned rules
- **remove `<rule-name>`**: Remove a learned rule

## Listing Rules

Run:
```bash
node "<PLUGIN_DIR>/hooks/lib/learn.js" list
```

Where `<PLUGIN_DIR>` is the skill-engine plugin directory. To find it:
```bash
ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/
```

Show the output to the user.

## Removing a Rule

Run:
```bash
node "<PLUGIN_DIR>/hooks/lib/learn.js" remove "<rule-name>"
```

Confirm to the user that the rule was removed.

## Capturing a New Lesson

### Step 1: Understand the Lesson

If the user provided the lesson as an argument, use that. Otherwise ask:

> "What should be enforced going forward?"

Accept natural language. Examples:
- "always use parameterized queries in SQL files"
- "don't modify files in the legacy/ directory"
- "warn when editing config files without a backup"

### Step 2: Infer Rule Details from Context

Based on the lesson and the current conversation context, infer:

1. **Rule name**: Slugified from the lesson (e.g., `parameterized-queries-sql`). Lowercase, hyphens, no special characters.

2. **Type**: Almost always `guardrail` — the user wants enforcement, not just suggestions.

3. **Enforcement**: Default to `warn` unless the user explicitly says "block" or "prevent."

4. **Priority**: Default to `medium`. Use `high` if the user emphasizes importance. Use `critical` only if they say "always" + "never" type absolutes.

5. **Triggers**:
   - Look at what file the user is currently editing or was recently editing. Derive `pathPatterns` from the file extension or directory.
   - If the lesson mentions specific content patterns (e.g., "string concatenation"), derive `contentPatterns`.
   - Keep patterns **relative** — use `**/*.sql` not absolute paths.
   - **CRITICAL (Windows):** All path patterns must use forward slashes. Never write backslashes into patterns. If you derive a pattern from a Windows file path, convert backslashes to forward slashes.

6. **Description**: A clear, human-readable sentence that will appear as the warning message.

### Step 3: Present the Proposed Rule

Show the user the complete rule for confirmation:

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

### Step 4: Revise or Save

If the user wants changes, update the rule and re-present.

On confirmation, save the rule:

```bash
node "<PLUGIN_DIR>/hooks/lib/learn.js" add "<rule-name>" '<rule-json>'
```

The `<rule-json>` argument is the complete rule object as a single-quoted JSON string.

If the `--file` flag is not provided, `learn.js` automatically finds (or creates) `learned-rules.json` in the project's `.claude/skills/` directory.

### Step 5: Confirm

Tell the user:

> "Rule `<rule-name>` saved. It will fire as a **warn** next time you edit a matching file. Use `/skill-engine:learn list` to see all learned rules, or `/skill-engine:learn remove <rule-name>` to delete one."

## Notes

- Learned rules live in `.claude/skills/learned-rules.json`, separate from hand-authored `skill-rules.json`
- The engine merges both files automatically — no setup needed beyond having skill-engine installed
- Default enforcement is `warn` (non-blocking). Users can edit `learned-rules.json` directly to change a rule to `block`
- All path patterns must use forward slashes, even on Windows
```

- [ ] **Step 2: Verify the skill file renders correctly**

Read back `skills/learn/SKILL.md` and confirm the frontmatter and content are correct. No test to run — this is a documentation file.

- [ ] **Step 3: Commit**

```bash
git add skills/learn/SKILL.md
git commit -m "feat: learn SKILL.md — conversational UX for capturing lessons as rules"
```

---

### Task 6: Update Setup Skill for Learned Rules

**Files:**
- Modify: `skills/setup/SKILL.md`

The setup skill should copy `learn.js` alongside `engine.js` when installing hooks.

- [ ] **Step 1: Update the file list in setup SKILL.md**

In `skills/setup/SKILL.md`, update the directory tree in Step 2 to include `learn.js`:

Change:
```
.claude/
├── hooks/
│   └── skill-engine/
│       ├── activate.sh
│       ├── enforce.sh
│       └── lib/
│           └── engine.js
└── skills/
    └── skill-rules.json    ← scaffold if doesn't exist
```

To:
```
.claude/
├── hooks/
│   └── skill-engine/
│       ├── activate.sh
│       ├── enforce.sh
│       └── lib/
│           ├── engine.js
│           └── learn.js
└── skills/
    └── skill-rules.json    ← scaffold if doesn't exist
```

- [ ] **Step 2: Commit**

```bash
git add skills/setup/SKILL.md
git commit -m "docs: update setup skill to include learn.js in hook file tree"
```

---

### Task 7: Run Full Test Suite and Verify

**Files:** None — verification only.

- [ ] **Step 1: Run unit tests**

Run: `node --test tests/engine.test.js`
Expected: All existing + new tests PASS.

- [ ] **Step 2: Run learn.js unit tests**

Run: `node --test tests/learn.test.js`
Expected: All tests PASS.

- [ ] **Step 3: Run integration tests**

Run: `bash tests/test-hooks.sh`
Expected: All tests PASS, including the new learned-rules integration test.

- [ ] **Step 4: Verify no regressions — run everything together**

Run: `node --test tests/engine.test.js && node --test tests/learn.test.js && bash tests/test-hooks.sh`
Expected: All PASS.
