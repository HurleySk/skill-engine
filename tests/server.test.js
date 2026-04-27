const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const SERVER_PATH = path.resolve(__dirname, '..', 'server', 'server.js');
const TEST_PORT = 19751;

function request(method, urlPath, body, port) {
  port = port || TEST_PORT;
  return new Promise((resolve, reject) => {
    const options = { hostname: 'localhost', port, path: urlPath, method,
      headers: body ? { 'Content-Type': 'application/json' } : {} };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, raw: data }); }
        catch { resolve({ status: res.statusCode, body: null, raw: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function requestRaw(method, urlPath, body, port) {
  port = port || TEST_PORT;
  return new Promise((resolve, reject) => {
    const options = { hostname: 'localhost', port, path: urlPath, method,
      headers: body ? { 'Content-Type': 'application/json' } : {} };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data, raw: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('Server Health', () => {
  let serverProcess;
  let tmpDir;
  let rulesDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-server-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: { 'test-rule': { type: 'domain', description: 'Test rule',
        triggers: { prompt: { keywords: ['test-keyword'] } } } }
    }));
    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(TEST_PORT), '--rules-dir', rulesDir], { stdio: 'pipe' });
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

  it('GET /health returns server status', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.uptime, 'number');
    assert.equal(res.body.rulesLoaded, 1);
    assert.equal(typeof res.body.port, 'number');
  });

  it('GET /health includes timing stats', async () => {
    const res = await request('GET', '/health');
    assert.equal(typeof res.body.avgResponseTimeMs, 'number');
  });

  it('GET /health includes version from plugin.json', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.version, 'string');
    assert.ok(res.body.version.match(/^\d+\.\d+\.\d+$/), 'version should be semver');
  });

  it('GET /health includes pid as a number', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.pid, 'number');
    assert.ok(res.body.pid > 0, 'pid should be positive');
  });
});

describe('Activate Endpoint', () => {
  let serverProcess;
  let tmpDir;
  let rulesDir;
  const PORT = 19752;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-activate-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
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
    }));
    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT), '--rules-dir', rulesDir], { stdio: 'pipe' });
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
    const res = await requestRaw('POST', '/activate', { prompt: 'test-keyword', session_id: 'timing-1' }, 19752);
    assert.ok(res.headers['x-response-time'], 'should have X-Response-Time header');
    assert.ok(res.headers['x-response-time'].endsWith('ms'), 'should end with ms');
  });
});

describe('Enforce Endpoint', () => {
  let serverProcess;
  let tmpDir;
  let rulesDir;
  let testSqlFile;
  const PORT = 19753;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-enforce-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
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
        }
      }
    }));

    testSqlFile = path.join(tmpDir, 'test.sql');
    fs.writeFileSync(testSqlFile, 'CREATE PROCEDURE [dbo].[Test]\nAS\nBEGIN\n  SELECT 1\nEND');

    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT), '--rules-dir', rulesDir], { stdio: 'pipe' });
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

  it('returns deny for matching guardrail with content pattern', async () => {
    const res = await request('POST', '/enforce', { tool_input: { file_path: testSqlFile } }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.equal(hso.hookEventName, 'PreToolUse');
    assert.equal(hso.permissionDecision, 'deny');
    assert.equal(hso.permissionDecisionReason, 'SQL blocked');
  });

  it('returns warn for matching warn guardrail', async () => {
    const configFile = path.join(tmpDir, 'app.config');
    fs.writeFileSync(configFile, '<configuration />');
    const res = await request('POST', '/enforce', { tool_input: { file_path: configFile } }, PORT);
    assert.equal(res.status, 200);
    const hso = res.body.hookSpecificOutput;
    assert.equal(hso.hookEventName, 'PreToolUse');
    assert.equal(hso.permissionDecision, 'allow');
    assert.ok(res.body.systemMessage.includes('warn-config'), 'systemMessage should mention warn-config');
  });

  it('returns empty for non-matching file', async () => {
    const txtFile = path.join(tmpDir, 'readme.txt');
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

describe('Reload Endpoint', () => {
  let serverProcess;
  let tmpDir;
  let rulesDir;
  let rulesFile;
  const PORT = 19754;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-reload-'));
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
    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT), '--rules-dir', rulesDir], { stdio: 'pipe' });
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

  it('POST /reload picks up new rules', async () => {
    // 1. Verify old rule matches
    const before = await request('POST', '/activate', { prompt: 'old keyword here' }, PORT);
    assert.ok(before.body.hookSpecificOutput.additionalContext.includes('old-rule'), 'old-rule should match before reload');

    // 2. Overwrite rules file with new rule
    fs.writeFileSync(rulesFile, JSON.stringify({
      version: '1.0',
      defaults: { enforcement: 'suggest', priority: 'medium' },
      rules: {
        'new-rule': {
          type: 'domain',
          description: 'New rule',
          triggers: { prompt: { keywords: ['new'] } }
        }
      }
    }));

    // 3. POST /reload
    const reload = await request('POST', '/reload', null, PORT);
    assert.equal(reload.status, 200);
    assert.equal(reload.body.reloaded, true);
    assert.equal(reload.body.rulesLoaded, 1);

    // 4. Verify old rule no longer matches
    const oldCheck = await request('POST', '/activate', { prompt: 'old keyword here' }, PORT);
    assert.ok(!oldCheck.body.hookSpecificOutput, 'old-rule should not match after reload');

    // 5. Verify new rule matches
    const newCheck = await request('POST', '/activate', { prompt: 'new keyword here' }, PORT);
    assert.ok(newCheck.body.hookSpecificOutput.additionalContext.includes('new-rule'), 'new-rule should match after reload');
  });
});

