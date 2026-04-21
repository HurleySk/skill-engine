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
