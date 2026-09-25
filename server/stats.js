'use strict';

const AUDIT_LOG_MAX = 100;

const state = {
  paused: false,
  eventsProcessed: 0,
  lastEvent: null,
  totalResponseTimeNs: BigInt(0),
  timedResponses: 0,
};
const auditLog = [];

function recordEvent(event, elapsedNs, auditEntry) {
  state.eventsProcessed++;
  state.lastEvent = event;
  state.totalResponseTimeNs += elapsedNs;
  state.timedResponses++;
  auditLog.push(auditEntry);
  if (auditLog.length > AUDIT_LOG_MAX) auditLog.shift();
}

function avgResponseMs() {
  if (!state.timedResponses) return 0;
  return Math.round(Number(state.totalResponseTimeNs / BigInt(state.timedResponses)) / 1e4) / 100;
}

function auditSummary() {
  if (!auditLog.length) return { entries: 0, oldestEntry: null, newestEntry: null };
  return { entries: auditLog.length, oldestEntry: auditLog[0].timestamp, newestEntry: auditLog[auditLog.length - 1].timestamp };
}

function auditEntries() {
  return auditLog.slice().reverse();
}

module.exports = { state, recordEvent, avgResponseMs, auditSummary, auditEntries };
