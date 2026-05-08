'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const crypto = require('crypto');

const WORKER_PATH = path.resolve(__dirname, 'async-worker.js');
const MAX_RESPAWNS = 3;
const RESPAWN_WINDOW_MS = 5 * 60 * 1000;

let worker = null;
let degraded = false;
let respawnCount = 0;
let respawnTimestamps = [];
let jobsProcessed = 0;
const resultCallbacks = [];

function ensureWorker() {
  if (degraded) return null;
  if (worker) return worker;

  worker = new Worker(WORKER_PATH);

  worker.on('message', (msg) => {
    jobsProcessed++;
    for (const cb of resultCallbacks) {
      try { cb(msg); } catch {}
    }
  });

  worker.on('error', (err) => {
    process.stderr.write('[executor] Worker error: ' + (err && err.message || err) + '\n');
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

function postJob(job) {
  const w = ensureWorker();
  if (!w) return;
  const id = crypto.randomUUID();
  w.postMessage({ id, ...job });
}

function onResult(callback) {
  resultCallbacks.push(callback);
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

module.exports = { postJob, onResult, getStatus, shutdown };
