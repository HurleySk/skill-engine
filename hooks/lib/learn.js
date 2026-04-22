'use strict';

const fs = require('fs');
const path = require('path');
const { normalizePath, loadRules } = require('./engine.js');

const REQUIRED_FIELDS = ['type', 'description', 'triggers'];

function validateRule(rule) {
  for (const field of REQUIRED_FIELDS) {
    if (!rule[field]) return { ok: false, error: `Missing required field: ${field}` };
  }
  if (rule.type !== 'domain' && rule.type !== 'guardrail') {
    return { ok: false, error: `Invalid type: ${rule.type}. Must be "domain" or "guardrail"` };
  }
  return { ok: true };
}

function normalizeTriggerPaths(rule) {
  const file = rule.triggers && rule.triggers.file;
  if (!file) return rule;
  const copy = JSON.parse(JSON.stringify(rule));
  if (copy.triggers.file.pathPatterns) {
    copy.triggers.file.pathPatterns = copy.triggers.file.pathPatterns.map(p => normalizePath(p));
  }
  if (copy.triggers.file.pathExclusions) {
    copy.triggers.file.pathExclusions = copy.triggers.file.pathExclusions.map(p => normalizePath(p));
  }
  return copy;
}

// Reuse engine's loadRules — same schema for both files
const loadLearnedFile = loadRules;

function add(ruleName, rule, filePath) {
  if (!ruleName || typeof ruleName !== 'string' || !ruleName.trim()) {
    return { ok: false, error: 'Rule name must be a non-empty string.' };
  }
  const validation = validateRule(rule);
  if (!validation.ok) return validation;

  const normalized = normalizeTriggerPaths(rule);
  const data = loadLearnedFile(filePath) || { version: '1.0', rules: {} };

  if (data.rules[ruleName]) {
    return { ok: false, error: `Rule "${ruleName}" already exists. Remove it first.` };
  }

  if (!normalized.enforcement) normalized.enforcement = 'warn';
  data.rules[ruleName] = normalized;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true };
}

function list(filePath) {
  const data = loadLearnedFile(filePath);
  if (!data || !Object.keys(data.rules).length) {
    return { ok: true, output: 'No learned rules yet.' };
  }

  const lines = ['Learned rules:', ''];
  for (const [name, rule] of Object.entries(data.rules)) {
    const enforcement = rule.enforcement || 'warn';
    const priority = rule.priority || 'medium';
    lines.push(`  ${name}`);
    lines.push(`    Type: ${rule.type} | Enforcement: ${enforcement} | Priority: ${priority}`);
    lines.push(`    ${rule.description}`);
    const file = rule.triggers && rule.triggers.file;
    if (file && file.pathPatterns) {
      lines.push(`    Files: ${file.pathPatterns.join(', ')}`);
    }
    const prompt = rule.triggers && rule.triggers.prompt;
    if (prompt && prompt.keywords) {
      lines.push(`    Keywords: ${prompt.keywords.join(', ')}`);
    }
    lines.push('');
  }
  return { ok: true, output: lines.join('\n') };
}

function remove(ruleName, filePath) {
  const data = loadLearnedFile(filePath);
  if (!data || !data.rules[ruleName]) {
    return { ok: false, error: `Rule "${ruleName}" not found.` };
  }

  delete data.rules[ruleName];
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true };
}

function update(ruleName, updates, filePath) {
  const data = loadLearnedFile(filePath);
  if (!data || !data.rules[ruleName]) {
    return { ok: false, error: `Rule "${ruleName}" not found.` };
  }

  const rule = data.rules[ruleName];

  // Merge triggers specially — append arrays, don't replace
  if (updates.triggers) {
    if (!rule.triggers) rule.triggers = {};
    for (const [triggerType, triggerUpdates] of Object.entries(updates.triggers)) {
      if (!rule.triggers[triggerType]) {
        rule.triggers[triggerType] = triggerUpdates;
      } else {
        for (const [key, value] of Object.entries(triggerUpdates)) {
          if (Array.isArray(value) && Array.isArray(rule.triggers[triggerType][key])) {
            const merged = [...rule.triggers[triggerType][key], ...value];
            rule.triggers[triggerType][key] = [...new Set(merged)];
          } else {
            rule.triggers[triggerType][key] = value;
          }
        }
      }
    }
  }

  // Merge top-level fields (skip triggers — already handled)
  for (const [key, value] of Object.entries(updates)) {
    if (key !== 'triggers') {
      rule[key] = value;
    }
  }

  // Normalize paths after merge
  data.rules[ruleName] = normalizeTriggerPaths(rule);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true };
}

module.exports = { validateRule, normalizeTriggerPaths, loadLearnedFile, add, list, remove, update };

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  // Parse --file flag
  const fileIdx = args.indexOf('--file');
  let filePath;
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    filePath = args[fileIdx + 1];
  } else {
    // Default: find .claude/skills/ from cwd using engine's findRulesFile
    const { findRulesFile } = require('./engine.js');
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const rulesFile = findRulesFile(cwd);
    if (rulesFile) {
      filePath = path.join(path.dirname(rulesFile), 'learned-rules.json');
    } else {
      filePath = path.join(cwd, '.claude', 'skills', 'learned-rules.json');
    }
  }

  if (command === 'add') {
    const ruleName = args[1];
    let ruleJson;
    try {
      ruleJson = JSON.parse(args[2]);
    } catch {
      process.stderr.write('Error: Invalid JSON for rule.\n');
      process.exit(1);
    }
    const result = add(ruleName, ruleJson, filePath);
    if (result.ok) {
      process.stdout.write(`Rule "${ruleName}" saved to ${filePath}\n`);
    } else {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(1);
    }
  } else if (command === 'list') {
    const result = list(filePath);
    process.stdout.write(result.output + '\n');
  } else if (command === 'remove') {
    const ruleName = args[1];
    const result = remove(ruleName, filePath);
    if (result.ok) {
      process.stdout.write(`Rule "${ruleName}" removed from ${filePath}\n`);
    } else {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(1);
    }
  } else {
    process.stderr.write('Usage: node learn.js <add|list|remove> [args] [--file path]\n');
    process.exit(1);
  }
}
