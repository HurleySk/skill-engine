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

function getSessionStatePath(sessionId) {
  const tmpDir = process.env.TEMP || process.env.TMPDIR || require('os').tmpdir();
  return path.join(tmpDir, 'skill-engine-' + sessionId + '.json');
}

function readSessionState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(getSessionStatePath(sessionId), 'utf8'));
  } catch {
    return { firedRules: [] };
  }
}

function writeSessionState(sessionId, state) {
  fs.writeFileSync(getSessionStatePath(sessionId), JSON.stringify(state), 'utf8');
}

function checkSkip(ruleName, rule, sessionId, filePath) {
  const skip = rule.skipConditions;
  if (!skip) return false;

  if (skip.envVars && skip.envVars.length) {
    if (skip.envVars.some(v => process.env[v])) return true;
  }

  if (filePath && skip.fileMarkers && skip.fileMarkers.length) {
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').slice(0, 5).join('\n');
      if (skip.fileMarkers.some(marker => lines.includes(marker))) return true;
    } catch {}
  }

  if (skip.sessionOnce && sessionId) {
    const state = readSessionState(sessionId);
    if (state.firedRules.includes(ruleName)) return true;
  }

  return false;
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
  getSessionStatePath,
  readSessionState,
  writeSessionState,
  checkSkip,
};
