'use strict';

const MAX_FINDINGS_PER_SESSION = 20;

const findingsQueue = new Map();

function pushFindings(sessionId, findings) {
  if (!findings || !findings.length) return;
  let queue = findingsQueue.get(sessionId);
  if (!queue) {
    queue = [];
    findingsQueue.set(sessionId, queue);
  }
  for (const f of findings) {
    if (queue.length >= MAX_FINDINGS_PER_SESSION) break;
    queue.push(f);
  }
}

function drain(sessionId) {
  const queue = findingsQueue.get(sessionId);
  if (!queue || !queue.length) return [];
  const drained = queue.splice(0);
  findingsQueue.delete(sessionId);
  return drained;
}

function format(findings) {
  if (!findings || !findings.length) return [];
  const lines = [];
  lines.push('───────────────────────────────');
  lines.push('⚠️ Async Analysis Results (' + findings.length + ' finding' + (findings.length > 1 ? 's' : '') + '):');
  lines.push('');
  for (const f of findings) {
    if (typeof f === 'string') {
      lines.push('ℹ️ ' + f);
      continue;
    }
    const prefix = f.severity === 'warning' ? '⚠️' : 'ℹ️';
    lines.push(prefix + ' ' + f.message);
    if (f.relatedFiles && f.relatedFiles.length) {
      lines.push('  Related: ' + f.relatedFiles.join(', '));
    }
  }
  lines.push('');
  return lines;
}

function drainFormatted(sessionId) {
  const findings = drain(sessionId);
  return format(findings);
}

function clearSession(sessionId) {
  findingsQueue.delete(sessionId);
}

function clearStaleSessions(activeRegistry) {
  for (const sessionId of findingsQueue.keys()) {
    if (!activeRegistry.has(sessionId)) {
      findingsQueue.delete(sessionId);
    }
  }
}

function getStatus() {
  let totalPendingFindings = 0;
  for (const queue of findingsQueue.values()) {
    totalPendingFindings += queue.length;
  }
  return {
    activeSessions: findingsQueue.size,
    totalPendingFindings,
  };
}

function _reset() {
  findingsQueue.clear();
}

module.exports = {
  pushFindings, drain, format, drainFormatted,
  clearSession, clearStaleSessions, getStatus, _reset,
};
