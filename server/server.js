'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// --- Shared utilities from rules-io.js / glob-match.js ---
const libDir = path.resolve(__dirname, '..', 'hooks', 'lib');
const { normalizePath, globToRegex } = require(path.join(libDir, 'glob-match'));
const { loadRules } = require(path.join(libDir, 'rules-io'));
const { handlePreWrite: preWriteHandler } = require('./pre-write-safety');
const asyncManager = require('./async-manager');

// --- CLI args (keep --port for tests) ---
const PORT = (() => {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return parseInt(process.env.SKILL_ENGINE_PORT || '19750', 10);
})();

const IS_WIN = process.platform === 'win32';

function ruleMatchesProject(entry, projectRoot) {
  if (!entry.sourceRepo) return true;
  if (!projectRoot) return true;
  if (IS_WIN) return entry.sourceRepo.toLowerCase() === projectRoot.toLowerCase();
  return entry.sourceRepo === projectRoot;
}

// --- Version from plugin.json (read once at startup) ---
const PLUGIN_JSON = path.resolve(__dirname, '..', '.claude-plugin', 'plugin.json');
let SERVER_VERSION = 'unknown';
try {
  SERVER_VERSION = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).version || 'unknown';
} catch {}

// --- Response timing ---
let totalResponseTimeNs = BigInt(0);
let timedResponses = 0;

// --- Priority helpers ---
const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
function getPriority(rule, defaults) {
  return rule.priority || (defaults && defaults.priority) || 'medium';
}
function getEnforcement(rule, defaults) {
  const raw = rule.enforcement || (defaults && defaults.enforcement) || 'suggest';
  return raw === 'approve' ? 'ask' : raw;
}

// --- RuleCache class (multi-key, mtime-based, immutable snapshots) ---
const MAX_CACHE_ENTRIES = 10;

class RuleCache {
  constructor() {
    this._entries = new Map();
  }

  _getMtime(filePath) {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
  }

  getCachedState() {
    return {
      entries: this._entries.size,
      maxEntries: MAX_CACHE_ENTRIES,
    };
  }

