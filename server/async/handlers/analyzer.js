'use strict';

const path = require('path');

const analyzerCache = new Map();

function loadAnalyzer(projectRoot, analyzerName) {
  const key = projectRoot + '|' + analyzerName;
  if (analyzerCache.has(key)) return analyzerCache.get(key);

  if (!analyzerName || /[/\\]|\.\./.test(analyzerName)) {
    analyzerCache.set(key, null);
    return null;
  }

  const analyzerPath = path.join(projectRoot, '.claude', 'skills', 'analyzers', analyzerName + '.js');
  try {
    const mod = require(analyzerPath);
    if (typeof mod.analyze !== 'function') {
      analyzerCache.set(key, null);
      return null;
    }
    analyzerCache.set(key, mod.analyze);
    return mod.analyze;
  } catch {
    analyzerCache.set(key, null);
    return null;
  }
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
