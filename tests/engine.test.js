const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const engine = require(path.resolve(__dirname, '..', 'hooks', 'lib', 'engine.js'));

describe('Rules Loading', () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures');

  it('loadRules returns parsed data for valid rules file', () => {
    const result = engine.loadRules(path.join(fixturesDir, 'valid-rules.json'));
    assert.equal(result.version, '1.0');
    assert.ok(result.rules['sql-standards']);
    assert.ok(result.rules['pipeline-guidance']);
    assert.ok(result.rules['config-warning']);
    assert.equal(result.defaults.enforcement, 'suggest');
    assert.equal(result.defaults.priority, 'medium');
  });

  it('loadRules returns null for missing file', () => {
    const result = engine.loadRules('/nonexistent/path/rules.json');
    assert.equal(result, null);
  });

  it('loadRules returns null for malformed JSON', () => {
    const result = engine.loadRules(path.join(fixturesDir, 'malformed.json'));
    assert.equal(result, null);
  });

  it('loadRules returns null for JSON without version field', () => {
    const tmpFile = path.join(os.tmpdir(), 'no-version.json');
    fs.writeFileSync(tmpFile, JSON.stringify({ rules: {} }));
    const result = engine.loadRules(tmpFile);
    assert.equal(result, null);
    fs.unlinkSync(tmpFile);
  });

  it('findRulesFile walks up directories to find skill-rules.json', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'se-test-'));
    const projectDir = path.join(tmpBase, 'project');
    const srcDir = path.join(projectDir, 'src', 'deep');
    const rulesDir = path.join(projectDir, '.claude', 'skills');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(rulesDir, { recursive: true });
    const rulesFile = path.join(rulesDir, 'skill-rules.json');
    fs.writeFileSync(rulesFile, '{"version":"1.0","rules":{}}');
    const found = engine.findRulesFile(srcDir);
    assert.equal(found, rulesFile);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('findRulesFile returns null when no rules file exists', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'se-test-'));
    const result = engine.findRulesFile(tmpBase);
    assert.equal(result, null);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });
});

describe('Prompt Matching', () => {
  it('matchKeywords finds case-insensitive substring match', () => {
    assert.equal(engine.matchKeywords('Create a stored proc', ['stored proc']), true);
    assert.equal(engine.matchKeywords('STORED PROC generation', ['stored proc']), true);
    assert.equal(engine.matchKeywords('I need a new sproc', ['stored proc', 'sproc']), true);
  });

  it('matchKeywords returns false when no keywords match', () => {
    assert.equal(engine.matchKeywords('build a REST API', ['stored proc', 'sproc']), false);
  });

  it('matchKeywords returns false for empty/missing keywords', () => {
    assert.equal(engine.matchKeywords('anything', []), false);
    assert.equal(engine.matchKeywords('anything', null), false);
    assert.equal(engine.matchKeywords('anything', undefined), false);
  });

  it('matchIntent finds regex pattern match', () => {
    assert.equal(engine.matchIntent('create a new procedure', ['(create|modify).*?proc']), true);
    assert.equal(engine.matchIntent('modify the stored procedure', ['(create|modify).*?proc']), true);
  });

  it('matchIntent returns false when no patterns match', () => {
    assert.equal(engine.matchIntent('delete the table', ['(create|modify).*?proc']), false);
  });

  it('matchIntent returns false for empty/missing patterns', () => {
    assert.equal(engine.matchIntent('anything', []), false);
    assert.equal(engine.matchIntent('anything', null), false);
  });

  it('matchPromptTriggers combines keywords and intent patterns with OR', () => {
    const rule = {
      triggers: { prompt: { keywords: ['pipeline'], intentPatterns: ['(debug|fix).*?pipeline'] } }
    };
    assert.equal(engine.matchPromptTriggers('check the pipeline', rule), true);
    assert.equal(engine.matchPromptTriggers('debug the data flow pipeline', rule), true);
    assert.equal(engine.matchPromptTriggers('build a REST API', rule), false);
  });

  it('matchPromptTriggers returns false when no prompt triggers defined', () => {
    assert.equal(engine.matchPromptTriggers('anything', { triggers: { file: {} } }), false);
  });

  it('matchPromptTriggers returns false when triggers object is missing', () => {
    assert.equal(engine.matchPromptTriggers('anything', {}), false);
    assert.equal(engine.matchPromptTriggers('anything', { triggers: {} }), false);
  });
});

