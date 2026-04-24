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
    assert.ok(res.body.result.includes('test-rule'), 'result should include test-rule');
    assert.ok(res.body.result.includes('Skill Engine'), 'result should include Skill Engine header');
  });

  it('returns empty result for non-matching prompt', async () => {
    const res = await request('POST', '/activate', { prompt: 'nothing relevant' }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.result, '');
  });

  it('respects sessionOnce — first call includes rule, second does not', async () => {
    const body = { prompt: 'check the test-keyword', session_id: 'sess-once-test' };
    const first = await request('POST', '/activate', body, PORT);
    assert.ok(first.body.result.includes('test-rule'), 'first call should include test-rule');
    const second = await request('POST', '/activate', body, PORT);
    assert.ok(!second.body.result.includes('test-rule'), 'second call should not include test-rule');
  });

  it('sorts by priority — HIGH appears before MEDIUM', async () => {
    const res = await request('POST', '/activate', { prompt: 'test-keyword and high-keyword together' }, PORT);
    assert.equal(res.status, 200);
    const highIdx = res.body.result.indexOf('[HIGH]');
    const medIdx = res.body.result.indexOf('[MEDIUM]');
    assert.ok(highIdx !== -1, 'should contain HIGH priority');
    assert.ok(medIdx !== -1, 'should contain MEDIUM priority');
    assert.ok(highIdx < medIdx, 'HIGH should appear before MEDIUM');
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

  it('returns block for matching guardrail with content pattern', async () => {
    const res = await request('POST', '/enforce', { tool_input: { file_path: testSqlFile } }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.decision, 'block');
    assert.equal(res.body.reason, 'SQL blocked');
  });

  it('returns warn for matching warn guardrail', async () => {
    const configFile = path.join(tmpDir, 'app.config');
    fs.writeFileSync(configFile, '<configuration />');
    const res = await request('POST', '/enforce', { tool_input: { file_path: configFile } }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.decision, 'allow');
    assert.ok(res.body.stderr.includes('warn-config'), 'stderr should mention warn-config');
  });

  it('returns allow for non-matching file', async () => {
    const txtFile = path.join(tmpDir, 'readme.txt');
    fs.writeFileSync(txtFile, 'hello');
    const res = await request('POST', '/enforce', { tool_input: { file_path: txtFile } }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.decision, 'allow');
    assert.ok(!res.body.stderr, 'should have no stderr');
  });

  it('returns allow when file_path is missing', async () => {
    const res = await request('POST', '/enforce', { tool_input: {} }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.decision, 'allow');
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
    assert.ok(before.body.result.includes('old-rule'), 'old-rule should match before reload');

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
    assert.equal(oldCheck.body.result, '', 'old-rule should not match after reload');

    // 5. Verify new rule matches
    const newCheck = await request('POST', '/activate', { prompt: 'new keyword here' }, PORT);
    assert.ok(newCheck.body.result.includes('new-rule'), 'new-rule should match after reload');
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
    assert.equal(res.body.result, '');
  });

  it('enforce returns allow when SKILL_ENGINE_OFF=1', async () => {
    const res = await request('POST', '/enforce', { tool_input: { file_path: testSqlFile } }, PORT);
    assert.equal(res.status, 200);
    assert.equal(res.body.decision, 'allow');
  });
});
