'use strict';

const fs = require('fs');
const path = require('path');
const { normalizePath } = require('./engine.js');

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

function loadLearnedFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data.version !== '1.0' || !data.rules) return null;
    return data;
  } catch {
    return null;
  }
}

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

module.exports = { validateRule, normalizeTriggerPaths, loadLearnedFile, add, list, remove };