describe('File Path Matching', () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures');

  it('normalizePath converts backslashes to forward slashes', () => {
    assert.equal(engine.normalizePath('C:\\Users\\test\\file.sql'), 'C:/Users/test/file.sql');
    assert.equal(engine.normalizePath('src/db/file.sql'), 'src/db/file.sql');
  });

  it('matchPath matches glob patterns', () => {
    assert.equal(engine.matchPath('src/db/sprocs/GetUsers.sql', ['**/*.sql'], []), true);
    assert.equal(engine.matchPath('deep/nested/path/file.sql', ['**/*.sql'], []), true);
    assert.equal(engine.matchPath('file.txt', ['**/*.sql'], []), false);
  });

  it('matchPath respects exclusions', () => {
    assert.equal(engine.matchPath('migrations/001.sql', ['**/*.sql'], ['**/migrations/**']), false);
    assert.equal(engine.matchPath('src/db/GetUsers.sql', ['**/*.sql'], ['**/migrations/**']), true);
  });

  it('matchPath handles Windows backslash paths', () => {
    assert.equal(engine.matchPath('src\\db\\file.sql', ['**/*.sql'], []), true);
  });

  it('matchPath returns false for empty patterns', () => {
    assert.equal(engine.matchPath('file.sql', [], []), false);
    assert.equal(engine.matchPath('file.sql', null, []), false);
  });

  it('matchContent finds regex in file contents', () => {
    const sqlFile = path.join(fixturesDir, 'sample.sql');
    assert.equal(engine.matchContent(sqlFile, ['CREATE\\s+PROC']), true);
    assert.equal(engine.matchContent(sqlFile, ['DROP\\s+TABLE']), false);
  });

  it('matchContent returns false for missing file', () => {
    assert.equal(engine.matchContent('/nonexistent/file.sql', ['CREATE\\s+PROC']), false);
  });

  it('matchContent returns false for empty patterns', () => {
    const sqlFile = path.join(fixturesDir, 'sample.sql');
    assert.equal(engine.matchContent(sqlFile, []), false);
    assert.equal(engine.matchContent(sqlFile, null), false);
  });

  it('matchFileTriggers combines path and content checks', () => {
    const sqlFile = path.join(fixturesDir, 'sample.sql');
    const blockRule = {
      enforcement: 'block',
      triggers: { file: { pathPatterns: ['**/*.sql'], pathExclusions: ['**/migrations/**'], contentPatterns: ['CREATE\\s+PROC'] } }
    };
    assert.equal(engine.matchFileTriggers(sqlFile, blockRule), true);
  });

  it('matchFileTriggers skips content check for non-block rules', () => {
    const sqlFile = path.join(fixturesDir, 'sample.sql');
    const warnRule = {
      enforcement: 'warn',
      triggers: { file: { pathPatterns: ['**/*.sql'], contentPatterns: ['THIS_WONT_MATCH'] } }
    };
    assert.equal(engine.matchFileTriggers(sqlFile, warnRule), true);
  });

  it('matchFileTriggers returns false when path excluded', () => {
    const sqlFile = path.join(fixturesDir, 'sample.sql');
    const rule = { enforcement: 'block', triggers: { file: { pathPatterns: ['**/*.sql'], pathExclusions: ['**/fixtures/**'] } } };
    assert.equal(engine.matchFileTriggers(sqlFile, rule), false);
  });

  it('matchFileTriggers returns false when no file triggers', () => {
    assert.equal(engine.matchFileTriggers('file.sql', { triggers: {} }), false);
    assert.equal(engine.matchFileTriggers('file.sql', {}), false);
  });
});

describe('Skip Conditions', () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures');
  const testSessionId = 'test-session-' + Date.now();

  after(() => {
    try { fs.unlinkSync(engine.getSessionStatePath(testSessionId)); } catch {}
  });

  it('checkSkip returns true when env var is set', () => {
    process.env.SKIP_SQL_STANDARDS = '1';
    const rule = { skipConditions: { envVars: ['SKIP_SQL_STANDARDS'] } };
    assert.equal(engine.checkSkip('sql-standards', rule, null, null), true);
    delete process.env.SKIP_SQL_STANDARDS;
  });

  it('checkSkip returns false when env var is not set', () => {
    delete process.env.SKIP_SQL_STANDARDS;
    const rule = { skipConditions: { envVars: ['SKIP_SQL_STANDARDS'] } };
    assert.equal(engine.checkSkip('sql-standards', rule, null, null), false);
  });

  it('checkSkip returns true when file contains marker', () => {
    const skipFile = path.join(fixturesDir, 'sample-skip.sql');
    const rule = { skipConditions: { fileMarkers: ['-- @skip-sql-standards'] } };
    assert.equal(engine.checkSkip('sql-standards', rule, null, skipFile), true);
  });

  it('checkSkip returns false when file does not contain marker', () => {
    const sqlFile = path.join(fixturesDir, 'sample.sql');
    const rule = { skipConditions: { fileMarkers: ['-- @skip-sql-standards'] } };
    assert.equal(engine.checkSkip('sql-standards', rule, null, sqlFile), false);
  });

  it('checkSkip returns false for non-existent file with markers', () => {
    const rule = { skipConditions: { fileMarkers: ['-- @skip-sql-standards'] } };
    assert.equal(engine.checkSkip('sql-standards', rule, null, '/nonexistent.sql'), false);
  });

  it('session state read returns empty state for new session', () => {
    const state = engine.readSessionState('nonexistent-session');
    assert.deepEqual(state, { firedRules: [] });
  });

  it('session state write and read round-trip', () => {
    engine.writeSessionState(testSessionId, { firedRules: ['rule-a', 'rule-b'] });
    const state = engine.readSessionState(testSessionId);
    assert.deepEqual(state.firedRules, ['rule-a', 'rule-b']);
  });

  it('checkSkip returns true for sessionOnce when rule already fired', () => {
    engine.writeSessionState(testSessionId, { firedRules: ['my-rule'] });
    const rule = { skipConditions: { sessionOnce: true } };
    assert.equal(engine.checkSkip('my-rule', rule, testSessionId, null), true);
  });

  it('checkSkip returns false for sessionOnce when rule not yet fired', () => {
    engine.writeSessionState(testSessionId, { firedRules: ['other-rule'] });
    const rule = { skipConditions: { sessionOnce: true } };
    assert.equal(engine.checkSkip('new-rule', rule, testSessionId, null), false);
  });

  it('checkSkip returns false when no skipConditions defined', () => {
    assert.equal(engine.checkSkip('rule', {}, null, null), false);
    assert.equal(engine.checkSkip('rule', { skipConditions: null }, null, null), false);
  });
});