describe('Reload with rulesDir', () => {
  let serverProcess;
  let tmpDirA;
  let tmpDirB;
  let rulesDirA;
  let rulesDirB;
  const PORT = 19758;

  before(async () => {
    tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'se-reload-a-'));
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'se-reload-b-'));
    rulesDirA = path.join(tmpDirA, '.claude', 'skills');
    rulesDirB = path.join(tmpDirB, '.claude', 'skills');
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
    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT), '--rules-dir', rulesDirA], { stdio: 'pipe' });
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

  it('POST /reload with rulesDir switches to new directory', async () => {
    const beforeCheck = await request('POST', '/activate', { prompt: 'alpha keyword' }, PORT);
    assert.ok(beforeCheck.body.hookSpecificOutput.additionalContext.includes('rule-a'), 'rule-a should match before switch');

    const reload = await request('POST', '/reload', { rulesDir: rulesDirB }, PORT);
    assert.equal(reload.status, 200);
    assert.equal(reload.body.reloaded, true);
    assert.equal(reload.body.rulesLoaded, 1);
    assert.equal(reload.body.rulesDir, rulesDirB);

    const oldCheck = await request('POST', '/activate', { prompt: 'alpha keyword' }, PORT);
    assert.ok(!oldCheck.body.hookSpecificOutput, 'rule-a should not match after switch');

    const newCheck = await request('POST', '/activate', { prompt: 'beta keyword' }, PORT);
    assert.ok(newCheck.body.hookSpecificOutput.additionalContext.includes('rule-b'), 'rule-b should match after switch');
  });

  it('POST /reload without body maintains existing rules', async () => {
    const reload = await request('POST', '/reload', null, PORT);
    assert.equal(reload.status, 200);
    assert.equal(reload.body.reloaded, true);
    assert.equal(reload.body.rulesLoaded, 1);
  });

  it('POST /reload with nonexistent rulesDir returns 0 gracefully', async () => {
    const reload = await request('POST', '/reload', { rulesDir: path.join(os.tmpdir(), 'nonexistent-dir') }, PORT);
    assert.equal(reload.status, 200);
    assert.equal(reload.body.reloaded, true);
    assert.equal(reload.body.rulesLoaded, 0);
  });

  it('GET /health includes rulesDir', async () => {
    const health = await request('GET', '/health', null, PORT);
    assert.equal(health.status, 200);
    assert.ok('rulesDir' in health.body, 'health response should include rulesDir');
  });
});