  getRules(rulesDir) {
    if (!rulesDir) {
      return {
        compiledRules: [],
        rulesData: { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {} },
        hasToolTriggerRules: false,
        hasOutputTriggerRules: false,
        hasStopRules: false,
        hasAsyncRules: false,
      };
    }
    const mainFile = path.join(rulesDir, 'skill-rules.json');
    const learnedFile = path.join(rulesDir, 'learned-rules.json');
    const mainMtime = this._getMtime(mainFile);
    const learnedMtime = this._getMtime(learnedFile);

    const existing = this._entries.get(rulesDir);
    if (existing && mainMtime === existing.mainMtime && learnedMtime === existing.learnedMtime) {
      existing.lastAccess = Date.now();
      return existing.snapshot;
    }

    // Recompile — also clear checklist cache for this rulesDir
    for (const key of checklistCache.keys()) {
      if (key.startsWith(rulesDir + '|')) checklistCache.delete(key);
    }
    const mainData = loadRules(mainFile);
    const learnedData = loadRules(learnedFile);
    let rulesData;
    if (!mainData && !learnedData) {
      rulesData = { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {} };
    } else if (!mainData) {
      rulesData = { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: learnedData.rules };
    } else {
      rulesData = { ...mainData };
      if (learnedData) {
        rulesData.rules = { ...learnedData.rules, ...mainData.rules };
      }
    }

    const compiled = compileRules(rulesData);
    const hasToolTriggerRules = compiled.some(e => e.toolTriggerNamesSet || (e.inputRe && e.inputRe.length));
    const hasOutputTriggerRules = compiled.some(e => e.outputToolNamesSet || (e.outputRe && e.outputRe.length));
    const hasStopRules = compiled.some(e => e.hookEventsSet && e.hookEventsSet.has('Stop'));
    const hasAsyncRules = compiled.some(e => e.isAsync);

    const snapshot = Object.freeze({
      compiledRules: compiled,
      rulesData,
      hasToolTriggerRules,
      hasOutputTriggerRules,
      hasStopRules,
      hasAsyncRules,
    });

    // LRU eviction
    if (!existing && this._entries.size >= MAX_CACHE_ENTRIES) {
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

    this._entries.set(rulesDir, {
      mainMtime,
      learnedMtime,
      lastAccess: Date.now(),
      snapshot,
    });

    return snapshot;
  }
}

const ruleCache = new RuleCache();

// --- Session Registry (replaces lastProjectDir) ---
const crypto = require('crypto');
const sessionRegistry = new Map();
const sessionContexts = new Map(); // sessionId → Set of context tags
const sessionChecklists = new Map(); // sessionId → Map<itemName, {satisfied, item}>
const checklistCache = new Map(); // rulesDir|context → items array
let lastRegisteredSessionId = null;
let deprecatedSetProjectCalls = 0;

// --- Briefing content map ---
const BRIEFING_FILES = {
  'w3-investigation': ['quick-ref.md', 'known-issues.md'],
  'w3-pipeline-dev': ['quick-ref.md', 'patterns.md'],
  'w3-testing': ['quick-ref.md', 'assertion-ref.md'],
};

function registerSession(sessionId, projectDir) {
  const normalizedDir = normalizePath(projectDir);
  const rulesDir = normalizedDir + '/.claude/skills';
  const errors = [];

  const mainFile = path.join(rulesDir, 'skill-rules.json');
  const learnedFile = path.join(rulesDir, 'learned-rules.json');
  if (!fs.existsSync(mainFile) && !fs.existsSync(learnedFile)) {
    errors.push('No skill-rules.json or learned-rules.json found in ' + rulesDir);
  }

  const cached = ruleCache.getRules(rulesDir);

  sessionRegistry.set(sessionId, {
    projectDir: normalizedDir,
    rulesDir,
    registeredAt: Date.now(),
    lastRequest: Date.now(),
  });
  lastRegisteredSessionId = sessionId;

  return {
    sessionId,
    projectDir: normalizedDir,
    rulesDir,
    rulesLoaded: cached.compiledRules.length,
    errors,
  };
}

// --- Checklist loader ---
function loadChecklist(rulesDir, context) {
  const cacheKey = rulesDir + '|' + context;
  const cached = checklistCache.get(cacheKey);
  if (cached) return cached;
  const checklistPath = path.join(rulesDir, context, 'checklist.json');
  try {
    const data = JSON.parse(fs.readFileSync(checklistPath, 'utf8'));
    if (data.context === context && Array.isArray(data.items)) {
      const items = data.items.map(item => ({
        name: item.name,
        verificationRe: new RegExp(item.verification, 'i'),
        tools: new Set(item.tools || []),
        severity: item.severity || 'recommended',
        message: item.message || item.name,
      }));
      checklistCache.set(cacheKey, items);
      return items;
    }
  } catch {}
  return null;
}

// --- Briefing builder ---
function buildBriefing(rulesDir, context) {
  const fileList = BRIEFING_FILES[context];
  if (!fileList) return null;
  const sections = ['# Subagent Briefing: ' + context, ''];
  for (const fileName of fileList) {
    const filePath = path.join(rulesDir, context, fileName);
    try {
      sections.push(fs.readFileSync(filePath, 'utf8').trim());
      sections.push('');
    } catch {}
  }
  const cachedRules = ruleCache.getRules(rulesDir);
  if (cachedRules.compiledRules.length) {
    const guardrails = [];
    for (const entry of cachedRules.compiledRules) {
      if (entry.rule.type !== 'guardrail') continue;
      const guidance = entry.rule.guidance || entry.rule.description;
      if (!guidance) continue;
      guardrails.push('- **' + entry.name + ':** ' + guidance);
    }
    if (guardrails.length) {
      sections.push('## Active Guardrails', '', guardrails.join('\n'), '');
    }
  }
  return sections.join('\n');
}

// --- Per-request context helper ---
function getRequestContext(input) {
  let projectDir = null;

  if (input && input.env && input.env.CLAUDE_PROJECT_DIR) {
    projectDir = input.env.CLAUDE_PROJECT_DIR;
  } else if (input && input.session_id && sessionRegistry.has(input.session_id)) {
    const entry = sessionRegistry.get(input.session_id);
    entry.lastRequest = Date.now();
    projectDir = entry.projectDir;
  } else if (lastRegisteredSessionId && sessionRegistry.has(lastRegisteredSessionId)) {
    const entry = sessionRegistry.get(lastRegisteredSessionId);
    entry.lastRequest = Date.now();
    projectDir = entry.projectDir;
  } else if (process.env.CLAUDE_PROJECT_DIR) {
    projectDir = process.env.CLAUDE_PROJECT_DIR;
  }

  if (!projectDir) {
    return {
      projectRoot: null,
      rulesDir: null,
      compiledRules: [],
      rulesData: { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {} },
      hasToolTriggerRules: false,
      hasOutputTriggerRules: false,
      hasStopRules: false,
      hasAsyncRules: false,
    };
  }

  const projectRoot = normalizePath(projectDir);
  const rulesDir = projectRoot + '/.claude/skills';
  const cached = ruleCache.getRules(rulesDir);
  return {
    projectRoot,
    rulesDir,
    ...cached,
  };
}

// --- Pre-compiled rule compiler ---
function compileRules(data) {
  if (!data || !data.rules) return [];
  const compiled = [];
  for (const [name, rule] of Object.entries(data.rules)) {
    const entry = { name, rule };
    if (rule.sourceRepo) entry.sourceRepo = normalizePath(rule.sourceRepo);
    const pt = rule.triggers && rule.triggers.prompt;
    if (pt) {
      entry.keywordsLower = (pt.keywords || []).map(k => k.toLowerCase());
      entry.intentRe = (pt.intentPatterns || []).reduce((acc, pat) => {
        try { acc.push(new RegExp(pat, 'i')); } catch {}
        return acc;
      }, []);
    }
    const ft = rule.triggers && rule.triggers.file;
    if (ft) {
      entry.pathRe = (ft.pathPatterns || []).map(p => globToRegex(p));
      entry.exclRe = (ft.pathExclusions || []).map(p => globToRegex(p));
      entry.contentRe = (ft.contentPatterns || []).reduce((acc, pat) => {
        try { acc.push(new RegExp(pat)); } catch {}
        return acc;
      }, []);
      entry.contentExclRe = (ft.contentExclusions || []).reduce((acc, pat) => {
        try { acc.push(new RegExp(pat)); } catch {}
        return acc;
      }, []);
      if (ft.toolNames && Array.isArray(ft.toolNames) && ft.toolNames.length) {
        entry.toolNamesSet = new Set(ft.toolNames);
      }
    }
    const tt = rule.triggers && rule.triggers.tool;
    if (tt) {
      if (tt.toolNames && Array.isArray(tt.toolNames) && tt.toolNames.length) {
        entry.toolTriggerNamesSet = new Set(tt.toolNames);
      }
      entry.inputRe = (tt.inputPatterns || []).reduce((acc, pat) => {
        try { acc.push(new RegExp(pat, 'i')); } catch {}
        return acc;
      }, []);
    }
    const ot = rule.triggers && rule.triggers.output;
    if (ot) {
      if (ot.toolNames && Array.isArray(ot.toolNames) && ot.toolNames.length) {
        entry.outputToolNamesSet = new Set(ot.toolNames);
      }
      entry.outputRe = (ot.outputPatterns || []).reduce((acc, pat) => {
        try { acc.push(new RegExp(pat, 'i')); } catch {}
        return acc;
      }, []);
    }
    if (rule.hookEvents && Array.isArray(rule.hookEvents)) {
      entry.hookEventsSet = new Set(rule.hookEvents);
    }
    if (rule.contextBoost) {
      entry.boostWeight = rule.contextBoost.weight || 0.3;
      entry.boostRe = (rule.contextBoost.patterns || []).reduce((acc, pat) => {
        try { acc.push(new RegExp(pat, 'i')); } catch {}
        return acc;
      }, []);
    }
    if (rule.async && rule.async.analyzer) {
      entry.isAsync = true;
      entry.asyncAnalyzer = rule.async.analyzer;
      entry.asyncConfig = rule.async.config || {};
    }
    compiled.push(entry);
  }

  return compiled;
}

// --- Session tracking (keyed by sessionId + '|' + projectRoot) ---
const sessions = new Map();

function getSession(sessionId, projectRoot) {
  if (!sessionId) return null;
  const key = sessionId + '|' + (projectRoot || '');
  let s = sessions.get(key);
  if (!s) {
    s = { firedRules: new Set(), lastSeen: Date.now() };
    sessions.set(key, s);
  }
  s.lastSeen = Date.now();
  return s;
}

function cleanStaleSessions() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) sessions.delete(id);
  }
  for (const [id, entry] of sessionRegistry) {
    const lastActive = entry.lastRequest;
    if (lastActive < cutoff) {
      sessionRegistry.delete(id);
      if (lastRegisteredSessionId === id) lastRegisteredSessionId = null;
    }
  }
  for (const [id] of sessionContexts) {
    const reg = sessionRegistry.get(id);
    if (!reg || reg.lastRequest < cutoff) sessionContexts.delete(id);
  }
  for (const [id] of sessionChecklists) {
    const reg = sessionRegistry.get(id);
    if (!reg || reg.lastRequest < cutoff) sessionChecklists.delete(id);
  }
  asyncManager.clearStaleSessions(sessionRegistry);
}

