const { describe, it, after, beforeEach, afterEach } = require('node:test');
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

  it('matchIntent returns false for invalid regex pattern', () => {
    assert.equal(engine.matchIntent('anything', ['[invalid']), false);
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

  it('re-exports glob functions from shared module', () => {
    assert.equal(typeof engine.normalizePath, 'function');
    assert.equal(typeof engine.globToRegex, 'function');
    assert.equal(typeof engine.matchPath, 'function');
    // Quick smoke test — detailed tests are in glob-match.test.js
    assert.equal(engine.matchPath('src/file.sql', ['**/*.sql'], []), true);
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

describe('Activate', () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures');
  const activateSessionId = 'activate-test-' + Date.now();

  after(() => {
    try { fs.unlinkSync(engine.getSessionStatePath(activateSessionId)); } catch {}
  });

  it('activate returns formatted output for keyword match', () => {
    const rulesData = engine.loadRules(path.join(fixturesDir, 'valid-rules.json'));
    const input = { prompt: 'I need to create a stored proc', session_id: activateSessionId };
    const output = engine.activate(input, rulesData);
    assert.ok(output.includes('Skill Engine'));
    assert.ok(output.includes('sql-standards'));
    assert.ok(output.includes('CRITICAL'));
    assert.ok(output.includes('./sql-standards/SKILL.md'));
  });

  it('activate returns empty string when no matches', () => {
    const rulesData = engine.loadRules(path.join(fixturesDir, 'valid-rules.json'));
    const input = { prompt: 'build a REST API', session_id: activateSessionId };
    const output = engine.activate(input, rulesData);
    assert.equal(output, '');
  });

  it('activate sorts by priority (critical before high)', () => {
    const rulesData = engine.loadRules(path.join(fixturesDir, 'valid-rules.json'));
    const input = { prompt: 'create a stored proc for the pipeline', session_id: activateSessionId };
    const output = engine.activate(input, rulesData);
    const criticalPos = output.indexOf('CRITICAL');
    const highPos = output.indexOf('HIGH');
    assert.ok(criticalPos < highPos, 'CRITICAL should appear before HIGH');
  });

  it('activate respects sessionOnce — skips on second call', () => {
    const rulesData = engine.loadRules(path.join(fixturesDir, 'valid-rules.json'));
    const sid = 'once-test-' + Date.now();
    const input = { prompt: 'check the pipeline', session_id: sid };
    const first = engine.activate(input, rulesData);
    assert.ok(first.includes('pipeline-guidance'));
    const second = engine.activate(input, rulesData);
    assert.ok(!second.includes('pipeline-guidance'), 'sessionOnce rule should not fire twice');
    try { fs.unlinkSync(engine.getSessionStatePath(sid)); } catch {}
  });

  it('activate returns empty string when rulesData is null', () => {
    assert.equal(engine.activate({ prompt: 'anything' }, null), '');
  });

  it('activate returns empty string when prompt is empty', () => {
    const rulesData = engine.loadRules(path.join(fixturesDir, 'valid-rules.json'));
    assert.equal(engine.activate({ prompt: '' }, rulesData), '');
  });
});

describe('Enforce', () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures');

  it('enforce returns exit 2 for block rule matching file path + content', () => {
    const rulesData = engine.loadRules(path.join(fixturesDir, 'valid-rules.json'));
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(fixturesDir, 'sample.sql') },
      session_id: 'enforce-test-1'
    };
    const result = engine.enforce(input, rulesData);
    assert.equal(result.exit, 2);
    assert.ok(result.stderr.includes('SQL standards apply'));
  });

  it('enforce returns exit 0 for warn rule', () => {
    const rulesData = engine.loadRules(path.join(fixturesDir, 'valid-rules.json'));
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(fixturesDir, 'sample.config') },
      session_id: 'enforce-test-2'
    };
    const result = engine.enforce(input, rulesData);
    assert.equal(result.exit, 0);
    assert.ok(result.stderr.includes('config-warning'));
  });

  it('enforce returns silent exit 0 when no rules match', () => {
    const rulesData = engine.loadRules(path.join(fixturesDir, 'valid-rules.json'));
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: '/some/path/readme.md' },
      session_id: 'enforce-test-3'
    };
    const result = engine.enforce(input, rulesData);
    assert.equal(result.exit, 0);
    assert.equal(result.stderr, undefined);
  });

  it('enforce skips rule when file has skip marker', () => {
    const rulesData = engine.loadRules(path.join(fixturesDir, 'valid-rules.json'));
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(fixturesDir, 'sample-skip.sql') },
      session_id: 'enforce-test-4'
    };
    const result = engine.enforce(input, rulesData);
    assert.equal(result.exit, 0, 'skip marker should prevent block');
  });

  it('enforce skips rule when env var is set', () => {
    process.env.SKIP_SQL_STANDARDS = '1';
    const rulesData = engine.loadRules(path.join(fixturesDir, 'valid-rules.json'));
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(fixturesDir, 'sample.sql') },
      session_id: 'enforce-test-5'
    };
    const result = engine.enforce(input, rulesData);
    assert.equal(result.exit, 0, 'env var skip should prevent block');
    delete process.env.SKIP_SQL_STANDARDS;
  });

  it('enforce returns exit 0 when rulesData is null', () => {
    const result = engine.enforce({ tool_name: 'Edit', tool_input: { file_path: 'file.sql' } }, null);
    assert.equal(result.exit, 0);
  });

  it('enforce returns exit 0 when file_path is missing', () => {
    const rulesData = engine.loadRules(path.join(fixturesDir, 'valid-rules.json'));
    const result = engine.enforce({ tool_name: 'Edit', tool_input: {} }, rulesData);
    assert.equal(result.exit, 0);
  });

  it('enforce only checks guardrail-type rules', () => {
    const rulesData = engine.loadRules(path.join(fixturesDir, 'valid-rules.json'));
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: '/project/pipeline/main.json' },
      session_id: 'enforce-test-6'
    };
    const result = engine.enforce(input, rulesData);
    assert.equal(result.exit, 0);
  });
});

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
    const merged = { ...mainData, rules: { ...learnedData.rules, ...mainData.rules } };

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
    const merged = { ...mainData, rules: { ...(learnedData ? learnedData.rules : {}), ...mainData.rules } };
    const out = engine.activate({ prompt: 'test solo', session_id: 'merge-6' }, merged);
    assert.ok(out.includes('only-main'));
  });
});
