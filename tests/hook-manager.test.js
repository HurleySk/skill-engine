const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const hookManager = require(path.resolve(__dirname, '..', 'hooks', 'lib', 'hook-manager.js'));

// ── validate ────────────────────────────────────────────────────────
describe('validate', () => {
  it('accepts valid PreToolUse entry with matcher', () => {
    const result = hookManager.validate('PreToolUse', {
      command: 'bash enforce.sh',
      matcher: ['Edit', 'Write']
    });
    assert.equal(result.ok, true);
  });

  it('accepts valid UserPromptSubmit entry without matcher', () => {
    const result = hookManager.validate('UserPromptSubmit', {
      command: 'bash activate.sh'
    });
    assert.equal(result.ok, true);
  });

  it('rejects unknown hook type', () => {
    const result = hookManager.validate('BeforeRun', {
      command: 'bash foo.sh'
    });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('Unknown hook type'));
  });

  it('rejects empty command', () => {
    const result = hookManager.validate('PreToolUse', {
      command: '   '
    });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('non-empty command'));
  });

  it('rejects missing command', () => {
    const result = hookManager.validate('PreToolUse', {});
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('non-empty command'));
  });

  it('rejects non-array matcher', () => {
    const result = hookManager.validate('PreToolUse', {
      command: 'bash enforce.sh',
      matcher: 'Edit'
    });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('array'));
  });
});

// ── add ─────────────────────────────────────────────────────────────
describe('add', () => {
  let tmpDir;
  let settingsPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-mgr-test-'));
    settingsPath = path.join(tmpDir, '.claude', 'settings.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates settings.json when file does not exist', () => {
    const result = hookManager.add('PreToolUse', {
      command: 'bash enforce.sh',
      matcher: ['Edit']
    }, settingsPath);
    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(settingsPath));

    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(data.hooks.PreToolUse.length, 1);
    assert.equal(data.hooks.PreToolUse[0].command, 'bash enforce.sh');
  });

  it('appends to existing hook array without clobbering', () => {
    // Seed with the sample fixture
    const fixture = path.resolve(__dirname, 'fixtures', 'sample-settings.json');
    const dir = path.dirname(settingsPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(fixture, settingsPath);

    const result = hookManager.add('PreToolUse', {
      command: 'bash lint.sh',
      matcher: ['Edit']
    }, settingsPath);
    assert.equal(result.ok, true);

    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(data.hooks.PreToolUse.length, 2);
  });

  it('preserves non-hook settings keys', () => {
    const dir = path.dirname(settingsPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['Read'] }
    }), 'utf8');

    hookManager.add('UserPromptSubmit', {
      command: 'bash greet.sh'
    }, settingsPath);

    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(data.permissions, { allow: ['Read'] });
    assert.equal(data.hooks.UserPromptSubmit.length, 1);
  });

  it('detects duplicate command in same hook type', () => {
    hookManager.add('PreToolUse', {
      command: 'bash enforce.sh',
      matcher: ['Edit']
    }, settingsPath);

    const result = hookManager.add('PreToolUse', {
      command: 'bash enforce.sh',
      matcher: ['Write']
    }, settingsPath);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('duplicate'));
  });

  it('adds to empty hooks object', () => {
    const dir = path.dirname(settingsPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }), 'utf8');

    const result = hookManager.add('Stop', {
      command: 'bash cleanup.sh'
    }, settingsPath);
    assert.equal(result.ok, true);

    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(data.hooks.Stop.length, 1);
  });

  it('adds hooks key to existing settings without hooks', () => {
    const dir = path.dirname(settingsPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['Bash'] }
    }), 'utf8');

    const result = hookManager.add('Notification', {
      command: 'bash notify.sh'
    }, settingsPath);
    assert.equal(result.ok, true);

    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(data.hooks);
    assert.equal(data.hooks.Notification.length, 1);
  });

  it('rejects invalid hook type via validation', () => {
    const result = hookManager.add('FakeHook', {
      command: 'bash foo.sh'
    }, settingsPath);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('Unknown hook type'));
    assert.equal(fs.existsSync(settingsPath), false);
  });
});

// ── list ────────────────────────────────────────────────────────────
describe('list', () => {
  let tmpDir;
  let settingsPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-mgr-test-'));
    settingsPath = path.join(tmpDir, '.claude', 'settings.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists all hook entries grouped by type', () => {
    const fixture = path.resolve(__dirname, 'fixtures', 'sample-settings.json');
    const dir = path.dirname(settingsPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(fixture, settingsPath);

    const result = hookManager.list(settingsPath);
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('UserPromptSubmit'));
    assert.ok(result.output.includes('PreToolUse'));
    assert.ok(result.output.includes('activate.sh'));
    assert.ok(result.output.includes('enforce.sh'));
    assert.ok(result.output.includes('matcher'));
  });

  it('returns empty message when no hooks', () => {
    const dir = path.dirname(settingsPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ permissions: {} }), 'utf8');

    const result = hookManager.list(settingsPath);
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('No hooks'));
  });

  it('returns empty message when file does not exist', () => {
    const result = hookManager.list(settingsPath);
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('No hooks'));
  });
});

// ── remove ──────────────────────────────────────────────────────────
describe('remove', () => {
  let tmpDir;
  let settingsPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-mgr-test-'));
    settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    // Seed from fixture
    const fixture = path.resolve(__dirname, 'fixtures', 'sample-settings.json');
    const dir = path.dirname(settingsPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(fixture, settingsPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes hook entry by command match', () => {
    const cmd = 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/skill-engine/enforce.sh"';
    const result = hookManager.remove('PreToolUse', cmd, settingsPath);
    assert.equal(result.ok, true);

    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(data.hooks.PreToolUse.length, 0);
  });

  it('errors when command not found', () => {
    const result = hookManager.remove('PreToolUse', 'bash nonexistent.sh', settingsPath);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('not found'));
  });

  it('errors when hook type has no entries', () => {
    const result = hookManager.remove('Stop', 'bash foo.sh', settingsPath);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('No hooks found'));
  });
});
