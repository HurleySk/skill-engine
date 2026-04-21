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
