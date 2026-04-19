'use strict';

const fs = require('fs');
const path = require('path');

function findRulesFile(startDir) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, '.claude', 'skills', 'skill-rules.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir || dir === root) return null;
    dir = parent;
  }
}

function loadRules(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data.rules || data.version !== '1.0') return null;
    return data;
  } catch {
    return null;
  }
}

function matchKeywords(prompt, keywords) {
  if (!keywords || !keywords.length) return false;
  const lower = prompt.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

function matchIntent(prompt, patterns) {
  if (!patterns || !patterns.length) return false;
  return patterns.some(pat => new RegExp(pat, 'i').test(prompt));
}

function matchPromptTriggers(prompt, rule) {
  const triggers = rule.triggers?.prompt;
  if (!triggers) return false;
  return matchKeywords(prompt, triggers.keywords) || matchIntent(prompt, triggers.intentPatterns);
}

module.exports = { findRulesFile, loadRules, matchKeywords, matchIntent, matchPromptTriggers };
