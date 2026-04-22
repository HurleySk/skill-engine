'use strict';

const fs = require('fs');
const path = require('path');

const KNOWN_HOOK_TYPES = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop'
];

function validate(hookType, entry) {
  if (!KNOWN_HOOK_TYPES.includes(hookType)) {
    return { ok: false, error: `Unknown hook type: "${hookType}". Known types: ${KNOWN_HOOK_TYPES.join(', ')}` };
  }
  if (!entry || typeof entry.command !== 'string' || !entry.command.trim()) {
    return { ok: false, error: 'Hook entry must have a non-empty command string.' };
  }
  if (entry.matcher !== undefined && !Array.isArray(entry.matcher)) {
    return { ok: false, error: 'Hook matcher must be an array of strings.' };
  }
  if (entry.matcher && !entry.matcher.every(m => typeof m === 'string')) {
    return { ok: false, error: 'Hook matcher must be an array of strings.' };
  }
  return { ok: true };
}

function loadSettings(settingsPath) {
  if (!settingsPath || !fs.existsSync(settingsPath)) return null;
  const raw = fs.readFileSync(settingsPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return { _parseError: true };
  }
}

function saveSettings(settingsPath, data) {
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf8');
}

function add(hookType, entry, settingsPath) {
  const validation = validate(hookType, entry);
  if (!validation.ok) return validation;

  const settings = loadSettings(settingsPath) || {};
  if (settings._parseError) {
    return { ok: false, error: 'settings.json exists but contains invalid JSON. Fix it manually or delete it to start fresh.' };
  }
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks[hookType]) settings.hooks[hookType] = [];

  const isDuplicate = settings.hooks[hookType].some(h => h.command === entry.command);
  if (isDuplicate) {
    return { ok: false, error: `A hook with this command already exists in ${hookType} (duplicate).` };
  }

  const clean = { command: entry.command };
  if (entry.matcher) clean.matcher = entry.matcher;

  settings.hooks[hookType].push(clean);
  saveSettings(settingsPath, settings);
  return { ok: true };
}

function list(settingsPath) {
  const settings = loadSettings(settingsPath);
  if (!settings || !settings.hooks || !Object.keys(settings.hooks).length) {
    return { ok: true, output: 'No hooks configured.' };
  }

  const lines = ['Hooks:', ''];
  for (const [hookType, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries) || !entries.length) continue;
    lines.push(`  ${hookType}:`);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      lines.push(`    [${i}] ${e.command}`);
      if (e.matcher) {
        lines.push(`        matcher: ${e.matcher.join(', ')}`);
      }
    }
    lines.push('');
  }
  return { ok: true, output: lines.join('\n') };
}

function remove(hookType, command, settingsPath) {
  const settings = loadSettings(settingsPath);
  if (settings && settings._parseError) {
    return { ok: false, error: 'settings.json exists but contains invalid JSON. Fix it manually or delete it to start fresh.' };
  }
  if (!settings || !settings.hooks || !settings.hooks[hookType] || !settings.hooks[hookType].length) {
    return { ok: false, error: `No hooks found for type "${hookType}".` };
  }

  const idx = settings.hooks[hookType].findIndex(h => h.command === command);
  if (idx === -1) {
    return { ok: false, error: `Hook with command "${command}" not found in ${hookType}.` };
  }

  settings.hooks[hookType].splice(idx, 1);
  saveSettings(settingsPath, settings);
  return { ok: true };
}

module.exports = { validate, add, list, remove, KNOWN_HOOK_TYPES };

// ── CLI entry point ─────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  const fileIdx = args.indexOf('--file');
  let settingsPath;
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    settingsPath = args[fileIdx + 1];
  } else {
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    settingsPath = path.join(cwd, '.claude', 'settings.json');
  }

  if (command === 'add') {
    const hookType = args[1];
    let entry;
    try {
      entry = JSON.parse(args[2]);
    } catch {
      process.stderr.write('Error: Invalid JSON for hook entry.\n');
      process.exit(1);
    }
    const result = add(hookType, entry, settingsPath);
    if (result.ok) {
      process.stdout.write(`Hook added to ${hookType} in ${settingsPath}\n`);
    } else {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(1);
    }
  } else if (command === 'list') {
    const result = list(settingsPath);
    process.stdout.write(result.output + '\n');
  } else if (command === 'remove') {
    const hookType = args[1];
    const cmd = args[2];
    const result = remove(hookType, cmd, settingsPath);
    if (result.ok) {
      process.stdout.write(`Hook removed from ${hookType}\n`);
    } else {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(1);
    }
  } else {
    process.stderr.write('Usage: node hook-manager.js <add|list|remove> [args] [--file path]\n');
    process.exit(1);
  }
}
