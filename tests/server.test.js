const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { startTestServer, stopTestServer, writeRules, request, requestRaw } = require('./test-harness');

describe('Server Health', () => {
  let harness;
  const PORT = 19751;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'test-rule': { type: 'domain', description: 'Test rule',
        triggers: { prompt: { keywords: ['test-keyword'] } } } }
    });
  });

  after(() => { stopTestServer(harness); });

  it('GET /health returns server status', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.uptime, 'number');
    assert.equal(res.body.rulesLoaded, 1);
    assert.equal(typeof res.body.port, 'number');
  });

  it('GET /health includes timing stats', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(typeof res.body.avgResponseTimeMs, 'number');
  });

  it('GET /health includes version from plugin.json', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.version, 'string');
    assert.ok(res.body.version.match(/^\d+\.\d+\.\d+$/), 'version should be semver');
  });

  it('GET /health includes pid as a number', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.pid, 'number');
    assert.ok(res.body.pid > 0, 'pid should be positive');
  });

  it('POST to unknown route returns 200 with empty body (fail-open for hooks)', async () => {
    const res = await request('POST', '/nonexistent-endpoint', { foo: 'bar' }, PORT);
    assert.equal(res.status, 200);
    assert.deepStrictEqual(res.body, {});
  });

  it('GET to unknown route returns 404', async () => {
    const res = await request('GET', '/nonexistent-endpoint', null, PORT);
    assert.equal(res.status, 404);
  });

  it('POST /stop returns empty when no stop rules exist', async () => {
    const res = await request('POST', '/stop', { session_id: 'no-stop-rules' }, PORT);
    assert.equal(res.status, 200);
    assert.deepStrictEqual(res.body, {});
  });
});

describe('Activate Endpoint', () => {
  let harness;
  const PORT = 19752;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'test-rule': {
          type: 'domain',
          description: 'Test rule',
          skillPath: './test/SKILL.md',
          triggers: { prompt: { keywords: ['test-keyword'] } },
          skipConditions: { sessionOnce: true }
        },
        'high-rule': {
          type: 'domain',
          description: 'High priority rule',
          priority: 'high',
          triggers: { prompt: { keywords: ['high-keyword'] } }
        }
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('returns skill suggestions for matching prompt', async () => {
    const res = await request('POST', '/activate', { prompt: 'check the test-keyword here' }, PORT);
    assert.equal(res.status, 200);
    const ctx = res.body.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('test-rule'), 'additionalContext should include test-rule');
    assert.ok(ctx.includes('Skill Engine'), 'additionalContext should include Skill Engine header');
    assert.equal(res.body.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  });

  it('returns empty result for non-matching prompt', async () => {
    const res = await request('POST', '/activate', { prompt: 'nothing relevant' }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should have no hookSpecificOutput');
  });

  it('respects sessionOnce — first call includes rule, second does not', async () => {
    const body = { prompt: 'check the test-keyword', session_id: 'sess-once-test' };
    const first = await request('POST', '/activate', body, PORT);
    assert.ok(first.body.hookSpecificOutput.additionalContext.includes('test-rule'), 'first call should include test-rule');
    const second = await request('POST', '/activate', body, PORT);
    assert.ok(!second.body.hookSpecificOutput, 'second call should not include test-rule');
  });

  it('sorts by priority — HIGH appears before MEDIUM', async () => {
    const res = await request('POST', '/activate', { prompt: 'test-keyword and high-keyword together' }, PORT);
    assert.equal(res.status, 200);
    const ctx = res.body.hookSpecificOutput.additionalContext;
    const highIdx = ctx.indexOf('[HIGH]');
    const medIdx = ctx.indexOf('[MEDIUM]');
    assert.ok(highIdx !== -1, 'should contain HIGH priority');
    assert.ok(medIdx !== -1, 'should contain MEDIUM priority');
    assert.ok(highIdx < medIdx, 'HIGH should appear before MEDIUM');
  });

  it('POST /activate returns X-Response-Time header', async () => {
    const res = await requestRaw('POST', '/activate', { prompt: 'test-keyword', session_id: 'timing-1' }, PORT);
    assert.ok(res.headers['x-response-time'], 'should have X-Response-Time header');
    assert.ok(res.headers['x-response-time'].endsWith('ms'), 'should end with ms');
  });
});

describe('Enforce Endpoint', () => {
  let harness;
  let testSqlFile;
  const PORT = 19753;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'block-sql': {
          type: 'guardrail',
          description: 'Block SQL procedures',
          enforcement: 'block',
          blockMessage: 'SQL blocked',
          triggers: {
            file: {
              pathPatterns: ['**/*.sql'],
              contentPatterns: ['CREATE\\s+PROC']
            }
          }
        },
        'warn-config': {
          type: 'guardrail',
          description: 'Warn on config files',
          enforcement: 'warn',
          triggers: {
            file: {
              pathPatterns: ['**/*.config']
            }
          }
        },
        'warn-setvariable': {
          type: 'guardrail',
          description: 'SetVariable self-reference warning',
          enforcement: 'warn',
          triggers: {
            file: {
              pathPatterns: ['**/*.json'],
              contentPatterns: ['SetVariable']
            }
          }
        }
      }
    });

    testSqlFile = path.join(harness.tmpDir, 'test.sql');
    fs.writeFileSync(testSqlFile, 'CREATE PROCEDURE [dbo].[Test]\nAS\nBEGIN\n  SELECT 1\nEND');
  });

  after(() => { stopTestServer(harness); });

  it('returns deny for matching guardrail with content pattern', async () => {
    const res = await request('POST', '/enforce', { tool_input: { file_path: testSqlFile } }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.equal(hso.hookEventName, 'PreToolUse');
    assert.equal(hso.permissionDecision, 'deny');
    assert.equal(hso.permissionDecisionReason, 'SQL blocked');
  });

  it('returns warn for matching warn guardrail', async () => {
    const configFile = path.join(harness.tmpDir, 'app.config');
    fs.writeFileSync(configFile, '<configuration />');
    const res = await request('POST', '/enforce', { tool_input: { file_path: configFile } }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.equal(hso.hookEventName, 'PreToolUse');
    assert.equal(hso.permissionDecision, 'allow');
    assert.ok(hso.additionalContext.includes('warn-config'), 'additionalContext should mention warn-config');
  });

  it('returns warn for matching warn guardrail with content pattern', async () => {
    const jsonFile = path.join(harness.tmpDir, 'pipeline.json');
    fs.writeFileSync(jsonFile, '{"type": "SetVariable", "name": "Increment"}');
    const res = await request('POST', '/enforce', { tool_input: { file_path: jsonFile } }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.equal(hso.permissionDecision, 'allow');
    assert.ok(hso.additionalContext.includes('warn-setvariable'));
  });

  it('returns empty for warn guardrail with content pattern that does not match file', async () => {
    const jsonFile = path.join(harness.tmpDir, 'other.json');
    fs.writeFileSync(jsonFile, '{"type": "Copy", "name": "LoadData"}');
    const res = await request('POST', '/enforce', { tool_input: { file_path: jsonFile } }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.ok(!hso, 'should not match without SetVariable content');
  });

  it('returns empty for non-matching file', async () => {
    const txtFile = path.join(harness.tmpDir, 'readme.txt');
    fs.writeFileSync(txtFile, 'hello');
    const res = await request('POST', '/enforce', { tool_input: { file_path: txtFile } }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should have no hookSpecificOutput');
    assert.ok(!res.body.systemMessage, 'should have no systemMessage');
  });

  it('returns empty when file_path is missing', async () => {
    const res = await request('POST', '/enforce', { tool_input: {} }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should have no hookSpecificOutput');
  });
});

describe('Content Exclusions', () => {
  let harness;
  let testSqlFile;
  let testSqlExcluded;
  const PORT = 19780;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'block-sql-excl': {
          type: 'guardrail',
          description: 'Block SQL with exclusion',
          enforcement: 'block',
          blockMessage: 'SQL blocked',
          triggers: {
            file: {
              pathPatterns: ['**/*.sql'],
              contentPatterns: ['CREATE\\s+PROC'],
              contentExclusions: ['-- skip-standards']
            }
          }
        }
      }
    });

    testSqlFile = path.join(harness.tmpDir, 'normal.sql');
    fs.writeFileSync(testSqlFile, 'CREATE PROCEDURE [dbo].[Test]\nAS\nBEGIN\n  SELECT 1\nEND');

    testSqlExcluded = path.join(harness.tmpDir, 'excluded.sql');
    fs.writeFileSync(testSqlExcluded, '-- skip-standards\nCREATE PROCEDURE [dbo].[Safe]\nAS\nBEGIN\n  SELECT 1\nEND');
  });

  after(() => { stopTestServer(harness); });

  it('blocks when content matches pattern but not exclusion', async () => {
    const res = await request('POST', '/enforce', { tool_input: { file_path: testSqlFile } }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.equal(hso.permissionDecision, 'deny');
  });

  it('allows when content matches both pattern and exclusion (exclusion wins)', async () => {
    const res = await request('POST', '/enforce', { tool_input: { file_path: testSqlExcluded } }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'exclusion should suppress the match');
  });

  it('allows when content does not match pattern at all', async () => {
    const safeSql = path.join(harness.tmpDir, 'safe.sql');
    fs.writeFileSync(safeSql, 'SELECT 1');
    const res = await request('POST', '/enforce', { tool_input: { file_path: safeSql } }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'no pattern match means no enforcement');
  });
});

