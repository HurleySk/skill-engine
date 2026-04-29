const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const SERVER_PATH = path.resolve(__dirname, '..', 'server', 'server.js');

function request(method, urlPath, body, port) {
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

async function startTestServer(port, rules, options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-test-'));
  const rulesDir = path.join(tmpDir, '.claude', 'skills');
  fs.mkdirSync(rulesDir, { recursive: true });

  if (rules !== null && rules !== undefined) {
    const rulesFile = options.rulesFile || 'skill-rules.json';
    fs.writeFileSync(path.join(rulesDir, rulesFile), JSON.stringify(rules));
  }

  if (options.extraFiles) {
    for (const [relPath, content] of Object.entries(options.extraFiles)) {
      const fullPath = path.join(tmpDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
  }

  const serverProcess = spawn(process.execPath, [SERVER_PATH, '--port', String(port)], {
    stdio: 'pipe',
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir, ...(options.env || {}) }
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 5000);
    serverProcess.stdout.on('data', (data) => {
      if (data.toString().includes('listening')) { clearTimeout(timeout); resolve(); }
    });
    serverProcess.on('error', reject);
  });

  return { tmpDir, rulesDir, serverProcess, port };
}

function stopTestServer(harness, extraDirs = []) {
  if (harness.serverProcess) harness.serverProcess.kill();
  fs.rmSync(harness.tmpDir, { recursive: true, force: true });
  for (const dir of extraDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeRules(rulesDir, rules, filename = 'skill-rules.json') {
  fs.writeFileSync(path.join(rulesDir, filename), JSON.stringify(rules));
}

module.exports = { startTestServer, stopTestServer, writeRules, request, requestRaw };