describe('Kill Switch', () => {
  let serverProcess;
  let tmpDir;
  let rulesDir;
  let testSqlFile;
  const PORT = 19755;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-killswitch-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
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
    }));

    testSqlFile = path.join(tmpDir, 'test.sql');
    fs.writeFileSync(testSqlFile, 'SELECT 1');

    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT), '--rules-dir', rulesDir], {
      stdio: 'pipe',
      env: { ...process.env, SKILL_ENGINE_OFF: '1' }
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
  let serverProcess;
  let tmpDir;
  let rulesDir;
  let testSqlFile;
  const PORT = 19756;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-pauseresume-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
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
    }));

    testSqlFile = path.join(tmpDir, 'test.sql');
    fs.writeFileSync(testSqlFile, 'SELECT 1');

    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT), '--rules-dir', rulesDir], { stdio: 'pipe' });
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
  let serverProcess;
  let tmpDir;
  let rulesDir;
  let testSqlFile;
  const PORT = 19757;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-toolname-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
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
    }));

    testSqlFile = path.join(tmpDir, 'test.sql');
    fs.writeFileSync(testSqlFile, 'SELECT 1');

    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT), '--rules-dir', rulesDir], { stdio: 'pipe' });
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
    const configFile = path.join(tmpDir, 'app.config');
    fs.writeFileSync(configFile, '<configuration />');
    const res = await request('POST', '/enforce', {
      tool_name: 'Write',
      tool_input: { file_path: configFile }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
  });

  it('enforces rule without toolNames even when tool_name is absent', async () => {
    const configFile = path.join(tmpDir, 'app.config');
    fs.writeFileSync(configFile, '<configuration />');
    const res = await request('POST', '/enforce', {
      tool_input: { file_path: configFile }
    }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.permissionDecision, 'deny');
  });
});

describe('Enforce-Tool Endpoint', () => {
  let serverProcess;
  let tmpDir;
  let rulesDir;
  const PORT = 19759;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-enforce-tool-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
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
    }));
    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT), '--rules-dir', rulesDir], { stdio: 'pipe' });
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
    assert.ok(res.body.systemMessage.includes('warn-rm-rf'));
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
  let serverProcess;
  let tmpDir;
  let rulesDir;
  const PORT = 19760;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-enforce-tool-sc-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
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
    }));
    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT), '--rules-dir', rulesDir], { stdio: 'pipe' });
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
  let serverProcess;
  let tmpDir;
  let rulesDir;
  const PORT = 19761;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-post-tool-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
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
    }));
    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT), '--rules-dir', rulesDir], { stdio: 'pipe' });
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
  let serverProcess;
  let tmpDir;
  let rulesDir;
  const PORT = 19762;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-stop-'));
    rulesDir = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'skill-rules.json'), JSON.stringify({
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
    }));
    serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT), '--rules-dir', rulesDir], { stdio: 'pipe' });
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

  it('fires Stop rules and injects guidance', async () => {
    const res = await request('POST', '/stop', { session_id: 'stop-test-1' }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.hookSpecificOutput.hookEventName, 'Stop');
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('committing'));
    assert.ok(res.body.hookSpecificOutput.additionalContext.includes('test suite'));
  });

  it('respects sessionOnce — second call skips once-only rule', async () => {
    const body = { session_id: 'stop-once' };
    const first = await request('POST', '/stop', body, PORT);
    assert.ok(first.body.hookSpecificOutput.additionalContext.includes('committing'));
    const second = await request('POST', '/stop', body, PORT);
    const ctx = second.body.hookSpecificOutput.additionalContext;
    assert.ok(!ctx.includes('committing'), 'sessionOnce commit rule should not fire again');
    assert.ok(ctx.includes('test suite'), 'non-sessionOnce rule should still fire');
  });

  it('sorts by priority — high before low', async () => {
    const res = await request('POST', '/stop', { session_id: 'stop-prio' }, PORT);
    const ctx = res.body.hookSpecificOutput.additionalContext;
    const highIdx = ctx.indexOf('test suite');
    const lowIdx = ctx.indexOf('committing');
    assert.ok(highIdx < lowIdx, 'HIGH should appear before LOW');
  });

  it('health shows hasStopRules true', async () => {
    const res = await request('GET', '/health', null, PORT);
    assert.equal(res.body.hasStopRules, true);
  });
});