describe('Cross-Project Env Switching', () => {
  let harness;
  let tmpDirB;
  const PORT = 19758;

  before(async () => {
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'se-switch-b-'));
    const rulesDirB = path.join(tmpDirB, '.claude', 'skills');
    fs.mkdirSync(rulesDirB, { recursive: true });
    fs.writeFileSync(path.join(rulesDirB, 'skill-rules.json'), JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'rule-b': { type: 'domain', description: 'Rule B', triggers: { prompt: { keywords: ['beta'] } } } }
    }));

    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'rule-a': { type: 'domain', description: 'Rule A', triggers: { prompt: { keywords: ['alpha'] } } } }
    });
  });

  after(() => { stopTestServer(harness, [tmpDirB]); });

  it('request with env.CLAUDE_PROJECT_DIR switches project context per-request', async () => {
    const resA = await request('POST', '/activate', {
      prompt: 'alpha keyword',
      env: { CLAUDE_PROJECT_DIR: harness.tmpDir }
    }, PORT);
    assert.ok(resA.body.hookSpecificOutput.additionalContext.includes('rule-a'));

    const resB = await request('POST', '/activate', {
      prompt: 'beta keyword',
      env: { CLAUDE_PROJECT_DIR: tmpDirB }
    }, PORT);
    assert.ok(resB.body.hookSpecificOutput.additionalContext.includes('rule-b'));

    const resBnoA = await request('POST', '/activate', {
      prompt: 'alpha keyword',
      env: { CLAUDE_PROJECT_DIR: tmpDirB }
    }, PORT);
    assert.ok(!resBnoA.body.hookSpecificOutput, 'rule-a should not match in project B context');
  });
});

describe('Kill Switch', () => {
  let harness;
  let testSqlFile;
  const PORT = 19755;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'block-rule': {
          type: 'guardrail',
          description: 'Block SQL files',
          enforcement: 'block',
          blockMessage: 'SQL blocked',
          triggers: {
            file: {
              pathPatterns: ['**/*.sql']
            }
          }
        }
      }
    }, { env: { SKILL_ENGINE_OFF: '1' } });

    testSqlFile = path.join(harness.tmpDir, 'test.sql');
    fs.writeFileSync(testSqlFile, 'SELECT 1');
  });

  after(() => { stopTestServer(harness); });

  it('activate returns empty when SKILL_ENGINE_OFF=1', async () => {
    const res = await request('POST', '/activate', { prompt: 'anything matching block-rule' }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should have no hookSpecificOutput');
  });

  it('enforce returns empty when SKILL_ENGINE_OFF=1', async () => {
    const res = await request('POST', '/enforce', { tool_input: { file_path: testSqlFile } }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should have no hookSpecificOutput');
  });
});

describe('Pause / Resume', () => {
  let harness;
  let testSqlFile;
  const PORT = 19756;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'block-rule': {
          type: 'guardrail',
          description: 'Block SQL files',
          enforcement: 'block',
          blockMessage: 'SQL blocked',
          triggers: {
            file: {
              pathPatterns: ['**/*.sql']
            }
          }
        },
        'activate-rule': {
          type: 'domain',
          description: 'Activate test rule',
          triggers: { prompt: { keywords: ['activate-test'] } }
        }
      }
    });

    testSqlFile = path.join(harness.tmpDir, 'test.sql');
    fs.writeFileSync(testSqlFile, 'SELECT 1');
  });

  after(() => { stopTestServer(harness); });

  it('POST /pause returns {paused: true} with status 200', async () => {
    const res = await request('POST', '/pause', null, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.paused, true);
  });

  it('GET /health shows paused: true after pause', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.paused, true);
  });

  it('POST /enforce returns {} (no hookSpecificOutput) when paused', async () => {
    const res = await request('POST', '/enforce', { tool_input: { file_path: testSqlFile } }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should have no hookSpecificOutput when paused');
  });

  it('POST /activate returns {} (no hookSpecificOutput) when paused', async () => {
    const res = await request('POST', '/activate', { prompt: 'activate-test keyword' }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should have no hookSpecificOutput when paused');
  });

  it('POST /resume returns {paused: false} with status 200', async () => {
    const res = await request('POST', '/resume', null, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.paused, false);
  });

  it('GET /health shows paused: false after resume', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.paused, false);
  });

  it('POST /enforce blocks again after resume', async () => {
    const res = await request('POST', '/enforce', { tool_input: { file_path: testSqlFile } }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.ok(hso, 'should have hookSpecificOutput after resume');
    assert.equal(hso.permissionDecision, 'deny');
  });

  it('POST /activate matches again after resume', async () => {
    const res = await request('POST', '/activate', { prompt: 'activate-test keyword' }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.ok(hso, 'should have hookSpecificOutput after resume');
    assert.ok(hso.additionalContext.includes('activate-rule'), 'additionalContext should include activate-rule');
  });
});

