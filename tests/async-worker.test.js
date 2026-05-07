const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WORKER_PATH = path.resolve(__dirname, '..', 'server', 'async-worker.js');

function spawnWorker() {
  return new Worker(WORKER_PATH);
}

function postAndWait(worker, message, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker response timeout')), timeoutMs);
    worker.once('message', (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    worker.postMessage(message);
  });
}

describe('Async Worker', () => {
  let tmpDir;
  let analyzersDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-test-'));
    analyzersDir = path.join(tmpDir, '.claude', 'skills', 'analyzers');
    fs.mkdirSync(analyzersDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs an analyzer and returns findings', async () => {
    const analyzerPath = path.join(analyzersDir, 'test-analyzer.js');
    fs.writeFileSync(analyzerPath, `
      module.exports.analyze = async function(context, config) {
        return [{ severity: 'warning', message: 'found issue in ' + context.filePath, relatedFiles: ['other.js'] }];
      };
    `);

    const worker = spawnWorker();
    try {
      const result = await postAndWait(worker, {
        id: 'job-1',
        sessionId: 'sess-1',
        projectRoot: tmpDir,
        analyzer: 'test-analyzer',
        config: {},
        context: { filePath: 'src/foo.js', content: 'hello', toolName: 'Edit', ruleName: 'test-rule' }
      });

      assert.equal(result.id, 'job-1');
      assert.equal(result.sessionId, 'sess-1');
      assert.equal(result.ruleName, 'test-rule');
      assert.equal(result.status, 'completed');
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].severity, 'warning');
      assert.ok(result.findings[0].message.includes('src/foo.js'));
      assert.equal(typeof result.durationMs, 'number');
    } finally {
      await worker.terminate();
    }
  });

  it('returns error status when analyzer file does not exist', async () => {
    const worker = spawnWorker();
    try {
      const result = await postAndWait(worker, {
        id: 'job-missing',
        sessionId: 'sess-1',
        projectRoot: tmpDir,
        analyzer: 'nonexistent',
        config: {},
        context: { filePath: 'x.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });
      assert.equal(result.status, 'error');
      assert.ok(result.error.includes('not found'));
      assert.deepStrictEqual(result.findings, []);
    } finally {
      await worker.terminate();
    }
  });

  it('returns error status when analyzer throws', async () => {
    const analyzerPath = path.join(analyzersDir, 'throws.js');
    fs.writeFileSync(analyzerPath, `
      module.exports.analyze = function() { throw new Error('boom'); };
    `);

    const worker = spawnWorker();
    try {
      const result = await postAndWait(worker, {
        id: 'job-throw',
        sessionId: 'sess-1',
        projectRoot: tmpDir,
        analyzer: 'throws',
        config: {},
        context: { filePath: 'x.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });
      assert.equal(result.status, 'error');
      assert.ok(result.error.includes('boom'));
    } finally {
      await worker.terminate();
    }
  });

  it('times out if analyzer takes too long', async () => {
    const analyzerPath = path.join(analyzersDir, 'slow.js');
    fs.writeFileSync(analyzerPath, `
      module.exports.analyze = function() {
        return new Promise(resolve => setTimeout(() => resolve([]), 30000));
      };
    `);

    const worker = spawnWorker();
    try {
      const result = await postAndWait(worker, {
        id: 'job-slow',
        sessionId: 'sess-1',
        projectRoot: tmpDir,
        analyzer: 'slow',
        config: {},
        context: { filePath: 'x.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      }, 15000);
      assert.equal(result.status, 'error');
      assert.ok(result.error.includes('timeout'));
    } finally {
      await worker.terminate();
    }
  });

  it('handles sync analyze functions', async () => {
    const analyzerPath = path.join(analyzersDir, 'sync-analyzer.js');
    fs.writeFileSync(analyzerPath, `
      module.exports.analyze = function(context, config) {
        return [{ severity: 'info', message: 'sync result', relatedFiles: [] }];
      };
    `);

    const worker = spawnWorker();
    try {
      const result = await postAndWait(worker, {
        id: 'job-sync',
        sessionId: 'sess-1',
        projectRoot: tmpDir,
        analyzer: 'sync-analyzer',
        config: {},
        context: { filePath: 'x.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });
      assert.equal(result.status, 'completed');
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].message, 'sync result');
    } finally {
      await worker.terminate();
    }
  });

  it('passes config to the analyzer', async () => {
    const analyzerPath = path.join(analyzersDir, 'config-echo.js');
    fs.writeFileSync(analyzerPath, `
      module.exports.analyze = function(context, config) {
        return [{ severity: 'info', message: 'maxFiles=' + config.maxFiles, relatedFiles: [] }];
      };
    `);

    const worker = spawnWorker();
    try {
      const result = await postAndWait(worker, {
        id: 'job-cfg',
        sessionId: 'sess-1',
        projectRoot: tmpDir,
        analyzer: 'config-echo',
        config: { maxFiles: 42 },
        context: { filePath: 'x.js', content: '', toolName: 'Edit', ruleName: 'r1' }
      });
      assert.equal(result.status, 'completed');
      assert.ok(result.findings[0].message.includes('maxFiles=42'));
    } finally {
      await worker.terminate();
    }
  });
});
