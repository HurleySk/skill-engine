'use strict';

// Shared glob-matching utilities.
// Used by skill-engine engine.js and available to consumer project hooks.

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function globToRegex(glob, opts) {
  const caseInsensitive = opts && opts.caseInsensitive;
  const normalized = glob.replace(/\\/g, '/');
  let result = '';
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        result += '(?:.*/)?';
        i += 3;
      } else if (i > 0 && normalized[i - 1] === '/') {
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
  return new RegExp('^' + result + '$', caseInsensitive ? 'i' : '');
}

function matchPath(filePath, pathPatterns, pathExclusions, opts) {
  const normalized = normalizePath(filePath);
  if (pathExclusions && pathExclusions.length) {
    if (pathExclusions.some(pat => globToRegex(pat, opts).test(normalized))) return false;
  }
  if (!pathPatterns || !pathPatterns.length) return false;
  return pathPatterns.some(pat => globToRegex(pat, opts).test(normalized));
}

function globMatch(pattern, filePath) {
  const p = normalizePath(pattern);
  const f = normalizePath(filePath);
  return globToRegex(p, { caseInsensitive: true }).test(f);
}

module.exports = { normalizePath, globToRegex, matchPath, globMatch };
