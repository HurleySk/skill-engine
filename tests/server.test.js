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
