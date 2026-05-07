'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const THRESHOLD_COUNT = 3;
const MAX_SIGNALS = 200;
const ROLLING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

let baseDir = path.join(os.homedir(), '.claude');

function _setBaseDir(dir) { baseDir = dir; }

function logPath() { return path.join(baseDir, 'skill-feedback-log.jsonl'); }
function thresholdsPath() { return path.join(baseDir, 'skill-feedback-thresholds.json'); }

function readThresholds() {
  try {
    return JSON.parse(fs.readFileSync(thresholdsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeThresholds(data) {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(thresholdsPath(), JSON.stringify(data, null, 2));
}

function recordSignal(signal) {
  const entry = {
    skillName: signal.skillName,
    type: signal.type,
    summary: signal.summary || '',
    timestamp: new Date().toISOString(),
  };
  if (signal.sessionId) entry.sessionId = signal.sessionId;
  if (signal.project) entry.project = signal.project;
  if (signal.skillSource) entry.skillSource = signal.skillSource;

  fs.mkdirSync(baseDir, { recursive: true });
  fs.appendFileSync(logPath(), JSON.stringify(entry) + '\n');

  _evictIfNeeded();

  const needsReview = [];
  if (signal.type === 'correction' || signal.type === 'lesson') {
    const thresholds = readThresholds();
    const key = signal.skillName;
    if (!thresholds[key]) {
      thresholds[key] = { corrections: 0, needsReview: false };
    }
    thresholds[key].corrections++;
    thresholds[key].lastSignal = entry.timestamp;
    if (thresholds[key].corrections >= THRESHOLD_COUNT && !thresholds[key].needsReview) {
      thresholds[key].needsReview = true;
      thresholds[key].lastFlagged = entry.timestamp;
      needsReview.push(key);
    }
    writeThresholds(thresholds);
  }

  return { recorded: true, needsReview };
}

function _evictIfNeeded() {
  try {
    const content = fs.readFileSync(logPath(), 'utf8').trim();
    if (!content) return;
    const lines = content.split('\n');
    if (lines.length > MAX_SIGNALS) {
      const trimmed = lines.slice(lines.length - MAX_SIGNALS);
      fs.writeFileSync(logPath(), trimmed.join('\n') + '\n');
    }
  } catch {}
}

function getThresholds() {
  return readThresholds();
}

function readAllSignals() {
  try {
    const content = fs.readFileSync(logPath(), 'utf8').trim();
    if (!content) return [];
    return content.split('\n').map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function getHealth() {
  const thresholds = readThresholds();
  const flagged = [];
  for (const [skillName, data] of Object.entries(thresholds)) {
    if (data.needsReview) {
      flagged.push({ skillName, corrections: data.corrections, lastFlagged: data.lastFlagged });
    }
  }

  let totalSignals = 0;
  try {
    const content = fs.readFileSync(logPath(), 'utf8').trim();
    if (content) totalSignals = content.split('\n').length;
  } catch {}

  return { flagged, totalSignals };
}

function clearSkill(skillName) {
  const thresholds = readThresholds();
  delete thresholds[skillName];
  writeThresholds(thresholds);

  try {
    const content = fs.readFileSync(logPath(), 'utf8').trim();
    if (!content) return;
    const lines = content.split('\n').map(line => {
      const signal = JSON.parse(line);
      if (signal.skillName === skillName && !signal.resolved) {
        signal.resolved = true;
      }
      return JSON.stringify(signal);
    });
    fs.writeFileSync(logPath(), lines.join('\n') + '\n');
  } catch {}
}

function getSignalsForSkill(skillName, options) {
  const includeResolved = options && options.includeResolved;
  const signals = readAllSignals();
  return signals.filter(s => {
    if (s.skillName !== skillName) return false;
    if (!includeResolved && s.resolved) return false;
    return true;
  });
}

function recount() {
  const cutoff = new Date(Date.now() - ROLLING_WINDOW_MS).toISOString();
  const signals = readAllSignals();
  const counts = {};

  for (const signal of signals) {
    if (signal.resolved) continue;
    if (signal.timestamp < cutoff) continue;
    if (signal.type !== 'correction' && signal.type !== 'lesson') continue;
    const key = signal.skillName;
    if (!counts[key]) counts[key] = 0;
    counts[key]++;
  }

  const thresholds = {};
  for (const [skillName, count] of Object.entries(counts)) {
    thresholds[skillName] = {
      corrections: count,
      needsReview: count >= THRESHOLD_COUNT,
    };
    if (count >= THRESHOLD_COUNT) {
      thresholds[skillName].lastFlagged = new Date().toISOString();
    }
  }
  writeThresholds(thresholds);
}

module.exports = { recordSignal, getThresholds, getHealth, clearSkill, getSignalsForSkill, recount, _setBaseDir };
