const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const hookHandlerPath = path.resolve(__dirname, '..', 'server', 'async', 'handlers', 'hook.js');

function freshRequire() {
  delete require.cache[hookHandlerPath];
  return require(hookHandlerPath);
}

describe('Hook Handler', () => {
  let hookHandler;

  beforeEach(() => {
    hookHandler = freshRequire();
    hookHandler._clearHooks();
  });

  it('has correct name', () => {
    assert.equal(hookHandler.name, 'hook');
  });

  it('validate returns errors for unregistered hook name', () => {
    const errors = hookHandler.validate({ hookName: 'nonexistent' });
    assert.ok(errors.length > 0);
  });

  it('validate passes for registered hook name', () => {
    hookHandler.registerHook('my-scan', async () => []);
    const errors = hookHandler.validate({ hookName: 'my-scan' });
    assert.equal(errors.length, 0);
  });

  it('execute runs the registered hook function', async () => {
    hookHandler.registerHook('test-hook', async (ctx, config) => {
      return [{ severity: 'info', message: 'hook-ran:' + config.flag }];
    });
    const findings = await hookHandler.execute({
      name: 'test-hook',
      config: { flag: 'yes' },
      context: { toolName: 'Write', filePath: 'a.js' },
    });
    assert.equal(findings.length, 1);
    assert.ok(findings[0].message.includes('hook-ran:yes'));
  });

  it('execute returns empty for unregistered hook', async () => {
    const findings = await hookHandler.execute({
      name: 'missing',
      config: {},
      context: {},
    });
    assert.equal(findings.length, 0);
  });

  it('execute catches errors in hook function', async () => {
    hookHandler.registerHook('bad', async () => { throw new Error('boom'); });
    const findings = await hookHandler.execute({
      name: 'bad',
      config: {},
      context: {},
    });
    assert.equal(findings.length, 0);
  });

  it('listHooks returns registered hook names', () => {
    hookHandler.registerHook('a', async () => []);
    hookHandler.registerHook('b', async () => []);
    assert.deepStrictEqual(hookHandler.listHooks().sort(), ['a', 'b']);
  });
});