describe('Tool Name Filtering', () => {
  let harness;
  let testSqlFile;
  const PORT = 19757;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'edit-only-rule': {
          type: 'guardrail',
          description: 'Only blocks Edit tool',
          enforcement: 'block',
          blockMessage: 'Edit only',
          triggers: {
            file: {
              toolNames: ['Edit'],
              pathPatterns: ['**/*.sql']
            }
          }
        },
        'any-tool-rule': {
          type: 'guardrail',
          description: 'Blocks any write tool',
          enforcement: 'block',
          blockMessage: 'Any tool blocked',
          triggers: {
            file: {
              pathPatterns: ['**/*.config']
            }
          }
        }
      }
    });

    testSqlFile = path.join(harness.tmpDir, 'test.sql');
    fs.writeFileSync(testSqlFile, 'SELECT 1');
  });

  after(() => { stopTestServer(harness); });

  it('blocks when tool_name matches rule toolNames', async () => {
    const res = await request('POST', '/enforce', {
      tool_name: 'Edit',
      tool_input: { file_path: testSqlFile }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(res.body.hookSpecificOutput.permissionDecisionReason, 'Edit only');
  });

  it('skips rule when tool_name does not match rule toolNames', async () => {
    const res = await request('POST', '/enforce', {
      tool_name: 'Write',
      tool_input: { file_path: testSqlFile }
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should not enforce for non-matching tool');
  });

  it('enforces rule without toolNames for any tool_name', async () => {
    const configFile = path.join(harness.tmpDir, 'app.config');
    fs.writeFileSync(configFile, '<configuration />');
    const res = await request('POST', '/enforce', {
      tool_name: 'Write',
      tool_input: { file_path: configFile }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
  });

  it('enforces rule without toolNames even when tool_name is absent', async () => {
    const configFile = path.join(harness.tmpDir, 'app.config');
    fs.writeFileSync(configFile, '<configuration />');
    const res = await request('POST', '/enforce', {
      tool_input: { file_path: configFile }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
  });
});

describe('Enforce-Tool Endpoint', () => {
  let harness;
  const PORT = 19759;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'no-force-push': {
          type: 'guardrail',
          enforcement: 'block',
          priority: 'high',
          description: 'Force push is not allowed',
          blockMessage: 'Blocked: force push detected',
          triggers: {
            tool: {
              toolNames: ['Bash', 'PowerShell'],
              inputPatterns: ['push\\s+(--force|-f)']
            }
          }
        },
        'warn-rm-rf': {
          type: 'guardrail',
          enforcement: 'warn',
          priority: 'medium',
          description: 'Dangerous rm -rf detected',
          triggers: {
            tool: {
              toolNames: ['Bash'],
              inputPatterns: ['rm\\s+-rf']
            }
          }
        }
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('blocks matching tool input pattern', async () => {
    const res = await request('POST', '/enforce-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin main' }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(res.body.hookSpecificOutput.permissionDecisionReason, 'Blocked: force push detected');
  });

  it('blocks with -f shorthand', async () => {
    const res = await request('POST', '/enforce-tool', {
      tool_name: 'PowerShell',
      tool_input: { command: 'git push -f origin main' }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
  });

  it('returns empty for non-matching tool name', async () => {
    const res = await request('POST', '/enforce-tool', {
      tool_name: 'Read',
      tool_input: { command: 'git push --force' }
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should not match Read tool');
  });

  it('returns empty for non-matching input', async () => {
    const res = await request('POST', '/enforce-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' }
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should not match regular push');
  });

  it('warns for warn-enforcement rules', async () => {
    const res = await request('POST', '/enforce-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/stuff' }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'allow');
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('warn-rm-rf'));
  });

  it('returns X-Response-Time header', async () => {
    const res = await requestRaw('POST', '/enforce-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' }
    }, PORT);
    assert.ok(res.headers['x-response-time'], 'should have X-Response-Time header');
  });

  it('health shows hasToolTriggerRules true', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.body.hasToolTriggerRules, true);
  });
});

describe('Enforce-Tool Short-Circuit', () => {
  let harness;
  const PORT = 19760;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'file-only-rule': {
          type: 'guardrail',
          enforcement: 'block',
          description: 'File-only rule',
          triggers: { file: { pathPatterns: ['**/*.sql'] } }
        }
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('returns empty immediately when no tool trigger rules exist', async () => {
    const res = await request('POST', '/enforce-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'anything' }
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput);
  });

  it('health shows hasToolTriggerRules false', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.body.hasToolTriggerRules, false);
    assert.equal(res.body.hasOutputTriggerRules, false);
    assert.equal(res.body.hasStopRules, false);
  });
});

describe('Post-Tool Endpoint', () => {
  let harness;
  const PORT = 19761;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'test-after-edit': {
          type: 'domain',
          enforcement: 'suggest',
          priority: 'medium',
          description: 'Run tests after editing TypeScript files',
          guidance: 'You edited a TypeScript file. Run npm test.',
          triggers: {
            output: {
              toolNames: ['Edit', 'Write'],
              outputPatterns: ['\\.ts']
            }
          },
          skipConditions: { sessionOnce: true }
        },
        'high-prio-output': {
          type: 'domain',
          enforcement: 'suggest',
          priority: 'high',
          description: 'High priority output rule',
          guidance: 'High priority guidance.',
          triggers: {
            output: {
              toolNames: ['Edit'],
              outputPatterns: ['\\.ts']
            }
          }
        }
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('injects guidance for matching tool output', async () => {
    const res = await request('POST', '/post-tool', {
      tool_name: 'Edit',
      tool_output: 'edited file src/app.ts successfully'
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('Run npm test'));
  });

  it('returns empty for non-matching tool name', async () => {
    const res = await request('POST', '/post-tool', {
      tool_name: 'Bash',
      tool_output: 'edited file src/app.ts'
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should not match Bash tool');
  });

  it('returns empty for non-matching output', async () => {
    const res = await request('POST', '/post-tool', {
      tool_name: 'Edit',
      tool_output: 'edited file src/app.js successfully'
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should not match .js output');
  });

  it('respects sessionOnce — second call skips fired rule', async () => {
    const body = { tool_name: 'Edit', tool_output: 'file.ts edited', session_id: 'post-once' };
    const first = await request('POST', '/post-tool', body, PORT);
    assert.ok(first.body.hookSpecificOutput.additionalContext.includes('Run npm test'));
    const second = await request('POST', '/post-tool', body, PORT);
    const ctx = second.body.hookSpecificOutput ? second.body.hookSpecificOutput.additionalContext : '';
    assert.ok(!ctx.includes('Run npm test'), 'sessionOnce rule should not fire again');
  });

  it('sorts by priority — high before medium', async () => {
    const res = await request('POST', '/post-tool', {
      tool_name: 'Edit',
      tool_output: 'edited app.ts',
      session_id: 'prio-test'
    }, PORT);
    const ctx = res.body.hookSpecificOutput.additionalContext;
    const highIdx = ctx.indexOf('High priority guidance');
    const medIdx = ctx.indexOf('Run npm test');
    assert.ok(highIdx < medIdx, 'HIGH should appear before MEDIUM');
  });

  it('health shows hasOutputTriggerRules true', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.body.hasOutputTriggerRules, true);
  });
});

describe('Stop Endpoint', () => {
  let harness;
  const PORT = 19762;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'commit-reminder': {
          type: 'domain',
          enforcement: 'suggest',
          priority: 'low',
          description: 'Remember to commit',
          guidance: 'Consider committing your changes before ending.',
          hookEvents: ['Stop'],
          triggers: {},
          skipConditions: { sessionOnce: true }
        },
        'test-reminder': {
          type: 'domain',
          enforcement: 'suggest',
          priority: 'high',
          description: 'Run tests before stopping',
          guidance: 'Have you run the test suite?',
          hookEvents: ['Stop'],
          triggers: {}
        }
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('fires Stop rules and blocks with reason', async () => {
    const res = await request('POST', '/stop', { session_id: 'stop-test-1' }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.decision, 'block');
    assert.ok(res.body.reason.includes('committing'));
    assert.ok(res.body.reason.includes('test suite'));
  });

  it('respects sessionOnce — second call skips once-only rule', async () => {
    const body = { session_id: 'stop-once' };
    const first = await request('POST', '/stop', body, PORT);
    assert.ok(first.body.reason.includes('committing'));
    const second = await request('POST', '/stop', body, PORT);
    const reason = second.body.reason;
    assert.ok(!reason.includes('committing'), 'sessionOnce commit rule should not fire again');
    assert.ok(reason.includes('test suite'), 'non-sessionOnce rule should still fire');
  });

  it('sorts by priority — high before low', async () => {
    const res = await request('POST', '/stop', { session_id: 'stop-prio' }, PORT);
    const reason = res.body.reason;
    const highIdx = reason.indexOf('test suite');
    const lowIdx = reason.indexOf('committing');
    assert.ok(highIdx < lowIdx, 'HIGH should appear before LOW');
  });

  it('health shows hasStopRules true', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.body.hasStopRules, true);
  });
});

describe('Cross-Repo Rule Isolation', () => {
  let harness;
  let tmpDirB;
  let rulesDirB;
  let testFileB;
  const PORT = 19763;

  before(async () => {
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'se-repoB-'));
    rulesDirB = path.join(tmpDirB, '.claude', 'skills');
    fs.mkdirSync(rulesDirB, { recursive: true });

    // We need tmpDirA's path to set sourceRepo, but startTestServer creates it.
    // So we create tmpDirA manually first to know its path, then pass it as a constraint.
    // Actually, we can start the server first, then write the rules with the known path.
    // But the harness writes rules before spawning. So we need to create a tmpDir ourselves
    // to know the normalized path for sourceRepo.
    const tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'se-repoA-'));
    const rulesDirA = path.join(tmpDirA, '.claude', 'skills');
    fs.mkdirSync(rulesDirA, { recursive: true });

    const normalizedA = tmpDirA.replace(/\\/g, '/');

    const rulesA = {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'scoped-to-a': {
          type: 'guardrail',
          enforcement: 'block',
          description: 'Rule scoped to repo A',
          blockMessage: 'Blocked by repo-A rule',
          sourceRepo: normalizedA,
          triggers: {
            file: { pathPatterns: ['**/pipeline/*.json'] }
          }
        },
        'global-rule': {
          type: 'guardrail',
          enforcement: 'block',
          description: 'Global rule (no sourceRepo)',
          blockMessage: 'Blocked by global rule',
          triggers: {
            file: { pathPatterns: ['**/*.dangerous'] }
          }
        },
        'scoped-activate': {
          type: 'domain',
          enforcement: 'suggest',
          description: 'Activation rule scoped to repo A',
          sourceRepo: normalizedA,
          triggers: { prompt: { keywords: ['scoped-keyword'] } }
        },
        'global-activate': {
          type: 'domain',
          enforcement: 'suggest',
          description: 'Global activation rule',
          triggers: { prompt: { keywords: ['global-keyword'] } }
        }
      }
    };

    // Write the same rules into both dirs so we can test scoping via per-request env
    fs.writeFileSync(path.join(rulesDirA, 'learned-rules.json'), JSON.stringify(rulesA));
    fs.writeFileSync(path.join(rulesDirB, 'learned-rules.json'), JSON.stringify(rulesA));

    // Create test files in repo B
    const pipelineDir = path.join(tmpDirB, 'pipeline');
    fs.mkdirSync(pipelineDir, { recursive: true });
    testFileB = path.join(pipelineDir, 'config.json');
    fs.writeFileSync(testFileB, '{}');

    // Start server with default project A — we need to use the manually created tmpDirA
    const { spawn } = require('child_process');
    const SERVER_PATH = path.resolve(__dirname, '..', 'server', 'server.js');
    const serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT)], {
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

    harness = { tmpDir: tmpDirA, rulesDir: rulesDirA, serverProcess, port: PORT };
  });

  after(() => { stopTestServer(harness, [tmpDirB]); });

  it('rule with matching sourceRepo fires when request targets that repo', async () => {
    const fileInA = path.join(harness.tmpDir, 'pipeline', 'config.json');
    const dirA = path.dirname(fileInA);
    if (!fs.existsSync(dirA)) fs.mkdirSync(dirA, { recursive: true });
    fs.writeFileSync(fileInA, '{}');
    const res = await request('POST', '/enforce', {
      tool_input: { file_path: fileInA },
      env: { CLAUDE_PROJECT_DIR: harness.tmpDir }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(res.body.hookSpecificOutput.permissionDecisionReason, 'Blocked by repo-A rule');
  });

  it('rule with non-matching sourceRepo is skipped when request targets different repo', async () => {
    const res = await request('POST', '/enforce', {
      tool_input: { file_path: testFileB },
      env: { CLAUDE_PROJECT_DIR: tmpDirB }
    }, PORT);
    assert.equal(res.status, 200);
    // scoped-to-a should NOT fire because sourceRepo is repo A, but request targets repo B
    const hso = res.body.hookSpecificOutput;
    if (hso && hso.permissionDecision === 'deny') {
      assert.notEqual(hso.permissionDecisionReason, 'Blocked by repo-A rule',
        'scoped rule from repo A should not fire in repo B');
    }
  });

  it('rule without sourceRepo (global) fires in any repo', async () => {
    const dangerousFile = path.join(tmpDirB, 'bad.dangerous');
    fs.writeFileSync(dangerousFile, 'danger');
    const res = await request('POST', '/enforce', {
      tool_input: { file_path: dangerousFile },
      env: { CLAUDE_PROJECT_DIR: tmpDirB }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(res.body.hookSpecificOutput.permissionDecisionReason, 'Blocked by global rule');
  });

  it('scoped activation rule is skipped in different repo', async () => {
    const res = await request('POST', '/activate', {
      prompt: 'check scoped-keyword here',
      env: { CLAUDE_PROJECT_DIR: tmpDirB }
    }, PORT);
    assert.equal(res.status, 200);
    // scoped-activate should NOT fire
    const hso = res.body.hookSpecificOutput;
    if (hso && hso.additionalContext) {
      assert.ok(!hso.additionalContext.includes('scoped-activate'),
        'scoped activation rule should not fire in wrong repo');
    }
  });

  it('global activation rule fires in any repo', async () => {
    const res = await request('POST', '/activate', {
      prompt: 'check global-keyword here',
      env: { CLAUDE_PROJECT_DIR: tmpDirB }
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.hookSpecificOutput, 'global activation rule should fire');
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('global-activate'));
  });

  it('switching env back to repo A re-enables scoped rules', async () => {
    const fileInA = path.join(harness.tmpDir, 'pipeline', 'config.json');
    const res = await request('POST', '/enforce', {
      tool_input: { file_path: fileInA },
      env: { CLAUDE_PROJECT_DIR: harness.tmpDir }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(res.body.hookSpecificOutput.permissionDecisionReason, 'Blocked by repo-A rule');
  });
});

describe('Pre-Write Endpoint — Task Safety', () => {
  let harness;
  const PORT = 19764;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {}
    }, {
      extraFiles: {
        '.claude/safety-rules.json': JSON.stringify({
          prodFactories: ['prd'],
          prodConnections: ['prd', 'ferconlineprod'],
          prodEnvironments: ['spprod', 'PRODSPO'],
          prodDeployStepTypes: ['adf-deploy-pipeline', 'adf-run-pipeline'],
          prodMutationStepTypes: ['sql-deploy-sp'],
          prodUriPatterns: ['ferc.crm9.dynamics.com'],
          devRevertAllowedFactories: ['dev1'],
          blockedExportBranches: ['main', 'master'],
          readOnlyStepTypes: ['sql-query', 'adf-pull'],
          prodUriRegex: 'ferc\\.crm9',
          prodNameRegex: '\\bprod\\b|PRODSPO|spprod'
        })
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('allows non-task file paths (fast exit)', async () => {
    const filePath = path.join(harness.tmpDir, 'README.md').replace(/\\/g, '/');
    const res = await request('POST', '/pre-write', {
      tool_input: { file_path: filePath, content: 'hello' }
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should allow non-task files');
  });

  it('denies task file targeting production factory', async () => {
    const filePath = path.join(harness.tmpDir, 'tasks', 'deploy.json').replace(/\\/g, '/');
    const taskContent = JSON.stringify({
      steps: [{ type: 'adf-deploy-pipeline', factory: 'prd', pipeline: 'SomePipeline' }]
    });
    const res = await request('POST', '/pre-write', {
      tool_input: { file_path: filePath, content: taskContent }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(res.body.hookSpecificOutput.permissionDecisionReason.includes('production factory'));
  });

  it('denies task file targeting production environment', async () => {
    const filePath = path.join(harness.tmpDir, 'tasks', 'test.json').replace(/\\/g, '/');
    const taskContent = JSON.stringify({
      steps: [{ type: 'dataverse-delete', environment: 'spprod' }]
    });
    const res = await request('POST', '/pre-write', {
      tool_input: { file_path: filePath, content: taskContent }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(res.body.hookSpecificOutput.permissionDecisionReason.includes('production environment'));
  });

  it('denies task file targeting production connection with mutation', async () => {
    const filePath = path.join(harness.tmpDir, 'tasks', 'sp.json').replace(/\\/g, '/');
    const taskContent = JSON.stringify({
      steps: [{ type: 'sql-deploy-sp', connection: 'prd', sp: 'p_Test' }]
    });
    const res = await request('POST', '/pre-write', {
      tool_input: { file_path: filePath, content: taskContent }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(res.body.hookSpecificOutput.permissionDecisionReason.includes('production connection'));
  });

  it('asks for read-only sql-query on production connection', async () => {
    const filePath = path.join(harness.tmpDir, 'tasks', 'query.json').replace(/\\/g, '/');
    const taskContent = JSON.stringify({
      steps: [{ type: 'sql-query', connection: 'prd', sql: 'SELECT TOP 10 * FROM Users' }]
    });
    const res = await request('POST', '/pre-write', {
      tool_input: { file_path: filePath, content: taskContent }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'ask');
  });

  it('denies sql-query with DML on production connection', async () => {
    const filePath = path.join(harness.tmpDir, 'tasks', 'dml.json').replace(/\\/g, '/');
    const taskContent = JSON.stringify({
      steps: [{ type: 'sql-query', connection: 'prd', sql: 'DELETE FROM Users WHERE id=1' }]
    });
    const res = await request('POST', '/pre-write', {
      tool_input: { file_path: filePath, content: taskContent }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(res.body.hookSpecificOutput.permissionDecisionReason.includes('DML/DDL'));
  });

  it('allows task file with safe dev steps', async () => {
    const filePath = path.join(harness.tmpDir, 'tasks', 'safe.json').replace(/\\/g, '/');
    const taskContent = JSON.stringify({
      steps: [{ type: 'adf-deploy-pipeline', factory: 'dev1', pipeline: 'TestPipeline' }]
    });
    const res = await request('POST', '/pre-write', {
      tool_input: { file_path: filePath, content: taskContent }
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should allow safe dev task');
  });

  it('allows read-only step types targeting prod (skipped by readOnlyStepTypes)', async () => {
    const filePath = path.join(harness.tmpDir, 'tasks', 'pull.json').replace(/\\/g, '/');
    const taskContent = JSON.stringify({
      steps: [{ type: 'adf-pull', factory: 'prd' }]
    });
    const res = await request('POST', '/pre-write', {
      tool_input: { file_path: filePath, content: taskContent }
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'read-only step types should be allowed');
  });

  it('denies work-repo-export targeting blocked branch', async () => {
    const filePath = path.join(harness.tmpDir, 'tasks', 'export.json').replace(/\\/g, '/');
    const taskContent = JSON.stringify({
      steps: [{ type: 'work-repo-export', branch: 'main' }]
    });
    const res = await request('POST', '/pre-write', {
      tool_input: { file_path: filePath, content: taskContent }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(res.body.hookSpecificOutput.permissionDecisionReason.includes('blocked branch'));
  });

  it('denies dev-revert on non-allowed factory', async () => {
    const filePath = path.join(harness.tmpDir, 'tasks', 'revert.json').replace(/\\/g, '/');
    const taskContent = JSON.stringify({
      steps: [{ type: 'dev-revert', factory: 'prd' }]
    });
    const res = await request('POST', '/pre-write', {
      tool_input: { file_path: filePath, content: taskContent }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(res.body.hookSpecificOutput.permissionDecisionReason.includes('dev-revert'));
  });

  it('allows malformed JSON in task content (fail-open)', async () => {
    const filePath = path.join(harness.tmpDir, 'tasks', 'bad.json').replace(/\\/g, '/');
    const res = await request('POST', '/pre-write', {
      tool_input: { file_path: filePath, content: 'not valid json{' }
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should allow malformed JSON');
  });

  it('returns empty when paused', async () => {
    await request('POST', '/pause', null, PORT);
    const filePath = path.join(harness.tmpDir, 'tasks', 'prod.json').replace(/\\/g, '/');
    const taskContent = JSON.stringify({
      steps: [{ type: 'adf-deploy-pipeline', factory: 'prd', pipeline: 'Nope' }]
    });
    const res = await request('POST', '/pre-write', {
      tool_input: { file_path: filePath, content: taskContent }
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should be empty when paused');
    await request('POST', '/resume', null, PORT);
  });

  it('returns X-Response-Time header', async () => {
    const filePath = path.join(harness.tmpDir, 'tasks', 'timing.json').replace(/\\/g, '/');
    const res = await requestRaw('POST', '/pre-write', {
      tool_input: { file_path: filePath, content: '{}' }
    }, PORT);
    assert.ok(res.headers['x-response-time'], 'should have X-Response-Time header');
  });
});

describe('Pre-Write Endpoint — Security Model Config', () => {
  let harness;
  const PORT = 19765;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {}
    });
  });

  after(() => { stopTestServer(harness); });

  it('allows correct prod org under prod environment', async () => {
    const filePath = path.join(harness.tmpDir, 'work-repo-staging', 'SQL DB', 'ADFCreateAndPopulateSecurityModelConfig.sql').replace(/\\/g, '/');
    const content = "INSERT INTO config VALUES ('prod', 'PRODSPO', 'guid', 'https://ferc.crm9.dynamics.com')";
    const res = await request('POST', '/pre-write', {
      tool_input: { file_path: filePath, content }
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should allow correct assignment');
  });

  it('denies prod org under wrong environment', async () => {
    const filePath = path.join(harness.tmpDir, 'work-repo-staging', 'SQL DB', 'ADFCreateAndPopulateSecurityModelConfig.sql').replace(/\\/g, '/');
    const content = "INSERT INTO config VALUES ('dev', 'PRODSPO', 'guid', 'https://ferc.crm9.dynamics.com')";
    const res = await request('POST', '/pre-write', {
      tool_input: { file_path: filePath, content }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(res.body.hookSpecificOutput.permissionDecisionReason.includes("must be under 'prod'"));
  });

  it('asks for prod org under dataqa (intentional override)', async () => {
    const filePath = path.join(harness.tmpDir, 'work-repo-staging', 'SQL DB', 'ADFCreateAndPopulateSecurityModelConfig.sql').replace(/\\/g, '/');
    const content = "INSERT INTO config VALUES ('dataqa', 'spprod', 'guid', 'https://ferc.crm9.dynamics.com')";
    const res = await request('POST', '/pre-write', {
      tool_input: { file_path: filePath, content }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'ask');
    assert.ok(res.body.hookSpecificOutput.permissionDecisionReason.includes('dataqa'));
  });

  it('denies dev URI under prod environment', async () => {
    const filePath = path.join(harness.tmpDir, 'work-repo-staging', 'SQL DB', 'ADFCreateAndPopulateSecurityModelConfig.sql').replace(/\\/g, '/');
    const content = "INSERT INTO config VALUES ('prod', 'devorg', 'guid', 'https://almwave3.crm9.dynamics.com')";
    const res = await request('POST', '/pre-write', {
      tool_input: { file_path: filePath, content }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(res.body.hookSpecificOutput.permissionDecisionReason.includes('Dev URI'));
  });
});

describe('Mtime-Based Auto-Reload', () => {
  let harness;
  let rulesFile;
  const PORT = 19766;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'old-rule': {
          type: 'domain',
          description: 'Old rule',
          triggers: { prompt: { keywords: ['old-mtime'] } }
        }
      }
    });
    rulesFile = path.join(harness.rulesDir, 'skill-rules.json');
  });

  after(() => { stopTestServer(harness); });

  it('auto-detects rule changes via mtime without /reload', async () => {
    // 1. Verify old rule matches
    const before = await request('POST', '/activate', {
      prompt: 'old-mtime keyword here',
      env: { CLAUDE_PROJECT_DIR: harness.tmpDir }
    }, PORT);
    assert.ok(before.body.hookSpecificOutput, 'old-rule should match before change');
    assert.ok(before.body.hookSpecificOutput.additionalContext.includes('old-rule'), 'should contain old-rule');

    // 2. Wait 1.1s for filesystem mtime resolution
    await new Promise(resolve => setTimeout(resolve, 1100));

    // 3. Overwrite rules file with new rule (NO /reload call)
    fs.writeFileSync(rulesFile, JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'new-rule': {
          type: 'domain',
          description: 'New rule',
          triggers: { prompt: { keywords: ['new-mtime'] } }
        }
      }
    }));

    // 4. Verify old rule no longer matches
    const oldCheck = await request('POST', '/activate', {
      prompt: 'old-mtime keyword here',
      env: { CLAUDE_PROJECT_DIR: harness.tmpDir }
    }, PORT);
    assert.ok(!oldCheck.body.hookSpecificOutput, 'old-rule should not match after file change');

    // 5. Verify new rule matches
    const newCheck = await request('POST', '/activate', {
      prompt: 'new-mtime keyword here',
      env: { CLAUDE_PROJECT_DIR: harness.tmpDir }
    }, PORT);
    assert.ok(newCheck.body.hookSpecificOutput, 'new-rule should match after file change');
    assert.ok(newCheck.body.hookSpecificOutput.additionalContext.includes('new-rule'), 'should contain new-rule');
  });
});

describe('Project-Scoped Session State', () => {
  let harness;
  let tmpDirB;
  const PORT = 19767;

  before(async () => {
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'se-sessB-'));
    const rulesDirB = path.join(tmpDirB, '.claude', 'skills');
    fs.mkdirSync(rulesDirB, { recursive: true });

    const sharedRules = {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'once-rule': {
          type: 'domain',
          description: 'Session-once rule',
          triggers: { prompt: { keywords: ['session-test'] } },
          skipConditions: { sessionOnce: true }
        }
      }
    };
    fs.writeFileSync(path.join(rulesDirB, 'skill-rules.json'), JSON.stringify(sharedRules));

    harness = await startTestServer(PORT, sharedRules);
  });

  after(() => { stopTestServer(harness, [tmpDirB]); });

  it('sessionOnce is scoped per project — same session_id fires in different projects', async () => {
    // 1. Fire rule in project A
    const firstA = await request('POST', '/activate', {
      prompt: 'session-test keyword',
      session_id: 'shared-sess',
      env: { CLAUDE_PROJECT_DIR: harness.tmpDir }
    }, PORT);
    assert.ok(firstA.body.hookSpecificOutput, 'should fire in project A first time');
    assert.ok(firstA.body.hookSpecificOutput.additionalContext.includes('once-rule'));

    // 2. Confirm it does NOT fire again in project A (sessionOnce)
    const secondA = await request('POST', '/activate', {
      prompt: 'session-test keyword',
      session_id: 'shared-sess',
      env: { CLAUDE_PROJECT_DIR: harness.tmpDir }
    }, PORT);
    assert.ok(!secondA.body.hookSpecificOutput, 'should NOT fire in project A second time');

    // 3. Fire same session_id but with project B — should fire because session key includes project
    const firstB = await request('POST', '/activate', {
      prompt: 'session-test keyword',
      session_id: 'shared-sess',
      env: { CLAUDE_PROJECT_DIR: tmpDirB }
    }, PORT);
    assert.ok(firstB.body.hookSpecificOutput, 'should fire in project B (different project scope)');
    assert.ok(firstB.body.hookSpecificOutput.additionalContext.includes('once-rule'));
  });
});

describe('Multi-Key RuleCache', () => {
  let harness;
  let tmpDirB;
  const PORT = 19754;

  before(async () => {
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'se-cache-b-'));
    const rulesDirB = path.join(tmpDirB, '.claude', 'skills');
    fs.mkdirSync(rulesDirB, { recursive: true });
    fs.writeFileSync(path.join(rulesDirB, 'skill-rules.json'), JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'rule-b': { type: 'domain', description: 'Rule B', triggers: { prompt: { keywords: ['beta-cache'] } } } }
    }));

    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'rule-a': { type: 'domain', description: 'Rule A', triggers: { prompt: { keywords: ['alpha-cache'] } } } }
    });
  });

  after(() => { stopTestServer(harness, [tmpDirB]); });

  it('caches rules for two projects simultaneously without thrashing', async () => {
    const resA1 = await request('POST', '/activate', {
      prompt: 'alpha-cache keyword',
      env: { CLAUDE_PROJECT_DIR: harness.tmpDir }
    }, PORT);
    assert.ok(resA1.body.hookSpecificOutput.additionalContext.includes('rule-a'));

    const resB = await request('POST', '/activate', {
      prompt: 'beta-cache keyword',
      env: { CLAUDE_PROJECT_DIR: tmpDirB }
    }, PORT);
    assert.ok(resB.body.hookSpecificOutput.additionalContext.includes('rule-b'));

    const resA2 = await request('POST', '/activate', {
      prompt: 'alpha-cache keyword',
      env: { CLAUDE_PROJECT_DIR: harness.tmpDir }
    }, PORT);
    assert.ok(resA2.body.hookSpecificOutput.additionalContext.includes('rule-a'));
  });

  it('GET /health shows cache stats', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.cache, 'should have cache field');
    assert.equal(typeof res.body.cache.entries, 'number');
    assert.equal(res.body.cache.maxEntries, 10);
  });

  it('evicts LRU entry when cache exceeds max size', async () => {
    const dirs = [];
    for (let i = 0; i < 11; i++) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), `se-lru-${i}-`));
      const rd = path.join(d, '.claude', 'skills');
      fs.mkdirSync(rd, { recursive: true });
      fs.writeFileSync(path.join(rd, 'skill-rules.json'), JSON.stringify({
        version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' },
        rules: { [`rule-${i}`]: { type: 'domain', description: `Rule ${i}`, triggers: { prompt: { keywords: [`lru-${i}`] } } } }
      }));
      dirs.push(d);
      await request('POST', '/activate', { prompt: `lru-${i}`, env: { CLAUDE_PROJECT_DIR: d } }, PORT);
    }

    const health = await request('GET', '/health', null, PORT);
    assert.ok(health.body.cache.entries <= 10, `cache entries should be <= 10, got ${health.body.cache.entries}`);

    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('Session Registry', () => {
  let harness;
  let tmpDirB;
  const PORT = 19768;

  before(async () => {
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'se-sess-reg-b-'));
    const rulesDirB = path.join(tmpDirB, '.claude', 'skills');
    fs.mkdirSync(rulesDirB, { recursive: true });
    fs.writeFileSync(path.join(rulesDirB, 'skill-rules.json'), JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'rule-b': { type: 'domain', description: 'Rule B', triggers: { prompt: { keywords: ['sess-beta'] } } } }
    }));

    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'rule-a': { type: 'domain', description: 'Rule A', triggers: { prompt: { keywords: ['sess-alpha'] } } } }
    });
  });

  after(() => { stopTestServer(harness, [tmpDirB]); });

  it('POST /register-session registers a session and returns confirmation', async () => {
    const res = await request('POST', '/register-session', {
      sessionId: 'test-sess-a',
      projectDir: harness.tmpDir
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.sessionId, 'test-sess-a');
    assert.ok(res.body.rulesDir);
    assert.equal(res.body.rulesLoaded, 1);
    assert.ok(Array.isArray(res.body.errors));
    assert.equal(res.body.errors.length, 0);
  });

  it('registered session resolves correct project rules via session_id', async () => {
    await request('POST', '/register-session', { sessionId: 'iso-sess-a', projectDir: harness.tmpDir }, PORT);
    await request('POST', '/register-session', { sessionId: 'iso-sess-b', projectDir: tmpDirB }, PORT);

    const resA = await request('POST', '/activate', { prompt: 'sess-alpha keyword', session_id: 'iso-sess-a' }, PORT);
    assert.ok(resA.body.hookSpecificOutput);
    assert.ok(resA.body.hookSpecificOutput.additionalContext.includes('rule-a'));

    const resB = await request('POST', '/activate', { prompt: 'sess-beta keyword', session_id: 'iso-sess-b' }, PORT);
    assert.ok(resB.body.hookSpecificOutput);
    assert.ok(resB.body.hookSpecificOutput.additionalContext.includes('rule-b'));

    const resAnoB = await request('POST', '/activate', { prompt: 'sess-beta keyword', session_id: 'iso-sess-a' }, PORT);
    assert.ok(!resAnoB.body.hookSpecificOutput, 'session A should not see rule-b');
  });

  it('unregistered session_id falls back to most recently registered project', async () => {
    await request('POST', '/register-session', { sessionId: 'fallback-sess', projectDir: harness.tmpDir }, PORT);
    const res = await request('POST', '/activate', { prompt: 'sess-alpha keyword', session_id: 'unknown-sess-id' }, PORT);
    assert.ok(res.body.hookSpecificOutput);
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('rule-a'));
  });

  it('request with no session_id falls back to most recently registered project', async () => {
    await request('POST', '/register-session', { sessionId: 'no-sid-fallback', projectDir: harness.tmpDir }, PORT);
    const res = await request('POST', '/activate', { prompt: 'sess-alpha keyword' }, PORT);
    assert.ok(res.body.hookSpecificOutput);
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('rule-a'));
  });

  it('deprecated /set-project still works via synthetic session', async () => {
    await request('POST', '/set-project', { projectDir: tmpDirB }, PORT);
    const res = await request('POST', '/activate', { prompt: 'sess-beta keyword' }, PORT);
    assert.ok(res.body.hookSpecificOutput);
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('rule-b'));
  });

  it('POST /register-session with missing fields returns 400', async () => {
    const res = await request('POST', '/register-session', { sessionId: 'no-proj' }, PORT);
    assert.equal(res.status, 400);
  });

  it('POST /register-session returns errors when rules files are missing', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-no-rules-'));
    const res = await request('POST', '/register-session', {
      sessionId: 'no-rules-sess',
      projectDir: emptyDir
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.errors.length > 0, 'should have errors when no rules files exist');
    assert.ok(res.body.errors[0].includes('No skill-rules.json'), 'error should mention missing files');
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});

describe('Health and Rules with Sessions', () => {
  let harness;
  const PORT = 19769;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'health-rule': { type: 'domain', description: 'Health rule', triggers: { prompt: { keywords: ['health-test'] } } } }
    });
    await request('POST', '/register-session', { sessionId: 'health-sess', projectDir: harness.tmpDir }, PORT);
  });

  after(() => { stopTestServer(harness); });

  it('GET /health shows sessions map with project detail', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.sessions, 'should have sessions field');
    assert.ok(res.body.sessions['health-sess'], 'should have our registered session');
    const sess = res.body.sessions['health-sess'];
    assert.ok(sess.projectDir);
    assert.ok(sess.rulesDir);
    assert.equal(typeof sess.rulesLoaded, 'number');
    assert.ok(sess.registeredAt);
  });

  it('GET /health shows cache stats', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.cache, 'should have cache field');
    assert.equal(typeof res.body.cache.entries, 'number');
    assert.equal(res.body.cache.maxEntries, 10);
  });

  it('GET /health shows deprecatedSetProjectCalls counter', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(typeof res.body.deprecatedSetProjectCalls, 'number');
  });

  it('GET /rules?session=X returns rules for that session project', async () => {
    const res = await request('GET', '/rules?session=health-sess', null, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.session, 'health-sess');
    assert.equal(res.body.count, 1);
    assert.equal(res.body.rules[0].name, 'health-rule');
  });

  it('GET /rules without session returns all rules across sessions', async () => {
    const res = await request('GET', '/rules', null, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.count >= 1);
    assert.ok(res.body.rules.some(r => r.name === 'health-rule'));
  });
});