const cleanupInterval = setInterval(cleanStaleSessions, 5 * 60 * 1000);
cleanupInterval.unref();

// --- Skip check (in-memory version) ---
function checkSkip(ruleName, rule, session) {
  const skip = rule.skipConditions;
  if (!skip) return false;
  if (skip.envVars && skip.envVars.length) {
    if (skip.envVars.some(v => process.env[v])) return true;
  }
  if (skip.sessionOnce && session) {
    if (session.firedRules.has(ruleName)) return true;
  }
  return false;
}

// --- Matching (using pre-compiled regexes) ---
function matchPromptCompiled(prompt, entry) {
  const lower = prompt.toLowerCase();
  if (entry.keywordsLower && entry.keywordsLower.some(kw => lower.includes(kw))) return true;
  if (entry.intentRe && entry.intentRe.some(re => re.test(prompt))) return true;
  return false;
}

function matchPromptWithBoost(prompt, entry) {
  const lower = prompt.toLowerCase();
  let score = 0;
  if (entry.keywordsLower && entry.keywordsLower.some(kw => lower.includes(kw))) score = 1.0;
  else if (entry.intentRe && entry.intentRe.some(re => re.test(prompt))) score = 1.0;
  if (entry.boostRe && entry.boostRe.length) {
    let boostHits = 0;
    for (const re of entry.boostRe) {
      if (re.test(prompt)) boostHits++;
    }
    score += Math.min(boostHits * entry.boostWeight, 1.0);
  }
  return score >= 1.0;
}

