'use strict';

const registry = require('./registry');
const dispatcher = require('./dispatcher');
const executor = require('./executor');
const collector = require('./collector');
const analyzerHandler = require('./handlers/analyzer');
const hookHandler = require('./handlers/hook');

registry.register(analyzerHandler);
registry.register(hookHandler);

executor.onResult((result) => {
  if (result.status === 'error') return;
  if (!result.findings || !result.findings.length) return;
  collector.pushFindings(result.sessionId, result.findings);
});

function dispatch(ctx, input, matchFn, contextBuilder, helpers) {
  dispatcher.dispatch(ctx, input, matchFn, contextBuilder, (job) => {
    executor.postJob(job);
  }, helpers);
}

function drain(sessionId) {
  return collector.drainFormatted(sessionId);
}

function getStatus() {
  return {
    executor: executor.getStatus(),
    collector: collector.getStatus(),
    registry: { handlerTypes: registry.list() },
  };
}

async function shutdown() {
  await executor.shutdown();
}

function clearSession(sessionId) {
  collector.clearSession(sessionId);
}

function clearStaleSessions(activeRegistry) {
  collector.clearStaleSessions(activeRegistry);
}

module.exports = {
  dispatch, drain, getStatus, shutdown,
  clearSession, clearStaleSessions,
  registry, collector, executor,
};
