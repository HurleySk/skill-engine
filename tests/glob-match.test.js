const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const gm = require(path.resolve(__dirname, '..', 'hooks', 'lib', 'glob-match.js'));

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    assert.equal(gm.normalizePath('C:\\Users\\test\\file.sql'), 'C:/Users/test/file.sql');
  });

  it('leaves forward slashes unchanged', () => {
    assert.equal(gm.normalizePath('src/db/file.sql'), 'src/db/file.sql');
  });
});

describe('globToRegex', () => {
  it('** matches across path segments', () => {
    const re = gm.globToRegex('**/*.sql');
    assert.equal(re.test('src/db/sprocs/GetUsers.sql'), true);
    assert.equal(re.test('deep/nested/path/file.sql'), true);
    assert.equal(re.test('file.sql'), true);
    assert.equal(re.test('file.txt'), false);
  });

  it('* matches within a single segment', () => {
    const re = gm.globToRegex('tasks/*.json');
    assert.equal(re.test('tasks/foo.json'), true);
    assert.equal(re.test('tasks/sub/foo.json'), false);
  });

  it('? matches a single character', () => {
    const re = gm.globToRegex('file?.txt');
    assert.equal(re.test('file1.txt'), true);
    assert.equal(re.test('file.txt'), false);
    assert.equal(re.test('file12.txt'), false);
  });

  it('/** matches recursive suffix', () => {
    const re = gm.globToRegex('src/**');
    assert.equal(re.test('src/a.js'), true);
    assert.equal(re.test('src/a/b/c.js'), true);
  });

  it('handles nested ** with surrounding segments', () => {
    const re = gm.globToRegex('work-repo/**/pipeline/*.json');
    assert.equal(re.test('work-repo/a/b/pipeline/x.json'), true);
    assert.equal(re.test('work-repo/pipeline/x.json'), true);
    assert.equal(re.test('other/pipeline/x.json'), false);
  });

  it('escapes regex special characters', () => {
    const re = gm.globToRegex('file.name[1].txt');
    assert.equal(re.test('file.name[1].txt'), true);
    assert.equal(re.test('filexname1x.txt'), false);
  });

  it('caseInsensitive option adds i flag', () => {
    const re = gm.globToRegex('**/*.JSON', { caseInsensitive: true });
    assert.equal(re.test('tasks/FOO.json'), true);
    assert.equal(re.test('tasks/foo.JSON'), true);
  });

  it('default is case-sensitive', () => {
    const re = gm.globToRegex('**/*.json');
    assert.equal(re.test('tasks/foo.json'), true);
    assert.equal(re.test('tasks/foo.JSON'), false);
  });
});

describe('matchPath', () => {
  it('matches glob patterns', () => {
    assert.equal(gm.matchPath('src/db/sprocs/GetUsers.sql', ['**/*.sql'], []), true);
    assert.equal(gm.matchPath('file.txt', ['**/*.sql'], []), false);
  });

  it('respects exclusions', () => {
    assert.equal(gm.matchPath('migrations/001.sql', ['**/*.sql'], ['**/migrations/**']), false);
    assert.equal(gm.matchPath('src/db/GetUsers.sql', ['**/*.sql'], ['**/migrations/**']), true);
  });

  it('handles Windows backslash paths', () => {
    assert.equal(gm.matchPath('src\\db\\file.sql', ['**/*.sql'], []), true);
  });

  it('returns false for empty patterns', () => {
    assert.equal(gm.matchPath('file.sql', [], []), false);
    assert.equal(gm.matchPath('file.sql', null, []), false);
  });

  it('passes opts through to globToRegex', () => {
    assert.equal(gm.matchPath('FILE.SQL', ['**/*.sql'], [], { caseInsensitive: true }), true);
    assert.equal(gm.matchPath('FILE.SQL', ['**/*.sql'], []), false);
  });
});

describe('globMatch', () => {
  it('is case-insensitive by default', () => {
    assert.equal(gm.globMatch('**/*.json', 'tasks/FOO.JSON'), true);
  });

  it('normalizes backslashes', () => {
    assert.equal(gm.globMatch('src/**/*.js', 'src\\lib\\util.js'), true);
  });

  it('does not match across segments with single *', () => {
    assert.equal(gm.globMatch('tasks/*.json', 'tasks/sub/foo.json'), false);
  });
});
