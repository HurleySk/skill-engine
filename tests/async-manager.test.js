const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const managerPath = path.resolve(__dirname, '..', 'server', 'async-manager.js');

function freshRequire() {
  delete require.cache[managerPath];
  // Also clear the worker module cache to avoid stale workers
  const workerPath = path.resolve(__dirname, '..', 'server', 'async-worker.js');
  delete require.cache[workerPath];
  return require(managerPath);
}

describe('Async Manager', () => {
  let tmpDir;
  let analyzersDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-test-'));
    analyzersDir = path.join(tmpDir, '.claude', 'skills', 'analyzers');
    fs.mkdirSync(analyzersDir, { recursive: true });

    fs.writeFileSync(path.join(analyzersDir, 'simple.js'), `
      module.exports.analyze = function(context, config) {
        return [{ severity: 'warning', message: 'found it', relatedFiles: [] }];
      };
    `);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('postJob dispatches to worker and findings arrive in queue', async () => {
    const manager = freshRequire();
    try {
      manager.postJob({
        sessionId: 'sess-1',
        projectRoot: tmpDir,
        analyzer: 'simple',
        config: {},
        context: { filePath: 'a.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      const findings = manager.drainFindings('sess-1');
      assert.equal(findings.length, 1);
      assert.equal(findings[0].message, 'found it');
    } finally {
      await manager.shutdown();
    }
  });

  it('drainFindings returns empty array and clears queue', async () => {
    const manager = freshRequire();
    try {
      manager.postJob({
        sessionId: 'sess-2',
        projectRoot: tmpDir,
        analyzer: 'simple',
        config: {},
        context: { filePath: 'a.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      const first = manager.drainFindings('sess-2');
      assert.equal(first.length, 1);

      const second = manager.drainFindings('sess-2');
      assert.equal(second.length, 0);
    } finally {
      await manager.shutdown();
    }
  });

  it('getStatus reports worker state', async () => {
    const manager = freshRequire();
    try {
      manager.postJob({
        sessionId: 'sess-status',
        projectRoot: tmpDir,
        analyzer: 'simple',
        config: {},
        context: { filePath: 'a.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });
      await new Promise(resolve => setTimeout(resolve, 500));

      const status = manager.getStatus();
      assert.equal(status.alive, true);
      assert.equal(typeof status.respawnCount, 'number');
      assert.equal(typeof status.jobsProcessed, 'number');
      assert.equal(status.degraded, false);
    } finally {
      await manager.shutdown();
    }
  });

  it('caps findings at MAX_FINDINGS_PER_SESSION', async () => {
    const manyPath = path.join(analyzersDir, 'many.js');
    fs.writeFileSync(manyPath, `
      module.exports.analyze = function() {
        const out = [];
        for (let i = 0; i < 25; i++) out.push({ severity: 'info', message: 'item-' + i, relatedFiles: [] });
        return out;
      };
    `);

    const manager = freshRequire();
    try {
      manager.postJob({
        sessionId: 'sess-cap',
        projectRoot: tmpDir,
        analyzer: 'many',
        config: {},
        context: { filePath: 'a.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      const findings = manager.drainFindings('sess-cap');
      assert.ok(findings.length <= 20, 'should cap at 20 findings, got ' + findings.length);
    } finally {
      await manager.shutdown();
    }
  });

  it('clearSession removes findings for a session', async () => {
    const manager = freshRequire();
    try {
      manager.postJob({
        sessionId: 'sess-clear',
        projectRoot: tmpDir,
        analyzer: 'simple',
        config: {},
        context: { filePath: 'a.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });

      await new Promise(resolve => setTimeout(resolve, 1000));
      manager.clearSession('sess-clear');

      const findings = manager.drainFindings('sess-clear');
      assert.equal(findings.length, 0);
    } finally {
      await manager.shutdown();
    }
  });

  it('clearStaleSessions removes findings for inactive sessions', async () => {
    const manager = freshRequire();
    try {
      manager.postJob({
        sessionId: 'sess-stale',
        projectRoot: tmpDir,
        analyzer: 'simple',
        config: {},
        context: { filePath: 'a.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      // activeRegistry does NOT contain 'sess-stale'
      const activeRegistry = new Map();
      activeRegistry.set('some-other-session', {});
      manager.clearStaleSessions(activeRegistry);

      const findings = manager.drainFindings('sess-stale');
      assert.equal(findings.length, 0);
    } finally {
      await manager.shutdown();
    }
  });
});
