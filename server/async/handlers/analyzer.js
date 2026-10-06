'use strict';

const fs = require('fs');
const path = require('path');

const analyzerCache = new Map();

// Latest mtime across the analyzers directory, so an edit to a shared helper
// such as _lib.js reloads every analyzer that requires it.
function directoryStamp(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return -1;
  }
  let stamp = 0;
  for (const name of names) {
    if (!name.endsWith('.js')) continue;
    try {
      stamp = Math.max(stamp, fs.statSync(path.join(dir, name)).mtimeMs);
    } catch {}
  }
  return stamp;
}

function purgeRequireCache(dir) {
  const prefix = path.resolve(dir) + path.sep;
  for (const id of Object.keys(require.cache)) {
    if (id.startsWith(prefix)) delete require.cache[id];
  }
}

function loadAnalyzer(projectRoot, analyzerName) {
  if (!analyzerName || /[/\\]|\.\./.test(analyzerName)) return null;

  const dir = path.join(projectRoot, '.claude', 'skills', 'analyzers');
  const key = projectRoot + '|' + analyzerName;
  const stamp = directoryStamp(dir);
  const cached = analyzerCache.get(key);
  if (cached && cached.stamp === stamp) return cached.analyze;

  purgeRequireCache(dir);
  let analyze = null;
  try {
    const mod = require(path.join(dir, analyzerName + '.js'));
    if (typeof mod.analyze === 'function') analyze = mod.analyze;
  } catch {}
  analyzerCache.set(key, { stamp, analyze });
  return analyze;
}

module.exports = {
  name: 'analyzer',

  validate(config) {
    return [];
  },

  async execute(job) {
    const { name, config, context } = job;
    const projectRoot = context && context.projectRoot;
    if (!projectRoot) return [];

    const analyzeFn = loadAnalyzer(projectRoot, name);
    if (!analyzeFn) return [];

    const result = await Promise.resolve(analyzeFn(context, config || {}));
    return Array.isArray(result) ? result : [];
  },
};