describe('PostToolUse on Read-Only Tools', () => {
  let harness;
  const PORT = 19771;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'detect-error-pattern': {
          type: 'domain',
          enforcement: 'suggest',
          priority: 'high',
          description: 'Detected error pattern in file',
          guidance: 'This file contains Entity Does Not Exist errors. Check ADF pipeline configuration.',
          triggers: {
            output: {
              toolNames: ['Read', 'Grep'],
              outputPatterns: ['Entity Does Not Exist']
            }
          }
        }
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('fires output trigger for Read tool output', async () => {
    const res = await request('POST', '/post-tool', {
      tool_name: 'Read',
      tool_output: 'Error: Entity Does Not Exist in pipeline xyz'
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.hookSpecificOutput);
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('Entity Does Not Exist errors'));
  });

  it('fires output trigger for Grep tool output', async () => {
    const res = await request('POST', '/post-tool', {
      tool_name: 'Grep',
      tool_output: 'file.csv:42: Entity Does Not Exist'
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.hookSpecificOutput);
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('Entity Does Not Exist errors'));
  });

  it('does not fire for non-matching tool', async () => {
    const res = await request('POST', '/post-tool', {
      tool_name: 'Bash',
      tool_output: 'Entity Does Not Exist'
    }, PORT);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hookSpecificOutput, 'should not match Bash');
  });
});

