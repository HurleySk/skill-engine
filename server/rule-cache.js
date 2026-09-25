'use strict';

const fs = require('fs');
const path = require('path');
const libDir = path.resolve(__dirname, '..', 'hooks', 'lib');
const { loadRules } = require(path.join(libDir, 'rules-io'));
const { compileRules } = require('./compile');

const MAX_CACHE_ENTRIES = 10;

function emptyRulesData() {
  return { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {} };
}

const EMPTY_SNAPSHOT = Object.freeze({
  compiledRules: [],
  compilationWarnings: [],
  rulesData: emptyRulesData(),
  hasToolTriggerRules: false,
  hasOutputTriggerRules: false,
  hasStopRules: false,
  hasAsyncRules: false,
  outputTriggerIndex: new Map(),
  toolTriggerIndex: new Map(),
  outputWildcardRules: [],
  toolWildcardRules: [],
});

function mtimeOf(filePath) {
  try { return fs.statSync(filePath).mtimeMs; } catch { return null; }
}

function mergeRulesData(mainData, learnedData) {
  if (!mainData && !learnedData) return emptyRulesData();
  if (!mainData) return { ...emptyRulesData(), rules: learnedData.rules };
  if (!learnedData) return { ...mainData };
  return { ...mainData, rules: { ...learnedData.rules, ...mainData.rules } };
}

function buildSnapshot(rulesData) {
  const c = compileRules(rulesData);
  return Object.freeze({
    compiledRules: c.compiled,
    compilationWarnings: c.compilationWarnings,
    rulesData,
    hasToolTriggerRules: c.compiled.some(e => e.toolTriggerNamesSet || (e.inputRe && e.inputRe.length)),
    hasOutputTriggerRules: c.compiled.some(e => e.outputToolNamesSet || (e.outputRe && e.outputRe.length)),
    hasStopRules: c.compiled.some(e => e.hookEventsSet && e.hookEventsSet.has('Stop')),
    hasAsyncRules: c.compiled.some(e => e.isAsync),
    outputTriggerIndex: c.outputTriggerIndex,
    toolTriggerIndex: c.toolTriggerIndex,
    outputWildcardRules: c.outputWildcardRules,
    toolWildcardRules: c.toolWildcardRules,
  });
}

class RuleCache {
  constructor() {
    this._entries = new Map();
  }

  getCachedState() {
    return { entries: this._entries.size, maxEntries: MAX_CACHE_ENTRIES };
  }

  invalidate(rulesDir) {
    if (rulesDir) this._entries.delete(rulesDir);
  }

  getRules(rulesDir) {
    if (!rulesDir) return EMPTY_SNAPSHOT;
    const mainFile = path.join(rulesDir, 'skill-rules.json');
    const learnedFile = path.join(rulesDir, 'learned-rules.json');
    const mainMtime = mtimeOf(mainFile);
    const learnedMtime = mtimeOf(learnedFile);

    const existing = this._entries.get(rulesDir);
    if (existing && mainMtime === existing.mainMtime && learnedMtime === existing.learnedMtime) {
      existing.lastAccess = Date.now();
      return existing.snapshot;
    }

    const snapshot = buildSnapshot(mergeRulesData(loadRules(mainFile), loadRules(learnedFile)));

    if (!existing && this._entries.size >= MAX_CACHE_ENTRIES) this._evictOldest();
    this._entries.set(rulesDir, { mainMtime, learnedMtime, lastAccess: Date.now(), snapshot });
    return snapshot;
  }

  _evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this._entries) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey) this._entries.delete(oldestKey);
  }
}

module.exports = { RuleCache, ruleCache: new RuleCache(), EMPTY_SNAPSHOT };
