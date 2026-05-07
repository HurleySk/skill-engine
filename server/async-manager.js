'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const crypto = require('crypto');

const WORKER_PATH = path.resolve(__dirname, 'async-worker.js');
const MAX_FINDINGS_PER_SESSION = 20;
const MAX_RESPAWNS = 3;
const RESPAWN_WINDOW_MS = 5 * 60 * 1000;

let worker = null;
let degraded = false;
let respawnCount = 0;
let respawnTimestamps = [];
let jobsProcessed = 0;

const findingsQueue = new Map();

function ensureWorker() {
  if (degraded) return null;
  if (worker) return worker;

  worker = new Worker(WORKER_PATH);

  worker.on('message', (msg) => {
    jobsProcessed++;
    if (msg.status === 'error') return;
    if (!msg.findings || !msg.findings.length) return;

    let queue = findingsQueue.get(msg.sessionId);
    if (!queue) {
      queue = [];
      findingsQueue.set(msg.sessionId, queue);
    }

    for (const f of msg.findings) {
      if (queue.length >= MAX_FINDINGS_PER_SESSION) break;
      queue.push(f);
    }
  });

  worker.on('error', (err) => {
    process.stderr.write('[async-manager] Worker error: ' + (err && err.message || err) + '\n');
  });

  worker.on('exit', (code) => {
    worker = null;
    if (code !== 0) {
      const now = Date.now();
      respawnTimestamps.push(now);
      respawnTimestamps = respawnTimestamps.filter(t => now - t < RESPAWN_WINDOW_MS);
      respawnCount++;

      if (respawnTimestamps.length >= MAX_RESPAWNS) {
        degraded = true;
      }
    }
  });

  return worker;
}

function postJob({ sessionId, projectRoot, analyzer, config, context }) {
  const w = ensureWorker();
  if (!w) return;

  const id = crypto.randomUUID();
  w.postMessage({ id, sessionId, projectRoot, analyzer, config, context });
}

function drainFindings(sessionId) {
  const queue = findingsQueue.get(sessionId);
  if (!queue || !queue.length) return [];
  const drained = queue.splice(0);
  findingsQueue.delete(sessionId);
  return drained;
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
  return {
    alive: worker !== null,
    respawnCount,
    jobsProcessed,
    degraded,
  };
}

async function shutdown() {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
}

module.exports = { postJob, drainFindings, clearSession, clearStaleSessions, getStatus, shutdown };