describe('Enforcement: ask (approval pattern)', () => {
  let harness;
  const PORT = 19770;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'ask-prod-config': {
          type: 'guardrail',
          description: 'Production config requires approval',
          enforcement: 'ask',
          askMessage: 'This edits production config. Approve?',
          triggers: {
            file: {
              pathPatterns: ['**/prod*.json']
            }
          }
        },
        'approve-alias-rule': {
          type: 'guardrail',
          description: 'Approve alias test',
          enforcement: 'approve',
          askMessage: 'Approve alias fired',
          triggers: {
            file: {
              pathPatterns: ['**/needs-approval.*']
            }
          }
        },
        'block-secrets': {
          type: 'guardrail',
          description: 'Never edit secrets',
          enforcement: 'block',
          blockMessage: 'Secrets file is read-only',
          triggers: {
            file: {
              pathPatterns: ['**/secrets.*']
            }
          }
        },
        'ask-force-push': {
          type: 'guardrail',
          description: 'Force push requires approval',
          enforcement: 'ask',
          askMessage: 'Force push detected. Approve?',
          triggers: {
            tool: {
              toolNames: ['Bash'],
              inputPatterns: ['push\\s+(--force|-f)']
            }
          }
        },
        'warn-rm': {
          type: 'guardrail',
          description: 'Be careful with rm',
          enforcement: 'warn',
          triggers: {
            tool: {
              toolNames: ['Bash'],
              inputPatterns: ['\\brm\\b']
            }
          }
        }
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('returns ask for file matching ask-enforcement rule', async () => {
    const prodFile = path.join(harness.tmpDir, 'prod-db.json');
    fs.writeFileSync(prodFile, '{}');
    const res = await request('POST', '/enforce', { tool_input: { file_path: prodFile } }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.equal(hso.hookEventName, 'PreToolUse');
    assert.equal(hso.permissionDecision, 'ask');
    assert.equal(hso.permissionDecisionReason, 'This edits production config. Approve?');
  });

  it('block takes priority over ask when both match', async () => {
    const secretsProd = path.join(harness.tmpDir, 'secrets.json');
    fs.writeFileSync(secretsProd, '{}');
    const res = await request('POST', '/enforce', { tool_input: { file_path: secretsProd } }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.equal(hso.permissionDecision, 'deny');
    assert.equal(hso.permissionDecisionReason, 'Secrets file is read-only');
  });

  it('returns ask for tool-trigger matching ask-enforcement rule', async () => {
    const res = await request('POST', '/enforce-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin main' }
    }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.equal(hso.permissionDecision, 'ask');
    assert.equal(hso.permissionDecisionReason, 'Force push detected. Approve?');
  });

  it('ask takes priority over warn for same tool', async () => {
    const res = await request('POST', '/enforce-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf && git push --force' }
    }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.equal(hso.permissionDecision, 'ask');
  });

  it('warn still works when no ask rules match', async () => {
    const res = await request('POST', '/enforce-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/old' }
    }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.equal(hso.permissionDecision, 'allow');
    assert.ok(hso.additionalContext.includes('warn-rm'));
  });

  it('consolidated /pre-tool returns ask from enforce-tool subroute', async () => {
    const res = await request('POST', '/pre-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin main' }
    }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.equal(hso.permissionDecision, 'ask');
  });

  it('enforcement "approve" is treated as alias for "ask"', async () => {
    const approveFile = path.join(harness.tmpDir, 'needs-approval.json');
    fs.writeFileSync(approveFile, '{}');
    const res = await request('POST', '/enforce', { tool_input: { file_path: approveFile } }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.equal(hso.permissionDecision, 'ask');
    assert.equal(hso.permissionDecisionReason, 'Approve alias fired');
  });
});

