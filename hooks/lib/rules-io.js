'use strict';

const fs = require('fs');
const path = require('path');
const { normalizePath } = require('./glob-match');

function findFileInAncestors(startDir, filename) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, '.claude', 'skills', filename);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir || dir === root) return null;
    dir = parent;
  }
}

function findRulesFile(startDir) {
  return findFileInAncestors(startDir, 'skill-rules.json');
}

function findLearnedRulesFile(startDir) {
  return findFileInAncestors(startDir, 'learned-rules.json');
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

module.exports = { findRulesFile, findLearnedRulesFile, loadRules, normalizePath };
