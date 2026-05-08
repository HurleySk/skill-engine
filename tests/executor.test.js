const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const executorPath = path.resolve(__dirname, '..', 'server', 'async', 'executor.js');

function freshRequire() {
  const asyncDir = path.resolve(__dirname, '..', 'server', 'async');
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(asyncDir)) delete require.cache[key];
  }
  return require(executorPath);
}

describe('Executor', () => {
  let tmpDir;
  let analyzersDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-test-'));
    analyzersDir = path.join(tmpDir, '.claude', 'skills', 'analyzers');
    fs.mkdirSync(analyzersDir, { recursive: true });
    fs.writeFileSync(path.join(analyzersDir, 'simple.js'), `
      module.exports.analyze = function(context, config) {
        return [{ severity: 'warning', message: 'exec-test-finding' }];
      };
    `);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('posts a job and receives result via onResult callback', async () => {
    const executor = freshRequire();
    try {
      const resultPromise = new Promise((resolve) => {
        executor.onResult((result) => {
          if (result.sessionId === 'exec-s1') resolve(result);
        });
      });
      executor.postJob({
        sessionId: 'exec-s1',
        projectRoot: tmpDir,
        handlerType: 'analyzer',
        handlerName: 'simple',
        config: {},
        context: { projectRoot: tmpDir, filePath: 'a.js', toolName: 'Edit' },
      });
      const result = await Promise.race([
        resultPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
      ]);
      assert.equal(result.status, 'completed');
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].message, 'exec-test-finding');
    } finally {
      await executor.shutdown();
    }
  });

  it('getStatus reports worker state', async () => {
    const executor = freshRequire();
    try {
      executor.postJob({
        sessionId: 'exec-status',
        projectRoot: tmpDir,
        handlerType: 'analyzer',
        handlerName: 'simple',
        config: {},
        context: { projectRoot: tmpDir, filePath: 'a.js', toolName: 'Edit' },
      });
      await new Promise(resolve => setTimeout(resolve, 1000));
      const status = executor.getStatus();
      assert.equal(status.alive, true);
      assert.equal(status.degraded, false);
      assert.ok(status.jobsProcessed >= 1);
    } finally {
      await executor.shutdown();
    }
  });

  it('shutdown terminates worker', async () => {
    const executor = freshRequire();
    executor.postJob({
      sessionId: 'exec-shutdown',
      projectRoot: tmpDir,
      handlerType: 'analyzer',
      handlerName: 'simple',
      config: {},
      context: { projectRoot: tmpDir, filePath: 'a.js', toolName: 'Edit' },
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    await executor.shutdown();
    const status = executor.getStatus();
    assert.equal(status.alive, false);
  });
});