describe('Session Context Tracking', () => {
  let harness;
  const PORT = 19772;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'w3-inv': {
          type: 'domain',
          description: 'W3 investigation skill',
          skillPath: './w3-investigation/SKILL.md',
          sessionContext: 'w3-investigation',
          triggers: { prompt: { keywords: ['investigate-ctx'] } },
          skipConditions: { sessionOnce: true }
        },
        'autocreate-trap': {
          type: 'guardrail',
          enforcement: 'warn',
          description: 'autoCreate drops NULL columns',
          triggers: { prompt: { keywords: ['autoCreate-ctx'] } },
          contextEnhancement: {
            'w3-investigation': 'ENHANCED: verify staging DDL includes all FetchXML attributes.'
          }
        }
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('GET /health shows sessionContexts after skill activation', async () => {
    await request('POST', '/activate', {
      prompt: 'investigate-ctx data issue',
      session_id: 'ctx-sess-1'
    }, PORT);
    const health = await request('GET', '/health', null, PORT);
    assert.ok(health.body.sessionContexts, 'should have sessionContexts');
    assert.ok(health.body.sessionContexts['ctx-sess-1']);
    assert.ok(health.body.sessionContexts['ctx-sess-1'].includes('w3-investigation'));
  });

  it('activate returns enhanced message when session has matching context', async () => {
    await request('POST', '/activate', {
      prompt: 'investigate-ctx data issue',
      session_id: 'ctx-sess-2'
    }, PORT);
    const res = await request('POST', '/activate', {
      prompt: 'autoCreate-ctx column trap',
      session_id: 'ctx-sess-2'
    }, PORT);
    assert.ok(res.body.hookSpecificOutput);
    const ctx = res.body.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('ENHANCED'), 'should include context-enhanced message');
  });

  it('activate returns base message when session has no matching context', async () => {
    const res = await request('POST', '/activate', {
      prompt: 'autoCreate-ctx column trap',
      session_id: 'ctx-sess-no-context'
    }, PORT);
    assert.ok(res.body.hookSpecificOutput);
    const ctx = res.body.hookSpecificOutput.additionalContext;
    assert.ok(!ctx.includes('ENHANCED'), 'should NOT include context-enhanced message');
  });
});

