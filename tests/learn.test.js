const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

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

  it('rejects empty rule name', () => {
    const rule = {
      type: 'guardrail',
      description: 'test',
      triggers: { file: { pathPatterns: ['**/*.sql'] } }
    };
    const result = learn.add('', rule, learnedFile);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('non-empty'));
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
});

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

  it('deduplicates cross-format paths (backslash vs forward-slash)', () => {
    // First add a forward-slash pattern
    learn.update('sql-warn', {
      triggers: { file: { pathPatterns: ['src/db/**/*.sql'] } }
    }, learnedFile);
    // Now add the same pattern with backslashes
    const result = learn.update('sql-warn', {
      triggers: { file: { pathPatterns: ['src\\db\\**\\*.sql'] } }
    }, learnedFile);
    assert.equal(result.ok, true);
    const data = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    const patterns = data.rules['sql-warn'].triggers.file.pathPatterns;
    assert.equal(patterns.filter(p => p === 'src/db/**/*.sql').length, 1);
  });
});

describe('promote', () => {
  let tmpDir;
  let learnedFile;
  let rulesFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-test-'));
    learnedFile = path.join(tmpDir, 'learned-rules.json');
    rulesFile = path.join(tmpDir, 'skill-rules.json');
    learn.add('promote-me', {
      type: 'guardrail',
      enforcement: 'warn',
      priority: 'medium',
      description: 'A rule to promote',
      triggers: { file: { pathPatterns: ['**/*.sql'] } }
    }, learnedFile);
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
      { encoding: 'utf8', shell: 'bash' }
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
      { encoding: 'utf8', shell: 'bash' }
    );
    const output = execSync(
      `node "${learnScript}" list --file "${learnedFile}"`,
      { encoding: 'utf8', shell: 'bash' }
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
      { encoding: 'utf8', shell: 'bash' }
    );
    const output = execSync(
      `node "${learnScript}" remove to-delete --file "${learnedFile}"`,
      { encoding: 'utf8', shell: 'bash' }
    );
    assert.ok(output.includes('to-delete'));
    const data = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    assert.equal(data.rules['to-delete'], undefined);
  });

  it('update via CLI merges triggers', () => {
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

  it('add via CLI exits 1 on validation error', () => {
    const ruleJson = JSON.stringify({ type: 'guardrail', description: 'missing triggers' });
    assert.throws(() => {
      execSync(
        `node "${learnScript}" add bad-rule '${ruleJson}' --file "${learnedFile}"`,
        { encoding: 'utf8', shell: 'bash', stdio: ['pipe', 'pipe', 'pipe'] }
      );
    });
  });
});
