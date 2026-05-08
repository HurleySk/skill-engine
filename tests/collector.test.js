const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const collectorPath = path.resolve(__dirname, '..', 'server', 'async', 'collector.js');

function freshRequire() {
  delete require.cache[collectorPath];
  return require(collectorPath);
}

describe('Collector', () => {
  let collector;

  beforeEach(() => {
    collector = freshRequire();
    collector._reset();
  });

  it('pushFindings stores findings per session', () => {
    collector.pushFindings('s1', [{ severity: 'warning', message: 'x' }]);
    const drained = collector.drain('s1');
    assert.equal(drained.length, 1);
    assert.equal(drained[0].message, 'x');
  });

  it('drain clears the queue for that session', () => {
    collector.pushFindings('s1', [{ severity: 'info', message: 'a' }]);
    collector.drain('s1');
    const second = collector.drain('s1');
    assert.equal(second.length, 0);
  });

  it('caps findings at 20 per session', () => {
    const findings = [];
    for (let i = 0; i < 25; i++) findings.push({ severity: 'info', message: 'item-' + i });
    collector.pushFindings('s1', findings);
    const drained = collector.drain('s1');
    assert.equal(drained.length, 20);
  });

  it('accumulates across multiple pushes', () => {
    collector.pushFindings('s1', [{ severity: 'info', message: 'a' }]);
    collector.pushFindings('s1', [{ severity: 'info', message: 'b' }]);
    const drained = collector.drain('s1');
    assert.equal(drained.length, 2);
  });

  it('isolates sessions', () => {
    collector.pushFindings('s1', [{ severity: 'info', message: 'for-s1' }]);
    collector.pushFindings('s2', [{ severity: 'info', message: 'for-s2' }]);
    assert.equal(collector.drain('s1').length, 1);
    assert.equal(collector.drain('s2').length, 1);
    assert.equal(collector.drain('s1').length, 0);
  });

  it('clearSession removes findings', () => {
    collector.pushFindings('s1', [{ severity: 'info', message: 'a' }]);
    collector.clearSession('s1');
    assert.equal(collector.drain('s1').length, 0);
  });

  it('clearStaleSessions removes inactive sessions', () => {
    collector.pushFindings('stale', [{ severity: 'info', message: 'a' }]);
    collector.pushFindings('active', [{ severity: 'info', message: 'b' }]);
    const activeRegistry = new Map();
    activeRegistry.set('active', {});
    collector.clearStaleSessions(activeRegistry);
    assert.equal(collector.drain('stale').length, 0);
    assert.equal(collector.drain('active').length, 1);
  });

  it('format returns formatted lines for findings', () => {
    const findings = [
      { severity: 'warning', message: 'check this', relatedFiles: ['a.js'] },
      { severity: 'info', message: 'fyi' },
    ];
    const lines = collector.format(findings);
    assert.ok(lines.some(l => l.includes('Async Analysis Results')));
    assert.ok(lines.some(l => l.includes('check this')));
    assert.ok(lines.some(l => l.includes('Related: a.js')));
    assert.ok(lines.some(l => l.includes('fyi')));
  });

  it('format handles plain string findings', () => {
    const lines = collector.format(['plain text finding']);
    assert.ok(lines.some(l => l.includes('plain text finding')));
  });

  it('format returns empty array for empty findings', () => {
    const lines = collector.format([]);
    assert.equal(lines.length, 0);
  });

  it('drainFormatted drains and formats in one call', () => {
    collector.pushFindings('s1', [{ severity: 'warning', message: 'hello' }]);
    const lines = collector.drainFormatted('s1');
    assert.ok(lines.some(l => l.includes('hello')));
    assert.equal(collector.drain('s1').length, 0);
  });

  it('getStatus returns queue sizes', () => {
    collector.pushFindings('s1', [{ severity: 'info', message: 'a' }]);
    collector.pushFindings('s2', [{ severity: 'info', message: 'b' }, { severity: 'info', message: 'c' }]);
    const status = collector.getStatus();
    assert.equal(status.activeSessions, 2);
    assert.equal(status.totalPendingFindings, 3);
  });
});
