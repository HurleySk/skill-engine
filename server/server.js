'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const asyncEngine = require('./async/engine');
const handlers = require('./handlers');
const apiRoutes = require('./api');
const sessions = require('./sessions');
const stats = require('./stats');

const PORT = (() => {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return parseInt(process.env.SKILL_ENGINE_PORT || '19750', 10);
})();

let SERVER_VERSION = 'unknown';
try {
  SERVER_VERSION = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version || 'unknown';
} catch {}

const hookRoutes = {
  '/activate': { handler: handlers.activate, event: 'activate' },
  '/enforce': { handler: handlers.enforce, event: 'enforce' },
  '/enforce-tool': { handler: handlers.enforceTool, event: 'enforce-tool' },
  '/post-tool': { handler: handlers.postTool, event: 'post-tool' },
  '/pre-tool': { handler: handlers.preTool, event: 'pre-tool' },
  '/stop': { handler: handlers.stop, event: 'stop' },
};

const MAX_BODY = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { req.destroy(); reject(new Error('Body too large')); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function respond(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

function engineOff() {
  return stats.state.paused || process.env.SKILL_ENGINE_OFF === '1';
}

async function runHook(req, res, pathname, route) {
  const startNs = process.hrtime.bigint();
  let body;
  try { body = await readBody(req); } catch { return respond(res, 400, { error: 'Invalid JSON' }); }
  const input = body || {};
  const { response, ctx, matched } = engineOff() ? { response: {} } : route.handler(input);

  const elapsed = process.hrtime.bigint() - startNs;
  const elapsedMs = Number(elapsed) / 1e6;
  const hso = response.hookSpecificOutput;
  stats.recordEvent(route.event, elapsed, {
    timestamp: new Date().toISOString(),
    endpoint: pathname,
    tool: input.tool_name || null,
    filePath: (input.tool_input && input.tool_input.file_path) || null,
    rulesChecked: ctx ? ctx.compiledRules.length : 0,
    rulesMatched: matched || [],
    enforcement: (hso && hso.permissionDecision) || 'allow',
    responseTimeMs: Math.round(elapsedMs * 100) / 100,
  });
  res.setHeader('X-Response-Time', elapsedMs.toFixed(2) + 'ms');
  respond(res, 200, response);
}

async function handleRequest(req, res) {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  const hook = req.method === 'POST' && hookRoutes[pathname];
  if (hook) return runHook(req, res, pathname, hook);

  const api = apiRoutes[req.method + ' ' + pathname];
  if (api) {
    const body = req.method === 'POST' ? await readBody(req).catch(() => null) : null;
    const [status, out] = await api({ body, params: searchParams, port: PORT, version: SERVER_VERSION });
    return respond(res, status, out);
  }

  if (req.method === 'POST') return respond(res, 200, {});
  respond(res, 404, { error: 'Not found' });
}

const cleanupInterval = setInterval(() => {
  asyncEngine.clearStaleSessions(sessions.cleanStaleSessions());
}, 5 * 60 * 1000);
cleanupInterval.unref();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    if (!res.writableEnded) respond(res, 500, { error: 'Internal error' });
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write('skill-engine: port ' + PORT + ' already in use, exiting.\n');
    process.exit(0);
  }
  process.stderr.write('skill-engine: server error: ' + err.message + '\n');
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('skill-engine server listening on port ' + PORT + '\n');
});

function shutdown() {
  clearInterval(cleanupInterval);
  asyncEngine.shutdown();
  server.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
