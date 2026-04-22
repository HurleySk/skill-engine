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
  // matcher can be a string ("Edit|Write") or array (["Edit", "Write"]) — normalized to string on save
  if (entry.matcher !== undefined && typeof entry.matcher !== 'string' && !Array.isArray(entry.matcher)) {
    return { ok: false, error: 'Hook matcher must be a string (pipe-separated) or array of strings.' };
  }
  if (Array.isArray(entry.matcher) && !entry.matcher.every(m => typeof m === 'string')) {
    return { ok: false, error: 'Hook matcher array entries must be strings.' };
  }
  return { ok: true };
}

// Normalize matcher to pipe-separated string (Claude Code format)
function normalizeMatcher(matcher) {
  if (!matcher) return undefined;
  if (typeof matcher === 'string') return matcher;
  if (Array.isArray(matcher)) return matcher.join('|');
  return String(matcher);
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

  // Claude Code hook format: { matcher: "Edit|Write", hooks: [{ type: "command", command: "..." }] }
  const matcherStr = normalizeMatcher(entry.matcher);

  // Check for duplicate: same command in any entry with the same matcher
  const isDuplicate = settings.hooks[hookType].some(group => {
    const groupMatcher = group.matcher || '';
    const targetMatcher = matcherStr || '';
    if (groupMatcher !== targetMatcher) return false;
    return Array.isArray(group.hooks) && group.hooks.some(h => h.command === entry.command);
  });
  if (isDuplicate) {
    return { ok: false, error: `A hook with this command already exists in ${hookType} (duplicate).` };
  }

  // Try to append to an existing group with the same matcher
  const existingGroup = settings.hooks[hookType].find(group => {
    const groupMatcher = group.matcher || '';
    const targetMatcher = matcherStr || '';
    return groupMatcher === targetMatcher;
  });

  const hookEntry = { type: 'command', command: entry.command };

  if (existingGroup && Array.isArray(existingGroup.hooks)) {
    existingGroup.hooks.push(hookEntry);
  } else {
    // Create new group
    const newGroup = { hooks: [hookEntry] };
    if (matcherStr) newGroup.matcher = matcherStr;
    settings.hooks[hookType].push(newGroup);
  }

  saveSettings(settingsPath, settings);
  return { ok: true };
}

function list(settingsPath) {
  const settings = loadSettings(settingsPath);
  if (!settings || !settings.hooks || !Object.keys(settings.hooks).length) {
    return { ok: true, output: 'No hooks configured.' };
  }

  const lines = ['Hooks:', ''];
  for (const [hookType, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups) || !groups.length) continue;
    lines.push(`  ${hookType}:`);
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      const matcher = group.matcher || '(all tools)';
      lines.push(`    [${g}] matcher: ${matcher}`);
      if (Array.isArray(group.hooks)) {
        for (const h of group.hooks) {
          lines.push(`        → ${h.command}`);
        }
      } else if (group.command) {
        // Legacy flat format
        lines.push(`        → ${group.command} (legacy format)`);
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

  // Search all groups for the command
  for (let g = 0; g < settings.hooks[hookType].length; g++) {
    const group = settings.hooks[hookType][g];
    if (Array.isArray(group.hooks)) {
      const idx = group.hooks.findIndex(h => h.command === command);
      if (idx !== -1) {
        group.hooks.splice(idx, 1);
        // Remove empty group
        if (group.hooks.length === 0) {
          settings.hooks[hookType].splice(g, 1);
        }
        saveSettings(settingsPath, settings);
        return { ok: true };
      }
    }
    // Legacy flat format
    if (group.command === command) {
      settings.hooks[hookType].splice(g, 1);
      saveSettings(settingsPath, settings);
      return { ok: true };
    }
  }

  return { ok: false, error: `Hook with command "${command}" not found in ${hookType}.` };
}

module.exports = { validate, normalizeMatcher, add, list, remove, KNOWN_HOOK_TYPES };

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