function matchFileCompiled(filePath, entry, projectRoot, rulesData) {
  let normalized = normalizePath(filePath);
  // Strip project root to get relative path for glob matching
  if (projectRoot) {
    const root = IS_WIN ? projectRoot.toLowerCase() : projectRoot;
    const test = IS_WIN ? normalized.toLowerCase() : normalized;
    if (test.startsWith(root + '/')) {
      normalized = normalized.slice(projectRoot.length + 1);
    }
  }
  if (entry.exclRe && entry.exclRe.some(re => re.test(normalized))) return false;
  if (!entry.pathRe || !entry.pathRe.length) return false;
  if (!entry.pathRe.some(re => re.test(normalized))) return false;
  const hasContentRe = entry.contentRe && entry.contentRe.length;
  const hasContentExcl = entry.contentExclRe && entry.contentExclRe.length;
  // exclusions without contentPatterns = fire on all non-excluded content (mirrors pathExclusions)
  if (hasContentRe || hasContentExcl) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { return false; }
    if (hasContentRe && !entry.contentRe.some(re => re.test(content))) return false;
    if (hasContentExcl && entry.contentExclRe.some(re => re.test(content))) return false;
  }
  return true;
}

// --- Shared matching infrastructure ---
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
      enforcement: result.enforcement || getEnforcement(entry.rule, rulesData.defaults)
    });
  }
  return matches;
}

function sortByPriority(matches) {
  matches.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));
}

const ENFORCEMENT_ORDER = { block: 0, ask: 1, warn: 2 };

function sortBlockFirst(matches) {
  matches.sort((a, b) => {
    const aO = ENFORCEMENT_ORDER[a.enforcement] ?? 2;
    const bO = ENFORCEMENT_ORDER[b.enforcement] ?? 2;
    if (aO !== bO) return aO - bO;
    return (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2);
  });
}

function recordSessionOnce(session, matches) {
  if (!session) return;
  for (const m of matches) {
    if (m.rule.skipConditions && m.rule.skipConditions.sessionOnce) {
      session.firedRules.add(m.name);
    }
  }
}

function formatAsyncFindings(findings) {
  const lines = [];
  lines.push('───────────────────────────────');
  lines.push('⚠️ Async Analysis Results (' + findings.length + ' finding' + (findings.length > 1 ? 's' : '') + '):');
  lines.push('');
  for (const f of findings) {
    const prefix = f.severity === 'warning' ? '⚠️' : 'ℹ️';
    lines.push(prefix + ' ' + f.message);
    if (f.relatedFiles && f.relatedFiles.length) {
      lines.push('  Related: ' + f.relatedFiles.join(', '));
    }
  }
  lines.push('');
  return lines;
}

function buildEnforcementResponse(matches) {
  if (!matches.length) return {};
  sortBlockFirst(matches);

  const blockMatch = matches.find(m => m.enforcement === 'block');
  if (blockMatch) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: blockMatch.rule.blockMessage || ('Blocked by rule: ' + blockMatch.name) } };
  }
  const askMatch = matches.find(m => m.enforcement === 'ask');
  if (askMatch) {
    const reason = askMatch.rule.askMessage || askMatch.rule.blockMessage || ('Requires approval: ' + askMatch.name);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } };
  }
  const warnings = matches.filter(m => m.enforcement === 'warn').map(m => '⚠️ ' + m.name + ': ' + m.rule.description);
  const joined = warnings.join('\n');
  if (joined) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext: joined } };
  return {};
}

