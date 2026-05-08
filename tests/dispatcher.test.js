const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const dispatcher = require(path.resolve(__dirname, '..', 'server', 'async', 'dispatcher.js'));

describe('Dispatcher', () => {
  function makeRule(name, opts = {}) {
    return {
      name,
      isAsync: true,
      asyncHandler: opts.handler || 'analyzer',
      asyncHandlerName: opts.handlerName || 'test',
      asyncConfig: opts.config || {},
      rule: opts.rule || {},
      sourceRepo: opts.sourceRepo || null,
    };
  }

  const defaultHelpers = {
    getSession: () => ({}),
    checkSkip: () => false,
    ruleMatchesProject: () => true,
  };

  it('dispatches matching async rules as jobs', () => {
    const rules = [makeRule('r1'), makeRule('r2')];
    const jobs = [];
    dispatcher.dispatch({
      compiledRules: rules,
      hasAsyncRules: true,
      projectRoot: '/proj',
    }, {
      session_id: 's1',
    }, () => true, () => ({ prompt: 'hello' }), (job) => jobs.push(job), defaultHelpers);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].handlerType, 'analyzer');
    assert.equal(jobs[0].sessionId, 's1');
  });

  it('skips non-async rules', () => {
    const rules = [
      { name: 'sync', isAsync: false, rule: {} },
      makeRule('async-one'),
    ];
    const jobs = [];
    dispatcher.dispatch({
      compiledRules: rules,
      hasAsyncRules: true,
      projectRoot: '/proj',
    }, { session_id: 's1' }, () => true, () => ({}), (job) => jobs.push(job), defaultHelpers);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].context.ruleName, 'async-one');
  });

  it('skips rules that do not match', () => {
    const rules = [makeRule('r1')];
    const jobs = [];
    dispatcher.dispatch({
      compiledRules: rules,
      hasAsyncRules: true,
      projectRoot: '/proj',
    }, { session_id: 's1' }, () => false, () => ({}), (job) => jobs.push(job), defaultHelpers);
    assert.equal(jobs.length, 0);
  });

  it('skips rules that checkSkip returns true for', () => {
    const rules = [makeRule('r1')];
    const jobs = [];
    dispatcher.dispatch({
      compiledRules: rules,
      hasAsyncRules: true,
      projectRoot: '/proj',
    }, { session_id: 's1' }, () => true, () => ({}), (job) => jobs.push(job), {
      ...defaultHelpers,
      checkSkip: () => true,
    });
    assert.equal(jobs.length, 0);
  });

  it('does nothing when hasAsyncRules is false', () => {
    const rules = [makeRule('r1')];
    const jobs = [];
    dispatcher.dispatch({
      compiledRules: rules,
      hasAsyncRules: false,
      projectRoot: '/proj',
    }, { session_id: 's1' }, () => true, () => ({}), (job) => jobs.push(job), defaultHelpers);
    assert.equal(jobs.length, 0);
  });

  it('includes handlerType, handlerName, config, and context in jobs', () => {
    const rules = [makeRule('r1', { handler: 'hook', handlerName: 'scan', config: { dir: 'src/' } })];
    const jobs = [];
    dispatcher.dispatch({
      compiledRules: rules,
      hasAsyncRules: true,
      projectRoot: '/proj',
    }, { session_id: 's1' }, () => true, () => ({ filePath: 'a.js' }), (job) => jobs.push(job), defaultHelpers);
    assert.equal(jobs[0].handlerType, 'hook');
    assert.equal(jobs[0].handlerName, 'scan');
    assert.deepStrictEqual(jobs[0].config, { dir: 'src/' });
    assert.equal(jobs[0].context.filePath, 'a.js');
    assert.equal(jobs[0].context.ruleName, 'r1');
  });
});
