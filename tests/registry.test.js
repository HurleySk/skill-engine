const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const registryPath = path.resolve(__dirname, '..', 'server', 'async', 'registry.js');

function freshRequire() {
  delete require.cache[registryPath];
  return require(registryPath);
}

describe('Registry', () => {
  let registry;

  beforeEach(() => {
    registry = freshRequire();
    registry.clear();
  });

  it('registers and retrieves a handler type', () => {
    const handler = {
      name: 'test-handler',
      validate(config) { return []; },
      execute(job) { return []; },
    };
    registry.register(handler);
    const got = registry.get('test-handler');
    assert.equal(got.name, 'test-handler');
  });

  it('throws on duplicate registration', () => {
    const handler = { name: 'dup', validate() { return []; }, execute() { return []; } };
    registry.register(handler);
    assert.throws(() => registry.register(handler), /already registered/);
  });

  it('throws on missing required fields', () => {
    assert.throws(() => registry.register({ name: 'no-validate' }), /validate/);
    assert.throws(() => registry.register({ name: 'no-execute', validate() { return []; } }), /execute/);
  });

  it('get returns undefined for unregistered type', () => {
    assert.equal(registry.get('nope'), undefined);
  });

  it('list returns registered type names', () => {
    registry.register({ name: 'a', validate() { return []; }, execute() { return []; } });
    registry.register({ name: 'b', validate() { return []; }, execute() { return []; } });
    const names = registry.list();
    assert.deepStrictEqual(names.sort(), ['a', 'b']);
  });

  it('validateAsyncBlock rejects unknown handler type', () => {
    const errors = registry.validateAsyncBlock({ handler: 'nope', name: 'x' });
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes('Unknown'));
  });

  it('validateAsyncBlock delegates to handler validate', () => {
    registry.register({
      name: 'strict',
      validate(config) {
        if (!config.required) return ['missing required field'];
        return [];
      },
      execute() { return []; },
    });
    const errors = registry.validateAsyncBlock({ handler: 'strict', name: 'x', config: {} });
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes('required'));
  });

  it('validateAsyncBlock passes valid config', () => {
    registry.register({
      name: 'lenient',
      validate() { return []; },
      execute() { return []; },
    });
    const errors = registry.validateAsyncBlock({ handler: 'lenient', name: 'x', config: {} });
    assert.equal(errors.length, 0);
  });

  it('normalizeAsyncBlock maps old format to new', () => {
    const old = { analyzer: 'cross-file', config: { maxFiles: 50 } };
    const normalized = registry.normalizeAsyncBlock(old);
    assert.equal(normalized.handler, 'analyzer');
    assert.equal(normalized.name, 'cross-file');
    assert.deepStrictEqual(normalized.config, { maxFiles: 50 });
  });

  it('normalizeAsyncBlock passes through new format unchanged', () => {
    const newFmt = { handler: 'hook', name: 'scan', config: {} };
    const normalized = registry.normalizeAsyncBlock(newFmt);
    assert.deepStrictEqual(normalized, newFmt);
  });
});