function initializeSessionChecklists(sessionId, matches, rulesDir) {
  for (const m of matches) {
    if (!m.rule.sessionContext) continue;
    let ctxSet = sessionContexts.get(sessionId);
    if (!ctxSet) {
      ctxSet = new Set();
      sessionContexts.set(sessionId, ctxSet);
    }
    ctxSet.add(m.rule.sessionContext);
    if (rulesDir) {
      const items = loadChecklist(rulesDir, m.rule.sessionContext);
      if (items) {
        let state = sessionChecklists.get(sessionId);
        if (!state) {
          state = new Map();
          sessionChecklists.set(sessionId, state);
        }
        for (const item of items) {
          if (!state.has(item.name)) {
            state.set(item.name, { satisfied: false, item });
          }
        }
      }
    }
  }
}

// --- Activate handler ---
function handleActivate(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const prompt = input && input.prompt;
  if (!prompt) return {};
  const ctx = getRequestContext(input);
  const session = getSession(input.session_id, ctx.projectRoot);

  const matches = collectMatches(ctx.compiledRules, ctx.projectRoot, session, ctx.rulesData, (entry) => {
    if (!entry.keywordsLower && !entry.intentRe && !entry.boostRe) return false;
    if (!matchPromptWithBoost(prompt, entry)) return false;
    return {};
  });
  if (!matches.length) {
    const asyncFindings = input && input.session_id ? asyncManager.drainFindings(input.session_id) : [];
    if (!asyncFindings.length) return {};
    const lines = formatAsyncFindings(asyncFindings);
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lines.join('\n') } };
  }
  sortByPriority(matches);
  recordSessionOnce(session, matches);

  if (input.session_id) {
    initializeSessionChecklists(input.session_id, matches, ctx.rulesDir);
  }

  const count = matches.length;
  const lines = [
    '⚡ Skill Engine — ' + count + ' relevant skill' + (count > 1 ? 's' : '') + ' detected:',
    ''
  ];
  for (const m of matches) {
    const typeLabel = m.rule.type === 'guardrail' ? ' (guardrail)' : '';
    lines.push('[' + m.priority.toUpperCase() + '] ' + m.name + typeLabel);
    lines.push('  ' + m.rule.description);
    if (m.rule.contextEnhancement && input.session_id) {
      const ctxSet = sessionContexts.get(input.session_id);
      if (ctxSet) {
        for (const ctxTag of ctxSet) {
          if (m.rule.contextEnhancement[ctxTag]) {
            lines.push('  ⚡ ' + m.rule.contextEnhancement[ctxTag]);
          }
        }
      }
    }
    if (m.rule.skillPath) lines.push('  → Read: ' + m.rule.skillPath);
    lines.push('');
  }

  // Drain async findings for this session
  const asyncFindings = input.session_id ? asyncManager.drainFindings(input.session_id) : [];
  if (asyncFindings.length) {
    lines.push(...formatAsyncFindings(asyncFindings));
  }

  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lines.join('\n') } };
}

// --- Enforce-tool handler (PreToolUse for any tool) ---
function handleEnforceTool(input, ctx) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  ctx = ctx || getRequestContext(input);
  if (!ctx.hasToolTriggerRules) return {};
  const toolName = input && input.tool_name;
  const toolInput = input && input.tool_input;
  if (!toolName && !toolInput) return {};
  const inputStr = toolInput ? JSON.stringify(toolInput) : '';
  const session = getSession(input.session_id, ctx.projectRoot);

  const matches = collectMatches(ctx.compiledRules, ctx.projectRoot, session, ctx.rulesData, (entry, rd) => {
    if (!entry.toolTriggerNamesSet && (!entry.inputRe || !entry.inputRe.length)) return false;
    if (entry.rule.type !== 'guardrail') return false;
    if (entry.isAsync) return false;
    const enforcement = getEnforcement(entry.rule, rd.defaults);
    if (enforcement !== 'block' && enforcement !== 'ask' && enforcement !== 'warn') return false;
    if (entry.toolTriggerNamesSet && toolName && !entry.toolTriggerNamesSet.has(toolName)) return false;
    if (entry.toolTriggerNamesSet && !toolName) return false;
    if (entry.inputRe && entry.inputRe.length && !entry.inputRe.some(re => re.test(inputStr))) return false;
    return { enforcement };
  });
  return buildEnforcementResponse(matches);
}

