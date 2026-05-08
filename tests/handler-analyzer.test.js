const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const analyzerHandler = require(path.resolve(__dirname, '..', 'server', 'async', 'handlers', 'analyzer.js'));

describe('Analyzer Handler', () => {
  let tmpDir;
  let analyzersDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-'));
    analyzersDir = path.join(tmpDir, '.claude', 'skills', 'analyzers');
    fs.mkdirSync(analyzersDir, { recursive: true });

    fs.writeFileSync(path.join(analyzersDir, 'good.js'), `
      module.exports.analyze = function(context, config) {
        return [{ severity: 'info', message: 'found:' + config.key }];
      };
    `);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has correct name', () => {
    assert.equal(analyzerHandler.name, 'analyzer');
  });

  it('validate accepts any config', () => {
    assert.deepStrictEqual(analyzerHandler.validate({}), []);
    assert.deepStrictEqual(analyzerHandler.validate({ maxFiles: 50 }), []);
  });

  it('execute loads and runs analyzer script', async () => {
    const findings = await analyzerHandler.execute({
      name: 'good',
      config: { key: 'hello' },
      context: { projectRoot: tmpDir, filePath: 'x.js', content: '', toolName: 'Edit' },
    });
    assert.equal(findings.length, 1);
    assert.ok(findings[0].message.includes('found:hello'));
  });

  it('execute returns empty for missing analyzer', async () => {
    const findings = await analyzerHandler.execute({
      name: 'nonexistent',
      config: {},
      context: { projectRoot: tmpDir, filePath: 'x.js', content: '', toolName: 'Edit' },
    });
    assert.equal(findings.length, 0);
  });

  it('execute rejects path traversal in name', async () => {
    const findings = await analyzerHandler.execute({
      name: '../../../etc/passwd',
      config: {},
      context: { projectRoot: tmpDir, filePath: 'x.js', content: '', toolName: 'Edit' },
    });
    assert.equal(findings.length, 0);
  });
});
