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

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function globToRegex(glob) {
  const normalized = glob.replace(/\\/g, '/');
  let result = '';
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === '*' && normalized[i + 1] === '*') {
      // ** glob — look at surrounding slashes
      if (normalized[i + 2] === '/') {
        // **/ at start or after separator: zero or more path segments
        result += '(?:.*/)?';
        i += 3;
      } else if (i > 0 && normalized[i - 1] === '/') {
        // /** at end
        result += '(?:.*)?';
        i += 2;
      } else {
        result += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      result += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      result += '[^/]';
      i += 1;
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      result += '\\' + ch;
      i += 1;
    } else {
      result += ch;
      i += 1;
    }
  }
  return new RegExp('^' + result + '$');
}

function matchPath(filePath, pathPatterns, pathExclusions) {
  const normalized = normalizePath(filePath);
  if (pathExclusions && pathExclusions.length) {
    if (pathExclusions.some(pat => globToRegex(pat).test(normalized))) return false;
  }
  if (!pathPatterns || !pathPatterns.length) return false;
  return pathPatterns.some(pat => globToRegex(pat).test(normalized));
}

function matchContent(filePath, contentPatterns) {
  if (!contentPatterns || !contentPatterns.length) return false;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return contentPatterns.some(pat => new RegExp(pat).test(content));
  } catch {
    return false;
  }
}

function matchFileTriggers(filePath, rule) {
  const triggers = rule.triggers?.file;
  if (!triggers) return false;
  if (!matchPath(filePath, triggers.pathPatterns, triggers.pathExclusions)) return false;
  if (rule.enforcement === 'block' && triggers.contentPatterns && triggers.contentPatterns.length) {
    return matchContent(filePath, triggers.contentPatterns);
  }
  return true;
}

module.exports = {
  findRulesFile,
  loadRules,
  matchKeywords,
  matchIntent,
  matchPromptTriggers,
  normalizePath,
  matchPath,
  matchContent,
  matchFileTriggers,
};