// --- Post-tool handler (PostToolUse) ---
function handlePostTool(input, ctx) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  ctx = ctx || getRequestContext(input);
  const toolName = input && input.tool_name;
  const toolOutput = input && input.tool_output;
  const outputStr = typeof toolOutput === 'string' ? toolOutput : (toolOutput ? JSON.stringify(toolOutput) : '');

  // Track checklist satisfaction
  const sid = input && input.session_id;
  if (sid && sessionChecklists.has(sid)) {
    const state = sessionChecklists.get(sid);
    const inputContent = input.tool_input ? JSON.stringify(input.tool_input) : '';
    const combinedContent = inputContent + ' ' + outputStr;
    for (const [, entry] of state) {
      if (entry.satisfied) continue;
      if (entry.item.tools.size && !entry.item.tools.has(toolName)) continue;
      if (entry.item.verificationRe.test(combinedContent)) entry.satisfied = true;
    }
  }

  if (!ctx.hasOutputTriggerRules) return {};
  const session = getSession(sid, ctx.projectRoot);

  const matches = collectMatches(ctx.compiledRules, ctx.projectRoot, session, ctx.rulesData, (entry) => {
    if (!entry.outputToolNamesSet && (!entry.outputRe || !entry.outputRe.length)) return false;
    if (entry.outputToolNamesSet && toolName && !entry.outputToolNamesSet.has(toolName)) return false;
    if (entry.outputToolNamesSet && !toolName) return false;
    if (entry.outputRe && entry.outputRe.length && !entry.outputRe.some(re => re.test(outputStr))) return false;
    return {};
  });
  if (!matches.length) return {};
  sortByPriority(matches);
  recordSessionOnce(session, matches);

  const lines = matches.map(m => m.rule.guidance || m.rule.description);
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lines.join('\n') } };
}

// --- Stop handler ---
function handleStop(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const ctx = getRequestContext(input);
  const session = getSession(input && input.session_id, ctx.projectRoot);
  const lines = [];

  if (ctx.hasStopRules) {
    const matches = collectMatches(ctx.compiledRules, ctx.projectRoot, session, ctx.rulesData, (entry) => {
      if (!entry.hookEventsSet || !entry.hookEventsSet.has('Stop')) return false;
      return {};
    });
    sortByPriority(matches);
    recordSessionOnce(session, matches);
    lines.push(...matches.map(m => m.rule.guidance || m.rule.description));
  }

  const sid = input && input.session_id;
  if (sid && sessionChecklists.has(sid)) {
    const state = sessionChecklists.get(sid);
    for (const [, entry] of state) {
      if (!entry.satisfied && entry.item.severity === 'required') {
        lines.push('⚠️ Checklist: ' + entry.item.message);
      }
    }
  }

  if (!lines.length) return {};
  return { decision: 'block', reason: lines.join('\n') };
}

// --- Enforce handler ---
function handleEnforce(input, ctx) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const filePath = input && input.tool_input && input.tool_input.file_path;
  if (!filePath) return {};
  const toolName = input && input.tool_name;
  const writeContent = input && input.tool_input && (input.tool_input.content || input.tool_input.new_string || '');
  ctx = ctx || getRequestContext(input);
  const session = getSession(input.session_id, ctx.projectRoot);

  const matches = collectMatches(ctx.compiledRules, ctx.projectRoot, session, ctx.rulesData, (entry, rd) => {
    if (entry.rule.type !== 'guardrail') return false;
    if (entry.isAsync) return false;
    const enforcement = getEnforcement(entry.rule, rd.defaults);
    if (enforcement !== 'block' && enforcement !== 'ask' && enforcement !== 'warn') return false;
    if (!entry.pathRe || !entry.pathRe.length) return false;
    if (entry.toolNamesSet && toolName && !entry.toolNamesSet.has(toolName)) return false;
    if (!matchFileCompiled(filePath, entry, ctx.projectRoot, rd)) return false;
    return { enforcement };
  });
  return buildEnforcementResponse(matches);
}

function handlePreWrite(input, ctx) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  ctx = ctx || getRequestContext(input);
  return preWriteHandler(input, ctx.projectRoot);
}

// --- Stats ---
let eventsProcessed = 0;
let lastEvent = null;
let paused = false;

