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

  it('execute reloads an analyzer after its file changes', async () => {
    const file = path.join(analyzersDir, 'edited.js');
    const run = () => analyzerHandler.execute({
      name: 'edited',
      config: {},
      context: { projectRoot: tmpDir, command: 'x', toolName: 'Bash' },
    });

    fs.writeFileSync(file, `module.exports.analyze = () => [{ severity: 'info', message: 'v1' }];`);
    assert.equal((await run())[0].message, 'v1');

    fs.writeFileSync(file, `module.exports.analyze = () => [{ severity: 'info', message: 'v2' }];`);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    assert.equal((await run())[0].message, 'v2');
  });

  it('execute reloads an analyzer after a shared helper changes', async () => {
    const helper = path.join(analyzersDir, '_helper.js');
    fs.writeFileSync(helper, `module.exports.word = 'old';`);
    fs.writeFileSync(path.join(analyzersDir, 'uses-helper.js'), `
      const helper = require('./_helper');
      module.exports.analyze = () => [{ severity: 'info', message: helper.word }];
    `);
    const run = () => analyzerHandler.execute({
      name: 'uses-helper',
      config: {},
      context: { projectRoot: tmpDir, command: 'x', toolName: 'Bash' },
    });

    assert.equal((await run())[0].message, 'old');

    fs.writeFileSync(helper, `module.exports.word = 'new';`);
    const later = new Date(Date.now() + 10000);
    fs.utimesSync(helper, later, later);
    assert.equal((await run())[0].message, 'new');
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