describe('Context Boost', () => {
  let harness;
  const PORT = 19773;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'boost-rule': {
          type: 'domain',
          description: 'Rule with context boost',
          triggers: { prompt: { keywords: ['investigate-boost'] } },
          contextBoost: {
            patterns: ['alm_workset', 'alm_fercbusinessunit', 'Wave3_.*_Staging'],
            weight: 0.3
          }
        },
        'no-boost-rule': {
          type: 'domain',
          description: 'Rule without context boost',
          triggers: { prompt: { keywords: ['no-boost-only'] } }
        }
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('keyword match alone fires (score 1.0)', async () => {
    const res = await request('POST', '/activate', { prompt: 'investigate-boost something' }, PORT);
    assert.ok(res.body.hookSpecificOutput);
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('boost-rule'));
  });

  it('context boost alone does not fire with fewer than threshold patterns', async () => {
    const res = await request('POST', '/activate', { prompt: 'fix the data in alm_workset' }, PORT);
    assert.ok(!res.body.hookSpecificOutput || !res.body.hookSpecificOutput.additionalContext.includes('boost-rule'));
  });

  it('three boost patterns alone score 0.9 — below threshold, does not fire', async () => {
    const res = await request('POST', '/activate', {
      prompt: 'fix the data in alm_workset and alm_fercbusinessunit and Wave3_Something_Staging'
    }, PORT);
    assert.ok(!res.body.hookSpecificOutput || !res.body.hookSpecificOutput.additionalContext.includes('boost-rule'),
      'three patterns at 0.3 each = 0.9, below 1.0 threshold');
  });

  it('keyword match + boost patterns combine scores', async () => {
    const res = await request('POST', '/activate', {
      prompt: 'investigate-boost in alm_workset context'
    }, PORT);
    assert.ok(res.body.hookSpecificOutput);
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('boost-rule'));
  });

  it('rule without contextBoost is unaffected', async () => {
    const res = await request('POST', '/activate', {
      prompt: 'alm_workset alm_fercbusinessunit Wave3_X_Staging Wave3_Y_Staging'
    }, PORT);
    const ctx = res.body.hookSpecificOutput ? res.body.hookSpecificOutput.additionalContext : '';
    assert.ok(!ctx.includes('no-boost-rule'));
  });
});

describe('Session Context Initialization', () => {
  let harness;
  const PORT = 19774;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'w3-inv': {
          type: 'domain',
          description: 'W3 investigation',
          sessionContext: 'w3-investigation',
          skillPath: './w3-investigation/SKILL.md',
          triggers: { prompt: { keywords: ['investigate-check'] } },
          skipConditions: { sessionOnce: true }
        }
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('activating a skill loads context for the session', async () => {
    await request('POST', '/activate', {
      prompt: 'investigate-check data',
      session_id: 'ctx-sess-1'
    }, PORT);
    const health = await request('GET', '/health', null, PORT);
    const contexts = health.body.sessionContexts || {};
    assert.ok(contexts['ctx-sess-1']);
  });
});

describe('Subagent Briefing', () => {
  let harness;
  const PORT = 19775;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'warn-rule': {
          type: 'guardrail',
          enforcement: 'warn',
          priority: 'high',
          description: 'autoCreate drops NULL columns',
          guidance: 'Use explicit TabularTranslator mappings.',
          triggers: { prompt: { keywords: ['autoCreate'] } }
        }
      }
    }, {
      extraFiles: {
        '.claude/skills/w3-investigation/quick-ref.md': '# Quick Ref\n\n| Factory | env |\n|---|---|\n| dev1 | dev |',
        '.claude/skills/w3-investigation/known-issues.md': '# Known Issues\n\n## NULL owningbusinessunit\nCorrupted records.',
        '.claude/skills/w3-pipeline-dev/quick-ref.md': '# Quick Ref\n\nSame content.',
        '.claude/skills/w3-pipeline-dev/patterns.md': '# Patterns\n\n## Standard Load\nAnnotated example.',
        '.claude/skills/w3-testing/quick-ref.md': '# Quick Ref\n\nTest ref.',
        '.claude/skills/w3-testing/assertion-ref.md': '# Assertion Ref\n\nassert-match details.'
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('GET /briefing?context=w3-investigation returns compiled markdown', async () => {
    const res = await request('GET', '/briefing?context=w3-investigation', null, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.briefing, 'should have briefing field');
    assert.ok(res.body.briefing.includes('Quick Ref'), 'should include quick-ref content');
    assert.ok(res.body.briefing.includes('Known Issues'), 'should include known-issues content');
    assert.equal(res.body.context, 'w3-investigation');
  });

  it('GET /briefing?context=w3-pipeline-dev returns pipeline patterns', async () => {
    const res = await request('GET', '/briefing?context=w3-pipeline-dev', null, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.briefing.includes('Patterns'));
    assert.ok(res.body.briefing.includes('Quick Ref'));
  });

  it('GET /briefing?context=w3-testing returns assertion reference', async () => {
    const res = await request('GET', '/briefing?context=w3-testing', null, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.briefing.includes('Assertion Ref'));
  });

  it('GET /briefing includes active guardrails', async () => {
    const res = await request('GET', '/briefing?context=w3-investigation', null, PORT);
    assert.ok(res.body.briefing.includes('warn-rule'), 'should include guardrail name');
    assert.ok(res.body.briefing.includes('TabularTranslator'), 'should include guardrail guidance');
  });

  it('GET /briefing with unknown context returns 404', async () => {
    const res = await request('GET', '/briefing?context=nonexistent', null, PORT);
    assert.equal(res.status, 404);
  });

  it('GET /briefing without context param returns 400', async () => {
    const res = await request('GET', '/briefing', null, PORT);
    assert.equal(res.status, 400);
  });
});