// --- Consolidated PreToolUse handler ---
function handlePreTool(input) {
  const ctx = (paused || process.env.SKILL_ENGINE_OFF === '1') ? null : getRequestContext(input);

  const results = [
    handleEnforce(input, ctx),
    handleEnforceTool(input, ctx),
    handlePreWrite(input, ctx),
  ];

  // Dispatch async jobs for matching async rules
  if (ctx) {
    if (ctx.hasAsyncRules && input && input.tool_input && input.tool_input.file_path) {
      const filePath = input.tool_input.file_path;
      const content = input.tool_input.content || input.tool_input.new_string || '';
      const session = getSession(input.session_id, ctx.projectRoot);

      for (const entry of ctx.compiledRules) {
        if (!entry.isAsync) continue;
        if (!ruleMatchesProject(entry, ctx.projectRoot)) continue;
        if (checkSkip(entry.name, entry.rule, session)) continue;
        if (!matchFileCompiled(filePath, entry, ctx.projectRoot, ctx.rulesData)) continue;

        asyncManager.postJob({
          sessionId: input.session_id || 'unknown',
          projectRoot: ctx.projectRoot,
          analyzer: entry.asyncAnalyzer,
          config: entry.asyncConfig,
          context: {
            filePath,
            content,
            toolName: input.tool_name || '',
            ruleName: entry.name,
          }
        });
      }
    }
  }

  let deny = null;
  let ask = null;
  const contexts = [];

  for (const r of results) {
    const hso = r && r.hookSpecificOutput;
    if (!hso) continue;
    const decision = hso.permissionDecision;
    if (decision === 'deny' && !deny) {
      deny = r;
    } else if (decision === 'ask' && !ask) {
      ask = r;
    }
    if (hso.additionalContext) {
      contexts.push(hso.additionalContext);
    }
  }

  if (deny) {
    const out = { ...deny.hookSpecificOutput };
    if (contexts.length) out.additionalContext = contexts.join('\n');
    return { hookSpecificOutput: out };
  }

  if (ask) {
    const out = { ...ask.hookSpecificOutput };
    if (contexts.length) out.additionalContext = contexts.join('\n');
    return { hookSpecificOutput: out };
  }

  if (contexts.length) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: contexts.join('\n'),
      }
    };
  }

  return {};
}

// --- Route table ---
const routes = {
  '/activate':     { handler: handleActivate,    event: 'activate' },
  '/enforce':      { handler: handleEnforce,     event: 'enforce' },
  '/enforce-tool': { handler: handleEnforceTool, event: 'enforce-tool' },
  '/post-tool':    { handler: handlePostTool,    event: 'post-tool' },
  '/pre-write':    { handler: handlePreWrite,    event: 'pre-write' },
  '/pre-tool':     { handler: handlePreTool,     event: 'pre-tool' },
  '/stop':         { handler: handleStop,        event: 'stop' },
};

