const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const rulesIO = require(path.resolve(__dirname, '..', 'hooks', 'lib', 'rules-io.js'));

describe('Rules Loading', () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures');

  it('loadRules returns parsed data for valid rules file', () => {
    const result = rulesIO.loadRules(path.join(fixturesDir, 'valid-rules.json'));
    assert.equal(result.version, '1.0');
    assert.ok(result.rules['sql-standards']);
    assert.ok(result.rules['pipeline-guidance']);
    assert.ok(result.rules['config-warning']);
    assert.equal(result.defaults.enforcement, 'suggest');
    assert.equal(result.defaults.priority, 'medium');
  });

  it('loadRules returns null for missing file', () => {
    const result = rulesIO.loadRules('/nonexistent/path/rules.json');
    assert.equal(result, null);
  });

  it('loadRules returns null for malformed JSON', () => {
    const result = rulesIO.loadRules(path.join(fixturesDir, 'malformed.json'));
    assert.equal(result, null);
  });

  it('loadRules returns null for JSON without version field', () => {
    const tmpFile = path.join(os.tmpdir(), 'no-version.json');
    fs.writeFileSync(tmpFile, JSON.stringify({ rules: {} }));
    const result = rulesIO.loadRules(tmpFile);
    assert.equal(result, null);
    fs.unlinkSync(tmpFile);
  });

  it('findRulesFile walks up directories to find skill-rules.json', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'se-test-'));
    const projectDir = path.join(tmpBase, 'project');
    const srcDir = path.join(projectDir, 'src', 'deep');
    const rulesDir = path.join(projectDir, '.claude', 'skills');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(rulesDir, { recursive: true });
    const rulesFile = path.join(rulesDir, 'skill-rules.json');
    fs.writeFileSync(rulesFile, '{"version":"1.0","rules":{}}');
    const found = rulesIO.findRulesFile(srcDir);
    assert.equal(found, rulesFile);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('findRulesFile returns null when no rules file exists', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'se-test-'));
    const result = rulesIO.findRulesFile(tmpBase);
    assert.equal(result, null);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('findLearnedRulesFile finds learned-rules.json walking up directories', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'se-test-'));
    const projectDir = path.join(tmpBase, 'project');
    const srcDir = path.join(projectDir, 'src', 'deep');
    const rulesDir = path.join(projectDir, '.claude', 'skills');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(rulesDir, { recursive: true });
    const learnedFile = path.join(rulesDir, 'learned-rules.json');
    fs.writeFileSync(learnedFile, '{"version":"1.0","rules":{}}');
    const found = rulesIO.findLearnedRulesFile(srcDir);
    assert.equal(found, learnedFile);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('findLearnedRulesFile returns null when no file exists', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'se-test-'));
    const result = rulesIO.findLearnedRulesFile(tmpBase);
    assert.equal(result, null);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('re-exports normalizePath from glob-match', () => {
    assert.equal(typeof rulesIO.normalizePath, 'function');
    assert.equal(rulesIO.normalizePath('C:\\Users\\test\\file.sql'), 'C:/Users/test/file.sql');
  });
});
