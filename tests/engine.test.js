const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const enginePath = path.resolve(__dirname, '..', 'server', 'async', 'engine.js');

function freshRequire() {
  const asyncDir = path.resolve(__dirname, '..', 'server', 'async');
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(asyncDir)) delete require.cache[key];
  }
  return require(enginePath);
}

describe('Engine', () => {
  let tmpDir;
  let analyzersDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-'));
    analyzersDir = path.join(tmpDir, '.claude', 'skills', 'analyzers');
    fs.mkdirSync(analyzersDir, { recursive: true });
    fs.writeFileSync(path.join(analyzersDir, 'engine-test.js'), `
      module.exports.analyze = function(context, config) {
        return [{ severity: 'warning', message: 'engine-finding' }];
      };
    `);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const defaultHelpers = {
    getSession: () => ({}),
    checkSkip: () => false,
    ruleMatchesProject: () => true,
  };

  it('dispatch + drain end-to-end with analyzer handler', async () => {
    const engine = freshRequire();
    try {
      const ctx = {
        compiledRules: [{
          name: 'test-rule',
          isAsync: true,
          asyncHandler: 'analyzer',
          asyncHandlerName: 'engine-test',
          asyncConfig: {},
          rule: {},
          sourceRepo: null,
        }],
        hasAsyncRules: true,
        projectRoot: tmpDir,
      };

      engine.dispatch(ctx, { session_id: 'eng-s1' },
        () => true,
        () => ({ projectRoot: tmpDir, filePath: 'a.js', toolName: 'Edit' }),
        defaultHelpers
      );

      await new Promise(resolve => setTimeout(resolve, 2000));

      const lines = engine.drain('eng-s1');
      assert.ok(lines.length > 0);
      assert.ok(lines.some(l => l.includes('engine-finding')));
    } finally {
      await engine.shutdown();
    }
  });

  it('getStatus returns aggregated status', async () => {
    const engine = freshRequire();
    try {
      const status = engine.getStatus();
      assert.ok('executor' in status);
      assert.ok('collector' in status);
      assert.ok('registry' in status);
      assert.ok(Array.isArray(status.registry.handlerTypes));
    } finally {
      await engine.shutdown();
    }
  });

  it('clearSession clears collector for session', async () => {
    const engine = freshRequire();
    try {
      const ctx = {
        compiledRules: [{
          name: 'clear-rule',
          isAsync: true,
          asyncHandler: 'analyzer',
          asyncHandlerName: 'engine-test',
          asyncConfig: {},
          rule: {},
          sourceRepo: null,
        }],
        hasAsyncRules: true,
        projectRoot: tmpDir,
      };

      engine.dispatch(ctx, { session_id: 'eng-clear' },
        () => true,
        () => ({ projectRoot: tmpDir, filePath: 'a.js', toolName: 'Edit' }),
        defaultHelpers
      );

      await new Promise(resolve => setTimeout(resolve, 1500));
      engine.clearSession('eng-clear');
      const lines = engine.drain('eng-clear');
      assert.equal(lines.length, 0);
    } finally {
      await engine.shutdown();
    }
  });
});
