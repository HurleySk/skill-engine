'use strict';

const path = require('path');
const libDir = path.resolve(__dirname, '..', 'hooks', 'lib');
const { normalizePath, globToRegex } = require(path.join(libDir, 'glob-match'));
const asyncEngine = require('./async/engine');

function indexByTool(compiled, namesKey, patternsKey) {
  const index = new Map();
  const wildcards = [];
  for (const entry of compiled) {
    if (entry[namesKey]) {
      for (const name of entry[namesKey]) {
        if (!index.has(name)) index.set(name, []);
        index.get(name).push(entry);
      }
    } else if (entry[patternsKey] && entry[patternsKey].length) {
      wildcards.push(entry);
    }
  }
  return { index, wildcards };
}

function compileRules(data) {
  if (!data || !data.rules) return { compiled: [], compilationWarnings: [] };
  const compiled = [];
  const compilationWarnings = [];

  function compilePatternArray(entry, ruleName, field, key, patterns, flags) {
    const result = [];
    for (const pat of patterns || []) {
      try {
        result.push(new RegExp(pat, flags));
      } catch (err) {
        compilationWarnings.push({ ruleName, field, pattern: pat, error: err.message });
      }
    }
    entry._compiledPatterns[key] = { total: (patterns || []).length, compiled: result.length };
    return result;
  }

  function nameSet(names) {
    return Array.isArray(names) && names.length ? new Set(names) : undefined;
  }

  for (const [name, rule] of Object.entries(data.rules)) {
    const entry = { name, rule, _compiledPatterns: {} };
    if (rule.sourceRepo) entry.sourceRepo = normalizePath(rule.sourceRepo);
    const triggers = rule.triggers || {};

    const pt = triggers.prompt;
    if (pt) {
      entry.keywordsLower = (pt.keywords || []).map(k => k.toLowerCase());
      entry.intentRe = compilePatternArray(entry, name, 'triggers.prompt.intentPatterns', 'intentPatterns', pt.intentPatterns, 'i');
    }
    const ft = triggers.file;
    if (ft) {
      entry.pathRe = (ft.pathPatterns || []).map(p => globToRegex(p));
      entry.exclRe = (ft.pathExclusions || []).map(p => globToRegex(p));
      entry.contentRe = compilePatternArray(entry, name, 'triggers.file.contentPatterns', 'contentPatterns', ft.contentPatterns, undefined);
      entry.contentExclRe = compilePatternArray(entry, name, 'triggers.file.contentExclusions', 'contentExclusions', ft.contentExclusions, undefined);
      const names = nameSet(ft.toolNames);
      if (names) entry.toolNamesSet = names;
    }
    const tt = triggers.tool;
    if (tt) {
      const names = nameSet(tt.toolNames);
      if (names) entry.toolTriggerNamesSet = names;
      entry.inputRe = compilePatternArray(entry, name, 'triggers.tool.inputPatterns', 'inputPatterns', tt.inputPatterns, 'i');
    }
    const ot = triggers.output;
    if (ot) {
      const names = nameSet(ot.toolNames);
      if (names) entry.outputToolNamesSet = names;
      entry.outputRe = compilePatternArray(entry, name, 'triggers.output.outputPatterns', 'outputPatterns', ot.outputPatterns, 'i');
    }
    if (Array.isArray(rule.hookEvents)) entry.hookEventsSet = new Set(rule.hookEvents);
    if (rule.contextBoost) {
      entry.boostWeight = rule.contextBoost.weight || 0.3;
      entry.boostRe = compilePatternArray(entry, name, 'contextBoost.patterns', 'boostPatterns', rule.contextBoost.patterns, 'i');
    }
    if (rule.async) {
      const normalized = asyncEngine.registry.normalizeAsyncBlock(rule.async);
      if (rule.async.analyzer && !rule.async.handler) {
        compilationWarnings.push(name + ': deprecated async format — use { handler: "analyzer", name: "' + rule.async.analyzer + '" }');
      }
      const errors = asyncEngine.registry.validateAsyncBlock(normalized);
      if (errors.length) {
        compilationWarnings.push(name + ': async config errors: ' + errors.join(', '));
      } else {
        entry.isAsync = true;
        entry.asyncHandler = normalized.handler;
        entry.asyncHandlerName = normalized.name;
        entry.asyncConfig = normalized.config || {};
      }
    }
    compiled.push(entry);
  }

  const output = indexByTool(compiled, 'outputToolNamesSet', 'outputRe');
  const tool = indexByTool(compiled, 'toolTriggerNamesSet', 'inputRe');

  return {
    compiled,
    compilationWarnings,
    outputTriggerIndex: output.index,
    outputWildcardRules: output.wildcards,
    toolTriggerIndex: tool.index,
    toolWildcardRules: tool.wildcards,
  };
}

module.exports = { compileRules };