describe('Full W3 Session Flow', () => {
  let harness;
  const PORT = 19776;

  before(async () => {
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'w3-inv': {
          type: 'domain',
          description: 'W3 investigation',
          sessionContext: 'w3-investigation',
          skillPath: './w3-investigation/SKILL.md',
          triggers: { prompt: { keywords: ['investigate-flow'] } },
          skipConditions: { sessionOnce: true },
          contextBoost: {
            patterns: ['alm_workset', 'Wave3_.*_Staging'],
            weight: 0.3
          }
        },
        'autocreate-warn': {
          type: 'guardrail',
          enforcement: 'warn',
          description: 'autoCreate column trap',
          guidance: 'Use explicit TabularTranslator mappings.',
          triggers: { prompt: { keywords: ['autoCreate-flow'] } },
          contextEnhancement: {
            'w3-investigation': 'ENHANCED: verify staging DDL includes all FetchXML attributes.'
          }
        }
      }
    }, {
      extraFiles: {
        '.claude/skills/w3-investigation/quick-ref.md': '# Quick Ref\n\nFactory table here.',
        '.claude/skills/w3-investigation/known-issues.md': '# Known Issues\n\nNULL owningbusinessunit.',
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('complete session: activate → context → enhanced guardrail', async () => {
    const sid = 'flow-sess-1';
    const activate = await request('POST', '/activate', {
      prompt: 'investigate-flow data issue', session_id: sid
    }, PORT);
    assert.ok(activate.body.hookSpecificOutput);
    assert.ok(activate.body.hookSpecificOutput.additionalContext.includes('w3-inv'));

    const guardrail = await request('POST', '/activate', {
      prompt: 'autoCreate-flow table rebuild', session_id: sid
    }, PORT);
    assert.ok(guardrail.body.hookSpecificOutput);
    assert.ok(guardrail.body.hookSpecificOutput.additionalContext.includes('ENHANCED'));
  });

  it('briefing endpoint returns compiled context for investigation', async () => {
    const res = await request('GET', '/briefing?context=w3-investigation', null, PORT);
    assert.equal(res.status, 200);
    assert.ok(res.body.briefing.includes('Quick Ref'));
    assert.ok(res.body.briefing.includes('Known Issues'));
    assert.ok(res.body.briefing.includes('TabularTranslator'), 'should include guardrail');
  });

});

describe('Async Rule Compilation', () => {
  let harness;
  const PORT = 19777;

  before(async () => {
    const analyzersDir = '.claude/skills/analyzers';
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'sync-rule': {
          type: 'guardrail',
          description: 'Normal sync rule',
          enforcement: 'block',
          triggers: { file: { pathPatterns: ['**/*.sql'] } }
        },
        'async-rule': {
          type: 'guardrail',
          description: 'Async cross-file check',
          async: { analyzer: 'test-analyzer', config: { maxFiles: 10 } },
          triggers: { file: { pathPatterns: ['**/*.js'] } }
        }
      }
    }, {
      extraFiles: {
        [analyzersDir + '/test-analyzer.js']: `
          module.exports.analyze = function(context, config) {
            return [{ severity: 'warning', message: 'async finding for ' + context.filePath, relatedFiles: [] }];
          };
        `
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('GET /health reports hasAsyncRules true when async rules exist', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hasAsyncRules, true);
  });

  it('GET /health includes asyncWorker status', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.status, 200);
    const aw = res.body.asyncWorker;
    assert.ok(aw, 'should have asyncWorker field');
    assert.equal(typeof aw.alive, 'boolean');
    assert.equal(typeof aw.respawnCount, 'number');
    assert.equal(typeof aw.jobsProcessed, 'number');
    assert.equal(aw.degraded, false);
  });

  it('async rules are excluded from sync enforcement', async () => {
    const jsFile = path.join(harness.tmpDir, 'test.js');
    fs.writeFileSync(jsFile, 'console.log("hello")');
    const res = await request('POST', '/enforce', { tool_input: { file_path: jsFile } }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.ok(!hso || hso.permissionDecision !== 'deny', 'async rule should not produce sync deny');
  });
});

describe('Async Job Dispatch via PreTool', () => {
  let harness;
  const PORT = 19778;

  before(async () => {
    const analyzersDir = '.claude/skills/analyzers';
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'async-check': {
          type: 'guardrail',
          description: 'Async cross-file check',
          async: { analyzer: 'cross-check', config: {} },
          triggers: { file: { pathPatterns: ['**/*.js'] } }
        }
      }
    }, {
      extraFiles: {
        [analyzersDir + '/cross-check.js']: `
          module.exports.analyze = function(context) {
            return [{ severity: 'warning', message: 'issue in ' + context.filePath, relatedFiles: ['other.js'] }];
          };
        `
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('pre-tool with matching async rule does not block (returns empty)', async () => {
    const jsFile = path.join(harness.tmpDir, 'app.js');
    fs.writeFileSync(jsFile, 'const x = 1;');
    const res = await request('POST', '/pre-tool', {
      tool_name: 'Edit',
      tool_input: { file_path: jsFile },
      session_id: 'async-sess-1'
    }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.ok(!hso || !hso.permissionDecision, 'async rule should not produce a permission decision');
  });

  it('findings appear in /activate after async job completes', async () => {
    const jsFile = path.join(harness.tmpDir, 'app.js');
    fs.writeFileSync(jsFile, 'const x = 1;');

    await request('POST', '/pre-tool', {
      tool_name: 'Edit',
      tool_input: { file_path: jsFile },
      session_id: 'async-sess-2'
    }, PORT);

    // Wait for worker to process
    await new Promise(resolve => setTimeout(resolve, 2000));

    const res = await request('POST', '/activate', {
      prompt: 'what next',
      session_id: 'async-sess-2'
    }, PORT);
    assert.equal(res.status, 200);
    const ctx = res.body.hookSpecificOutput && res.body.hookSpecificOutput.additionalContext;
    assert.ok(ctx, 'should have additionalContext');
    assert.ok(ctx.includes('Async Analysis'), 'should contain async analysis header');
    assert.ok(ctx.includes('issue in'), 'should contain finding message');
  });

  it('findings are consumed on drain — second activate has no findings', async () => {
    const res = await request('POST', '/activate', {
      prompt: 'anything else',
      session_id: 'async-sess-2'
    }, PORT);
    assert.equal(res.status, 200);
    const ctx = res.body.hookSpecificOutput && res.body.hookSpecificOutput.additionalContext;
    assert.ok(!ctx || !ctx.includes('Async Analysis'), 'should not have async findings on second drain');
  });

  it('delivers findings even when no sync rules match the prompt', async () => {
    const jsFile = path.join(harness.tmpDir, 'solo.js');
    fs.writeFileSync(jsFile, 'const y = 2;');

    await request('POST', '/pre-tool', {
      tool_name: 'Edit',
      tool_input: { file_path: jsFile },
      session_id: 'async-sess-solo'
    }, PORT);

    await new Promise(resolve => setTimeout(resolve, 2000));

    const res = await request('POST', '/activate', {
      prompt: 'completely unrelated prompt',
      session_id: 'async-sess-solo'
    }, PORT);
    assert.equal(res.status, 200);
    const ctx = res.body.hookSpecificOutput && res.body.hookSpecificOutput.additionalContext;
    assert.ok(ctx, 'should have additionalContext from async findings alone');
    assert.ok(ctx.includes('Async Analysis'), 'should contain async header');
  });
});

describe('Async Rules Excluded from Sync Enforcement', () => {
  let harness;
  const PORT = 19779;

  before(async () => {
    const analyzersDir = '.claude/skills/analyzers';
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'async-tool-rule': {
          type: 'guardrail',
          description: 'Async tool-triggered check',
          enforcement: 'block',
          async: { analyzer: 'tool-check', config: {} },
          triggers: {
            tool: { toolNames: ['Bash'], inputPatterns: ['rm -rf'] }
          }
        }
      }
    }, {
      extraFiles: {
        [analyzersDir + '/tool-check.js']: `
          module.exports.analyze = function() {
            return [{ severity: 'warning', message: 'dangerous command', relatedFiles: [] }];
          };
        `
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('async rule with tool trigger does not produce sync block', async () => {
    const res = await request('POST', '/enforce-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/test' },
      session_id: 'async-excl-1'
    }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.ok(!hso || hso.permissionDecision !== 'deny', 'async rule should not produce sync deny');
  });

  it('async rule with tool trigger dispatches job and delivers via activate', async () => {
    await request('POST', '/pre-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/test' },
      session_id: 'async-tool-dispatch-1'
    }, PORT);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const res = await request('POST', '/activate', {
      prompt: 'what next',
      session_id: 'async-tool-dispatch-1'
    }, PORT);
    const ctx = res.body.hookSpecificOutput && res.body.hookSpecificOutput.additionalContext;
    assert.ok(ctx && ctx.includes('dangerous command'), 'tool-triggered async job should produce findings');
  });
});

describe('Async Dispatch from All Handlers', () => {
  let harness;
  const PORT = 19781;

  before(async () => {
    const analyzersDir = '.claude/skills/analyzers';
    harness = await startTestServer(PORT, {
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'prompt-async': {
          type: 'domain',
          description: 'Async prompt-triggered analysis',
          async: { analyzer: 'prompt-check', config: {} },
          triggers: { prompt: { keywords: ['analyze-this'] } }
        },
        'output-async': {
          type: 'domain',
          description: 'Async output-triggered analysis',
          async: { analyzer: 'output-check', config: {} },
          triggers: { output: { toolNames: ['Bash'], outputPatterns: ['ERROR_DETECTED'] } }
        }
      }
    }, {
      extraFiles: {
        [analyzersDir + '/prompt-check.js']: `
          module.exports.analyze = function(context) {
            return [{ severity: 'info', message: 'prompt-finding: ' + (context.prompt || '').slice(0, 20) }];
          };
        `,
        [analyzersDir + '/output-check.js']: `
          module.exports.analyze = function(context) {
            return [{ severity: 'warning', message: 'output-finding: error detected in ' + context.toolName }];
          };
        `
      }
    });
  });

  after(() => { stopTestServer(harness); });

  it('activate dispatches async job for prompt-triggered rule', async () => {
    await request('POST', '/activate', {
      prompt: 'analyze-this data set',
      session_id: 'async-prompt-1'
    }, PORT);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const res = await request('POST', '/activate', {
      prompt: 'what next',
      session_id: 'async-prompt-1'
    }, PORT);
    const ctx = res.body.hookSpecificOutput && res.body.hookSpecificOutput.additionalContext;
    assert.ok(ctx && ctx.includes('prompt-finding'), 'prompt-triggered async should produce findings');
  });

  it('post-tool dispatches async job for output-triggered rule', async () => {
    await request('POST', '/post-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'check status' },
      tool_output: 'Process failed ERROR_DETECTED in module',
      session_id: 'async-output-1'
    }, PORT);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const res = await request('POST', '/activate', {
      prompt: 'what next',
      session_id: 'async-output-1'
    }, PORT);
    const ctx = res.body.hookSpecificOutput && res.body.hookSpecificOutput.additionalContext;
    assert.ok(ctx && ctx.includes('output-finding'), 'output-triggered async should produce findings');
  });

  it('post-tool delivers pending async findings mid-turn', async () => {
    await request('POST', '/activate', {
      prompt: 'analyze-this data set',
      session_id: 'async-midturn-1'
    }, PORT);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const res = await request('POST', '/post-tool', {
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/anything.txt' },
      tool_output: 'file content here',
      session_id: 'async-midturn-1'
    }, PORT);
    const ctx = res.body.hookSpecificOutput && res.body.hookSpecificOutput.additionalContext;
    assert.ok(ctx && ctx.includes('prompt-finding'), 'mid-turn PostToolUse should deliver pending async findings');
  });
});
