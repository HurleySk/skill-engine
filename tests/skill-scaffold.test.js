const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scaffold = require(path.resolve(__dirname, '..', 'hooks', 'lib', 'skill-scaffold.js'));

describe('validate', () => {
  it('accepts valid inputs', () => {
    const result = scaffold.validate('My Skill', 'A useful skill', 'Do the thing.');
    assert.equal(result.ok, true);
  });

  it('rejects empty name', () => {
    const result = scaffold.validate('', 'A useful skill', 'Do the thing.');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('name'));
  });

  it('rejects empty description', () => {
    const result = scaffold.validate('My Skill', '', 'Do the thing.');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('description'));
  });

  it('rejects empty body', () => {
    const result = scaffold.validate('My Skill', 'A useful skill', '');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('body'));
  });

  it('rejects multi-line description', () => {
    const result = scaffold.validate('My Skill', 'Line one\nLine two', 'Do the thing.');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('single line'));
  });

  it('rejects description with frontmatter-breaking characters', () => {
    const result = scaffold.validate('My Skill', 'Bad --- description', 'Do the thing.');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('---'));
  });
});

describe('slugify', () => {
  it('converts spaces to hyphens', () => {
    assert.equal(scaffold.slugify('Deploy Staging'), 'deploy-staging');
  });

  it('removes special characters', () => {
    assert.equal(scaffold.slugify('Hello World!@#$'), 'hello-world');
  });

  it('collapses multiple hyphens', () => {
    assert.equal(scaffold.slugify('a - - b'), 'a-b');
  });

  it('trims leading/trailing hyphens', () => {
    assert.equal(scaffold.slugify('-hello-'), 'hello');
  });
});

describe('create', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates directory and SKILL.md with valid frontmatter', () => {
    const result = scaffold.create('Deploy Staging', 'Guide for staging deployments', 'Step 1: Do the thing.\n\nStep 2: Check it.', tmpDir);
    assert.equal(result.ok, true);
    assert.ok(result.path.endsWith(path.join('deploy-staging', 'SKILL.md')));
    const content = fs.readFileSync(result.path, 'utf8');
    assert.ok(content.startsWith('---\n'));
    assert.ok(content.includes('name: Deploy Staging'));
    assert.ok(content.includes('description: Guide for staging deployments'));
    assert.ok(content.includes('Step 1: Do the thing.'));
  });

  it('does not overwrite existing skill', () => {
    scaffold.create('my-skill', 'First version', 'Body 1.', tmpDir);
    const result = scaffold.create('my-skill', 'Second version', 'Body 2.', tmpDir);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('already exists'));
  });

  it('creates nested output directory if needed', () => {
    const nestedDir = path.join(tmpDir, 'deep', 'nested', 'skills');
    const result = scaffold.create('My Skill', 'A skill', 'Body text.', nestedDir);
    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(result.path));
  });
});

describe('list', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists all skills with name and description', () => {
    scaffold.create('Alpha Skill', 'First skill', 'Body alpha.', tmpDir);
    scaffold.create('Beta Skill', 'Second skill', 'Body beta.', tmpDir);
    const result = scaffold.list(tmpDir);
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('Alpha Skill'));
    assert.ok(result.output.includes('First skill'));
    assert.ok(result.output.includes('Beta Skill'));
    assert.ok(result.output.includes('Second skill'));
  });

  it('returns empty message when no skills exist', () => {
    const result = scaffold.list(tmpDir);
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('No skills found'));
  });

  it('returns empty message for nonexistent directory', () => {
    const result = scaffold.list(path.join(tmpDir, 'nonexistent'));
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('No skills found'));
  });
});
