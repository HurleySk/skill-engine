'use strict';

const fs = require('fs');
const path = require('path');
const libDir = path.resolve(__dirname, '..', 'hooks', 'lib');
const { relativePath } = require(path.join(libDir, 'glob-match'));

const IS_WIN = process.platform === 'win32';
const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const ENFORCEMENT_ORDER = { block: 0, ask: 1, warn: 2 };
const ENFORCING = new Set(['block', 'ask', 'warn']);

function getPriority(rule, defaults) {
  return rule.priority || (defaults && defaults.priority) || 'medium';
}

function getEnforcement(rule, defaults) {
  const raw = rule.enforcement || (defaults && defaults.enforcement) || 'suggest';
  return raw === 'approve' ? 'ask' : raw;
}

function ruleMatchesProject(entry, projectRoot) {
  if (!entry.sourceRepo || !projectRoot) return true;
  if (IS_WIN) return entry.sourceRepo.toLowerCase() === projectRoot.toLowerCase();
  return entry.sourceRepo === projectRoot;
}

function checkSkip(ruleName, rule, session) {
  const skip = rule.skipConditions;
  if (!skip) return false;
  if (skip.envVars && skip.envVars.length && skip.envVars.some(v => process.env[v])) return true;
  if (skip.sessionOnce && session && session.firedRules.has(ruleName)) return true;
  if (skip.requiresContext && skip.requiresContext.length) {
    const ctxSet = session && session.contexts;
    if (!ctxSet || !skip.requiresContext.some(tag => ctxSet.has(tag))) return true;
  }
  return false;
}

function hasPromptTrigger(entry) {
  return !!(entry.keywordsLower || entry.intentRe || entry.boostRe);
}

function matchPrompt(prompt, entry) {
  const lower = prompt.toLowerCase();
  let score = 0;
  if (entry.keywordsLower && entry.keywordsLower.some(kw => lower.includes(kw))) score = 1.0;
  else if (entry.intentRe && entry.intentRe.some(re => re.test(prompt))) score = 1.0;
  if (entry.boostRe && entry.boostRe.length) {
    const hits = entry.boostRe.filter(re => re.test(prompt)).length;
    score += Math.min(hits * entry.boostWeight, 1.0);
  }
  return score >= 1.0;
}

function matchFilePath(filePath, entry, projectRoot) {
  if (!entry.pathRe || !entry.pathRe.length) return false;
  const rel = relativePath(filePath, projectRoot);
  if (entry.exclRe && entry.exclRe.some(re => re.test(rel))) return false;
  return entry.pathRe.some(re => re.test(rel));
}

function matchFileContent(entry, readContent) {
  const hasContentRe = entry.contentRe && entry.contentRe.length;
  const hasContentExcl = entry.contentExclRe && entry.contentExclRe.length;
  if (!hasContentRe && !hasContentExcl) return true;
  const content = readContent();
  if (content === null) return false;
  if (hasContentRe && !entry.contentRe.some(re => re.test(content))) return false;
  if (hasContentExcl && entry.contentExclRe.some(re => re.test(content))) return false;
  return true;
}

function readFileOrNull(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

function matchFile(filePath, entry, projectRoot) {
  return matchFilePath(filePath, entry, projectRoot) && matchFileContent(entry, () => readFileOrNull(filePath));
}

function matchNamedTrigger(names, patterns, toolName, text) {
  if (!names && (!patterns || !patterns.length)) return false;
  if (names && (!toolName || !names.has(toolName))) return false;
  if (patterns && patterns.length && !patterns.some(re => re.test(text))) return false;
  return true;
}

function matchToolTrigger(entry, toolName, inputStr) {
  return matchNamedTrigger(entry.toolTriggerNamesSet, entry.inputRe, toolName, inputStr);
}

function matchOutputTrigger(entry, toolName, outputStr) {
  return matchNamedTrigger(entry.outputToolNamesSet, entry.outputRe, toolName, outputStr);
}

function relevantRules(index, wildcards, toolName) {
  return toolName ? (index.get(toolName) || []).concat(wildcards) : wildcards;
}

function collectMatches(compiledRules, projectRoot, session, rulesData, filterFn) {
  const matches = [];
  for (const entry of compiledRules) {
    if (!ruleMatchesProject(entry, projectRoot)) continue;
    if (checkSkip(entry.name, entry.rule, session)) continue;
    const result = filterFn(entry, rulesData);
    if (!result) continue;
    matches.push({
      name: entry.name,
      rule: entry.rule,
      priority: result.priority || getPriority(entry.rule, rulesData.defaults),
      enforcement: result.enforcement || getEnforcement(entry.rule, rulesData.defaults),
    });
  }
  return matches;
}

function enforcingGuardrail(entry, defaults) {
  if (entry.rule.type !== 'guardrail' || entry.isAsync) return null;
  const enforcement = getEnforcement(entry.rule, defaults);
  return ENFORCING.has(enforcement) ? enforcement : null;
}

function sortByPriority(matches) {
  matches.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));
}

function sortBlockFirst(matches) {
  matches.sort((a, b) => {
    const d = (ENFORCEMENT_ORDER[a.enforcement] ?? 2) - (ENFORCEMENT_ORDER[b.enforcement] ?? 2);
    return d || (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2);
  });
}

function recordSessionOnce(session, matches) {
  if (!session) return;
  for (const m of matches) {
    if (m.rule.skipConditions && m.rule.skipConditions.sessionOnce) session.firedRules.add(m.name);
  }
}

function ruleMessage(name, rule, enforcement) {
  if (enforcement === 'block') return rule.blockMessage || ('Blocked by rule: ' + name);
  if (enforcement === 'ask') return rule.askMessage || rule.blockMessage || ('Requires approval: ' + name);
  return rule.description || ('Warning from rule: ' + name);
}

module.exports = {
  getPriority, getEnforcement, ruleMatchesProject, checkSkip,
  hasPromptTrigger, matchPrompt, matchFilePath, matchFileContent, matchFile,
  matchToolTrigger, matchOutputTrigger, relevantRules,
  collectMatches, enforcingGuardrail, sortByPriority, sortBlockFirst, recordSessionOnce, ruleMessage,
};
