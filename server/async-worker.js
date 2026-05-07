'use strict';

const { parentPort } = require('worker_threads');
const path = require('path');

const analyzerCache = new Map();
const MAX_JOB_TIMEOUT_MS = 10000;

function loadAnalyzer(projectRoot, analyzerName) {
  const key = projectRoot + '|' + analyzerName;
  if (analyzerCache.has(key)) return analyzerCache.get(key);

  if (!analyzerName || /[/\\]|\.\./.test(analyzerName)) {
    analyzerCache.set(key, null);
    return null;
  }

  const analyzerPath = path.join(projectRoot, '.claude', 'skills', 'analyzers', analyzerName + '.js');
  try {
    const mod = require(analyzerPath);
    if (typeof mod.analyze !== 'function') {
      analyzerCache.set(key, null);
      return null;
    }
    analyzerCache.set(key, mod.analyze);
    return mod.analyze;
  } catch {
    analyzerCache.set(key, null);
    return null;
  }
}

async function handleJob(msg) {
  const start = Date.now();
  const { id, sessionId, projectRoot, analyzer, config, context } = msg;
  const ruleName = context && context.ruleName;

  const analyzeFn = loadAnalyzer(projectRoot, analyzer);
  if (!analyzeFn) {
    return {
      id, sessionId, ruleName,
      status: 'error',
      findings: [],
      durationMs: Date.now() - start,
      error: 'Analyzer not found or missing analyze export: ' + analyzer
    };
  }

  try {
    const result = await Promise.race([
      Promise.resolve(analyzeFn({ ...context, projectRoot }, config || {})),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Analyzer timeout after ' + MAX_JOB_TIMEOUT_MS + 'ms')), MAX_JOB_TIMEOUT_MS)
      )
    ]);

    const findings = Array.isArray(result) ? result : [];
    return {
      id, sessionId, ruleName,
      status: 'completed',
      findings,
      durationMs: Date.now() - start
    };
  } catch (err) {
    return {
      id, sessionId, ruleName,
      status: 'error',
      findings: [],
      durationMs: Date.now() - start,
      error: err.message || String(err)
    };
  }
}

parentPort.on('message', (msg) => {
  handleJob(msg).then((result) => {
    try {
      parentPort.postMessage(result);
    } catch (err) {
      parentPort.postMessage({
        id: result.id, sessionId: result.sessionId, ruleName: result.ruleName,
        status: 'error', findings: [], durationMs: result.durationMs,
        error: 'Result not serializable: ' + err.message
      });
    }
  }).catch(() => {});
});
