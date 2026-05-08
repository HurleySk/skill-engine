'use strict';

const { parentPort } = require('worker_threads');
const path = require('path');

const handlers = {};
const MAX_JOB_TIMEOUT_MS = 10000;

handlers.analyzer = require('./handlers/analyzer');
handlers.hook = require('./handlers/hook');

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Handler timeout after ' + ms + 'ms')), ms)
    ),
  ]);
}

parentPort.on('message', async (msg) => {
  const start = Date.now();
  const { id, sessionId, handlerType, handlerName, config, context } = msg;
  const ruleName = context && context.ruleName;

  const handler = handlers[handlerType];
  if (!handler) {
    parentPort.postMessage({
      id, sessionId, ruleName,
      status: 'error', findings: [],
      durationMs: Date.now() - start,
      error: 'Unknown handler type: ' + handlerType,
    });
    return;
  }

  try {
    const findings = await withTimeout(
      handler.execute({ name: handlerName, config, context }),
      MAX_JOB_TIMEOUT_MS
    );
    parentPort.postMessage({
      id, sessionId, ruleName,
      status: 'completed',
      findings: Array.isArray(findings) ? findings : [],
      durationMs: Date.now() - start,
    });
  } catch (err) {
    parentPort.postMessage({
      id, sessionId, ruleName,
      status: 'error', findings: [],
      durationMs: Date.now() - start,
      error: err.message || String(err),
    });
  }
});