// --- Request router ---
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    const MAX = 1024 * 1024; // 1MB
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX) { req.destroy(); reject(new Error('Body too large')); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function respond(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

async function handleRequest(req, res) {
  const url = req.url;
  const method = req.method;
  const startNs = process.hrtime.bigint();

  if (method === 'GET' && url === '/health') {
    const ctx = getRequestContext(null);
    const cacheState = ruleCache.getCachedState();
    const avgMs = timedResponses > 0
      ? Number(totalResponseTimeNs / BigInt(timedResponses)) / 1e6
      : 0;

    const sessionsObj = {};
    for (const [sid, entry] of sessionRegistry) {
      const cached = ruleCache.getRules(entry.rulesDir);
      sessionsObj[sid] = {
        projectDir: entry.projectDir,
        rulesDir: entry.rulesDir,
        rulesLoaded: cached.compiledRules.length,
        registeredAt: new Date(entry.registeredAt).toISOString(),
        lastRequest: new Date(entry.lastRequest).toISOString(),
      };
    }

    return respond(res, 200, {
      version: SERVER_VERSION,
      pid: process.pid,
      uptime: process.uptime(),
      rulesLoaded: ctx.compiledRules.length,
      port: PORT,
      lastEvent,
      eventsProcessed,
      activeSessions: sessionRegistry.size,
      avgResponseTimeMs: Math.round(avgMs * 100) / 100,
      paused,
      rulesDir: ctx.rulesDir || null,
      hasToolTriggerRules: ctx.hasToolTriggerRules,
      hasOutputTriggerRules: ctx.hasOutputTriggerRules,
      hasStopRules: ctx.hasStopRules,
      hasAsyncRules: ctx.hasAsyncRules,
      asyncWorker: asyncManager.getStatus(),
      sessions: sessionsObj,
      sessionContexts: Object.fromEntries(
        [...sessionContexts.entries()].map(([id, set]) => [id, [...set]])
      ),
      cache: cacheState,
      deprecatedSetProjectCalls,
    });
  }

  if (method === 'GET' && (url === '/rules' || url.startsWith('/rules?'))) {
    const params = new URL(url, 'http://localhost').searchParams;
    const sessionFilter = params.get('session');

    if (sessionFilter && sessionRegistry.has(sessionFilter)) {
      const entry = sessionRegistry.get(sessionFilter);
      const cached = ruleCache.getRules(entry.rulesDir);
      const rules = cached.compiledRules.map(e => ({
        name: e.name,
        type: e.rule.type,
        enforcement: getEnforcement(e.rule, cached.rulesData.defaults),
        priority: getPriority(e.rule, cached.rulesData.defaults),
        description: e.rule.description,
        sourceRepo: e.sourceRepo || null,
        triggers: Object.keys(e.rule.triggers || {}),
        hookEvents: e.rule.hookEvents || null,
      }));
      return respond(res, 200, {
        session: sessionFilter,
        projectDir: entry.projectDir,
        rulesDir: entry.rulesDir,
        count: rules.length,
        rules,
      });
    }

    const allRules = [];
    for (const [sid, entry] of sessionRegistry) {
      const cached = ruleCache.getRules(entry.rulesDir);
      for (const e of cached.compiledRules) {
        allRules.push({
          session: sid,
          projectDir: entry.projectDir,
          name: e.name,
          type: e.rule.type,
          enforcement: getEnforcement(e.rule, cached.rulesData.defaults),
          priority: getPriority(e.rule, cached.rulesData.defaults),
          description: e.rule.description,
          sourceRepo: e.sourceRepo || null,
          triggers: Object.keys(e.rule.triggers || {}),
          hookEvents: e.rule.hookEvents || null,
        });
      }
    }
    return respond(res, 200, { count: allRules.length, rules: allRules });
  }

  if (method === 'GET' && (url === '/briefing' || url.startsWith('/briefing?'))) {
    const params = new URL(url, 'http://localhost').searchParams;
    const context = params.get('context');
    if (!context) return respond(res, 400, { error: 'context parameter required' });
    const bCtx = getRequestContext(null);
    if (!bCtx.rulesDir) return respond(res, 500, { error: 'No project registered' });
    const briefing = buildBriefing(bCtx.rulesDir, context);
    if (!briefing) return respond(res, 404, { error: 'Unknown context: ' + context });
    return respond(res, 200, { context, briefing });
  }

  // Route table for POST handler endpoints
  const route = method === 'POST' && routes[url];
  if (route) {
    try {
      const body = await readBody(req);
      eventsProcessed++;
      lastEvent = route.event;
      const result = route.handler(body);
      const elapsed = process.hrtime.bigint() - startNs;
      totalResponseTimeNs += elapsed;
      timedResponses++;
      res.setHeader('X-Response-Time', (Number(elapsed) / 1e6).toFixed(2) + 'ms');
      return respond(res, 200, result);
    } catch {
      return respond(res, 400, { error: 'Invalid JSON' });
    }
  }

  if (method === 'POST' && url === '/register-session') {
    let body = null;
    try { body = await readBody(req); } catch {}
    if (body && body.sessionId && body.projectDir) {
      const result = registerSession(body.sessionId, body.projectDir);
      return respond(res, 200, result);
    }
    return respond(res, 400, { error: 'sessionId and projectDir required' });
  }

  if (method === 'POST' && url === '/set-project') {
    let body = null;
    try { body = await readBody(req); } catch {}
    if (body && body.projectDir) {
      deprecatedSetProjectCalls++;
      const syntheticId = crypto.createHash('md5').update(normalizePath(body.projectDir)).digest('hex').slice(0, 16);
      const result = registerSession(syntheticId, body.projectDir);
      return respond(res, 200, { projectDir: result.projectDir, rulesLoaded: result.rulesLoaded });
    }
    const ctx = getRequestContext(null);
    return respond(res, 200, { rulesLoaded: ctx.compiledRules.length });
  }

  if (method === 'POST' && url === '/pause') {
    paused = true;
    return respond(res, 200, { paused: true });
  }

  if (method === 'POST' && url === '/resume') {
    paused = false;
    return respond(res, 200, { paused: false });
  }

  // POST from hooks → fail-open with empty response (prevents 404 errors during version mismatches)
  if (method === 'POST') return respond(res, 200, {});
  respond(res, 404, { error: 'Not found' });
}

// --- Start ---
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    if (!res.writableEnded) respond(res, 500, { error: 'Internal error' });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('skill-engine server listening on port ' + PORT + '\n');
});

// Graceful shutdown
function shutdown() {
  clearInterval(cleanupInterval);
  asyncManager.shutdown();
  server.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
