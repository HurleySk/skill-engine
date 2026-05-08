'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// --- Shared utilities from rules-io.js / glob-match.js ---
const libDir = path.resolve(__dirname, '..', 'hooks', 'lib');
const { normalizePath, globToRegex } = require(path.join(libDir, 'glob-match'));
const { loadRules } = require(path.join(libDir, 'rules-io'));
const { handlePreWrite: preWriteHandler } = require('./pre-write-safety');
const asyncEngine = require('./async/engine');
const skillFeedback = require('./skill-feedback');

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

// --- Audit log circular buffer (Feature: last 100 enforcement decisions) ---
const AUDIT_LOG_MAX = 100;
const auditLog = [];

function recordAuditEntry(entry) {
  auditLog.push(entry);
  if (auditLog.length > AUDIT_LOG_MAX) auditLog.shift();
}

function getAuditLogSummary() {
  if (!auditLog.length) return { entries: 0, oldestEntry: null, newestEntry: null };
  return {
    entries: auditLog.length,
    oldestEntry: auditLog[0].timestamp,
    newestEntry: auditLog[auditLog.length - 1].timestamp,
  };
}

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

  invalidate(rulesDir) {
    if (rulesDir) {
      this._entries.delete(rulesDir);
    }
  }

  getRules(rulesDir) {
    if (!rulesDir) {
      return {
        compiledRules: [],
        compilationWarnings: [],
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

    const compileResult = compileRules(rulesData);
    const compiled = compileResult.compiled;
    const compilationWarnings = compileResult.compilationWarnings;
    const hasToolTriggerRules = compiled.some(e => e.toolTriggerNamesSet || (e.inputRe && e.inputRe.length));
    const hasOutputTriggerRules = compiled.some(e => e.outputToolNamesSet || (e.outputRe && e.outputRe.length));
    const hasStopRules = compiled.some(e => e.hookEventsSet && e.hookEventsSet.has('Stop'));
    const hasAsyncRules = compiled.some(e => e.isAsync);

    const snapshot = Object.freeze({
      compiledRules: compiled,
      compilationWarnings,
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

// --- Learn.js functions (for POST /learn endpoint) ---
const learnLib = require(path.join(libDir, 'learn'));

// --- Session Registry (replaces lastProjectDir) ---
const crypto = require('crypto');
const sessionRegistry = new Map();
const sessionContexts = new Map(); // sessionId → Set of context tags
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
  if (!data || !data.rules) return { compiled: [], compilationWarnings: [] };
  const compiled = [];
  const compilationWarnings = [];

  function tryCompileRegex(ruleName, field, pattern, flags) {
    try {
      return new RegExp(pattern, flags);
    } catch (err) {
      compilationWarnings.push({ ruleName, field, pattern, error: err.message });
      return null;
    }
  }

  function compilePatternArray(ruleName, field, patterns, flags) {
    const result = [];
    for (const pat of patterns) {
      const re = tryCompileRegex(ruleName, field, pat, flags);
      if (re) result.push(re);
    }
    return result;
  }

  for (const [name, rule] of Object.entries(data.rules)) {
    const entry = { name, rule, _compiledPatterns: {} };
    if (rule.sourceRepo) entry.sourceRepo = normalizePath(rule.sourceRepo);
    const pt = rule.triggers && rule.triggers.prompt;
    if (pt) {
      entry.keywordsLower = (pt.keywords || []).map(k => k.toLowerCase());
      entry.intentRe = compilePatternArray(name, 'triggers.prompt.intentPatterns', pt.intentPatterns || [], 'i');
      entry._compiledPatterns.intentPatterns = { total: (pt.intentPatterns || []).length, compiled: entry.intentRe.length };
    }
    const ft = rule.triggers && rule.triggers.file;
    if (ft) {
      entry.pathRe = (ft.pathPatterns || []).map(p => globToRegex(p));
      entry.exclRe = (ft.pathExclusions || []).map(p => globToRegex(p));
      entry.contentRe = compilePatternArray(name, 'triggers.file.contentPatterns', ft.contentPatterns || [], undefined);
      entry._compiledPatterns.contentPatterns = { total: (ft.contentPatterns || []).length, compiled: entry.contentRe.length };
      entry.contentExclRe = compilePatternArray(name, 'triggers.file.contentExclusions', ft.contentExclusions || [], undefined);
      entry._compiledPatterns.contentExclusions = { total: (ft.contentExclusions || []).length, compiled: entry.contentExclRe.length };
      if (ft.toolNames && Array.isArray(ft.toolNames) && ft.toolNames.length) {
        entry.toolNamesSet = new Set(ft.toolNames);
      }
    }
    const tt = rule.triggers && rule.triggers.tool;
    if (tt) {
      if (tt.toolNames && Array.isArray(tt.toolNames) && tt.toolNames.length) {
        entry.toolTriggerNamesSet = new Set(tt.toolNames);
      }
      entry.inputRe = compilePatternArray(name, 'triggers.tool.inputPatterns', tt.inputPatterns || [], 'i');
      entry._compiledPatterns.inputPatterns = { total: (tt.inputPatterns || []).length, compiled: entry.inputRe.length };
    }
    const ot = rule.triggers && rule.triggers.output;
    if (ot) {
      if (ot.toolNames && Array.isArray(ot.toolNames) && ot.toolNames.length) {
        entry.outputToolNamesSet = new Set(ot.toolNames);
      }
      entry.outputRe = compilePatternArray(name, 'triggers.output.outputPatterns', ot.outputPatterns || [], 'i');
      entry._compiledPatterns.outputPatterns = { total: (ot.outputPatterns || []).length, compiled: entry.outputRe.length };
    }
    if (rule.hookEvents && Array.isArray(rule.hookEvents)) {
      entry.hookEventsSet = new Set(rule.hookEvents);
    }
    if (rule.contextBoost) {
      entry.boostWeight = rule.contextBoost.weight || 0.3;
      entry.boostRe = compilePatternArray(name, 'contextBoost.patterns', rule.contextBoost.patterns || [], 'i');
      entry._compiledPatterns.boostPatterns = { total: (rule.contextBoost.patterns || []).length, compiled: entry.boostRe.length };
    }
    if (rule.async) {
      const normalized = asyncEngine.registry.normalizeAsyncBlock(rule.async);
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

  return { compiled, compilationWarnings };
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
  asyncEngine.clearStaleSessions(sessionRegistry);
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

function initializeSessionContexts(sessionId, matches) {
  for (const m of matches) {
    if (!m.rule.sessionContext) continue;
    let ctxSet = sessionContexts.get(sessionId);
    if (!ctxSet) {
      ctxSet = new Set();
      sessionContexts.set(sessionId, ctxSet);
    }
    ctxSet.add(m.rule.sessionContext);
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
    const asyncLines = input && input.session_id ? asyncEngine.drain(input.session_id) : [];
    const health = skillFeedback.getHealth();
    if (!asyncLines.length && !health.flagged.length) return {};
    const outLines = [];
    if (asyncLines.length) outLines.push(...asyncLines);
    if (health.flagged.length) {
      const skillList = health.flagged.map(f => f.skillName).join(', ');
      if (outLines.length) outLines.push('');
      outLines.push('\u{1F4CB} **Skill health:** ' + health.flagged.length + ' skill' +
        (health.flagged.length > 1 ? 's have' : ' has') +
        ' accumulated feedback (' + skillList + ') — run `/skill-engine:skill-improve` to review.');
    }
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: outLines.join('\n') } };
  }
  sortByPriority(matches);
  recordSessionOnce(session, matches);

  for (const m of matches) {
    skillFeedback.recordSignal({
      skillName: m.name,
      type: 'activation',
      summary: '',
      sessionId: input.session_id || '',
    });
  }

  if (input.session_id) {
    initializeSessionContexts(input.session_id, matches);
  }

  // Dispatch async jobs for async rules matching this prompt
  asyncEngine.dispatch(ctx, input, (entry) => {
    if (!entry.keywordsLower && !entry.intentRe && !entry.boostRe) return false;
    return matchPromptWithBoost(prompt, entry);
  }, () => ({ prompt }), { getSession, checkSkip, ruleMatchesProject });

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
  const asyncLines = input.session_id ? asyncEngine.drain(input.session_id) : [];
  if (asyncLines.length) {
    lines.push(...asyncLines);
  }

  // Append skill-health nudge if skills are flagged
  const health = skillFeedback.getHealth();
  if (health.flagged.length > 0) {
    const skillList = health.flagged.map(f => f.skillName).join(', ');
    lines.push('');
    lines.push('\u{1F4CB} **Skill health:** ' + health.flagged.length + ' skill' +
      (health.flagged.length > 1 ? 's have' : ' has') +
      ' accumulated feedback (' + skillList + ') — run `/skill-engine:skill-improve` to review.');
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

  // Dispatch async jobs for async rules with tool triggers
  asyncEngine.dispatch(ctx, input, (entry) => {
    if (!entry.toolTriggerNamesSet && (!entry.inputRe || !entry.inputRe.length)) return false;
    if (entry.toolTriggerNamesSet && toolName && !entry.toolTriggerNamesSet.has(toolName)) return false;
    if (entry.toolTriggerNamesSet && !toolName) return false;
    if (entry.inputRe && entry.inputRe.length && !entry.inputRe.some(re => re.test(inputStr))) return false;
    return true;
  }, () => ({ toolName, toolInput: input.tool_input }), { getSession, checkSkip, ruleMatchesProject });

  return buildEnforcementResponse(matches);
}

// --- Post-tool handler (PostToolUse) ---
function handlePostTool(input, ctx) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  ctx = ctx || getRequestContext(input);
  const toolName = input && input.tool_name;
  const toolOutput = input && input.tool_output;
  const outputStr = typeof toolOutput === 'string' ? toolOutput : (toolOutput ? JSON.stringify(toolOutput) : '');
  const sid = input && input.session_id;

  // Dispatch async jobs for async rules with output triggers
  if (ctx.hasAsyncRules) {
    asyncEngine.dispatch(ctx, input, (entry) => {
      if (!entry.outputToolNamesSet && (!entry.outputRe || !entry.outputRe.length)) return false;
      if (entry.outputToolNamesSet && toolName && !entry.outputToolNamesSet.has(toolName)) return false;
      if (entry.outputToolNamesSet && !toolName) return false;
      if (entry.outputRe && entry.outputRe.length && !entry.outputRe.some(re => re.test(outputStr))) return false;
      return true;
    }, () => ({ toolName, toolInput: input.tool_input, toolOutput: outputStr }), { getSession, checkSkip, ruleMatchesProject });
  }

  const lines = [];

  // Sync output trigger rules
  if (ctx.hasOutputTriggerRules) {
    const session = getSession(sid, ctx.projectRoot);
    const matches = collectMatches(ctx.compiledRules, ctx.projectRoot, session, ctx.rulesData, (entry) => {
      if (entry.isAsync) return false;
      if (!entry.outputToolNamesSet && (!entry.outputRe || !entry.outputRe.length)) return false;
      if (entry.outputToolNamesSet && toolName && !entry.outputToolNamesSet.has(toolName)) return false;
      if (entry.outputToolNamesSet && !toolName) return false;
      if (entry.outputRe && entry.outputRe.length && !entry.outputRe.some(re => re.test(outputStr))) return false;
      return {};
    });
    if (matches.length) {
      sortByPriority(matches);
      recordSessionOnce(session, matches);
      lines.push(...matches.map(m => m.rule.guidance || m.rule.description));
    }
  }

  // Deliver pending async findings mid-turn
  const asyncLines = sid ? asyncEngine.drain(sid) : [];
  if (asyncLines.length) {
    lines.push(...asyncLines);
  }

  if (!lines.length) return {};
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lines.join('\n') } };
}

// --- Stop handler ---
function handleStop(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const ctx = getRequestContext(input);
  if (!ctx.hasStopRules) return {};
  const session = getSession(input && input.session_id, ctx.projectRoot);

  const matches = collectMatches(ctx.compiledRules, ctx.projectRoot, session, ctx.rulesData, (entry) => {
    if (!entry.hookEventsSet || !entry.hookEventsSet.has('Stop')) return false;
    return {};
  });
  if (!matches.length) return {};
  sortByPriority(matches);
  recordSessionOnce(session, matches);

  const lines = matches.map(m => m.rule.guidance || m.rule.description);
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

  // Dispatch async jobs for matching async rules (file-path triggers)
  if (ctx && input && input.tool_input && input.tool_input.file_path) {
    const filePath = input.tool_input.file_path;
    const content = input.tool_input.content || input.tool_input.new_string || '';
    asyncEngine.dispatch(ctx, input, (entry) => {
      if (!entry.pathRe || !entry.pathRe.length) return false;
      return matchFileCompiled(filePath, entry, ctx.projectRoot, ctx.rulesData);
    }, () => ({ filePath, content, toolName: input.tool_name || '' }), { getSession, checkSkip, ruleMatchesProject });
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
      cacheDir: path.resolve(__dirname, '..'),
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
      async: asyncEngine.getStatus(),
      sessions: sessionsObj,
      sessionContexts: Object.fromEntries(
        [...sessionContexts.entries()].map(([id, set]) => [id, [...set]])
      ),
      cache: cacheState,
      deprecatedSetProjectCalls,
      auditLog: getAuditLogSummary(),
      compilationWarnings: {
        count: (ctx.compilationWarnings || []).length,
        details: ctx.compilationWarnings || [],
      },
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
        compiledPatterns: e._compiledPatterns || {},
      }));
      const warnings = (cached.compilationWarnings || []).filter(w =>
        rules.some(r => r.name === w.ruleName)
      );
      return respond(res, 200, {
        session: sessionFilter,
        projectDir: entry.projectDir,
        rulesDir: entry.rulesDir,
        count: rules.length,
        compilationWarnings: warnings,
        rules,
      });
    }

    const allRules = [];
    const allWarnings = [];
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
          compiledPatterns: e._compiledPatterns || {},
        });
      }
      if (cached.compilationWarnings && cached.compilationWarnings.length) {
        allWarnings.push(...cached.compilationWarnings.map(w => ({ session: sid, ...w })));
      }
    }
    return respond(res, 200, { count: allRules.length, compilationWarnings: allWarnings, rules: allRules });
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

  // --- Skill feedback endpoints ---
  if (method === 'GET' && url === '/skill-health') {
    const health = skillFeedback.getHealth();
    return respond(res, 200, health);
  }

  if (method === 'GET' && (url === '/skill-feedback/signals' || url.startsWith('/skill-feedback/signals?'))) {
    const params = new URL(url, 'http://localhost').searchParams;
    const sessionId = params.get('sessionId');
    const skillName = params.get('skillName');
    const type = params.get('type');

    let signals;
    if (sessionId) {
      signals = skillFeedback.getSignalsForSession(sessionId, { type: type || undefined });
      if (skillName) signals = signals.filter(s => s.skillName === skillName);
    } else if (skillName) {
      signals = skillFeedback.getSignalsForSkill(skillName);
      if (type) signals = signals.filter(s => s.type === type);
    } else {
      signals = skillFeedback.getAllSignals({ type: type || undefined });
    }

    return respond(res, 200, signals);
  }

  if (method === 'POST' && url === '/skill-feedback') {
    let body = null;
    try { body = await readBody(req); } catch {}
    if (!body || !body.skillName) {
      return respond(res, 400, { error: 'skillName required' });
    }
    const result = skillFeedback.recordSignal(body);
    return respond(res, 200, result);
  }

  if (method === 'POST' && url === '/skill-feedback/clear') {
    let body = null;
    try { body = await readBody(req); } catch {}
    if (!body || !body.skillName) {
      return respond(res, 400, { error: 'skillName required' });
    }
    skillFeedback.clearSkill(body.skillName);
    return respond(res, 200, { cleared: true });
  }

  // --- GET /audit-log ---
  if (method === 'GET' && url === '/audit-log') {
    const result = auditLog.slice().reverse();
    return respond(res, 200, result);
  }

  // --- POST /test-rule ---
  if (method === 'POST' && url === '/test-rule') {
    let body = null;
    try { body = await readBody(req); } catch {}
    if (!body) return respond(res, 400, { error: 'Request body required' });

    const simulatedPath = body.simulatedPath || null;
    const simulatedContent = body.simulatedContent || null;
    const ruleName = body.ruleName || null;

    const ctx = getRequestContext(body);
    if (!ctx.projectRoot) return respond(res, 400, { error: 'No project registered — cannot resolve rules' });

    // Helper: test a single compiled entry against simulated path/content
    function testRuleEntry(entry) {
      const result = { name: entry.name, matched: false, pathMatched: false, contentMatched: false,
        enforcement: getEnforcement(entry.rule, ctx.rulesData.defaults),
        message: null };

      if (!simulatedPath) return result;
      if (!entry.pathRe || !entry.pathRe.length) return result;

      // Normalize and relativize path the same way matchFileCompiled does
      let normalized = normalizePath(simulatedPath);
      if (ctx.projectRoot) {
        const root = IS_WIN ? ctx.projectRoot.toLowerCase() : ctx.projectRoot;
        const test = IS_WIN ? normalized.toLowerCase() : normalized;
        if (test.startsWith(root + '/')) {
          normalized = normalized.slice(ctx.projectRoot.length + 1);
        }
      }

      // Check path exclusions
      if (entry.exclRe && entry.exclRe.some(re => re.test(normalized))) return result;

      // Check path patterns
      if (!entry.pathRe.some(re => re.test(normalized))) return result;
      result.pathMatched = true;

      // Content matching (against simulatedContent instead of reading file)
      const hasContentRe = entry.contentRe && entry.contentRe.length;
      const hasContentExcl = entry.contentExclRe && entry.contentExclRe.length;
      if (hasContentRe || hasContentExcl) {
        const content = simulatedContent || '';
        if (hasContentRe && !entry.contentRe.some(re => re.test(content))) return result;
        if (hasContentExcl && entry.contentExclRe.some(re => re.test(content))) return result;
      }
      result.contentMatched = true;
      result.matched = true;

      // Build message
      if (result.enforcement === 'block') {
        result.message = entry.rule.blockMessage || ('Blocked by rule: ' + entry.name);
      } else if (result.enforcement === 'ask') {
        result.message = entry.rule.askMessage || entry.rule.blockMessage || ('Requires approval: ' + entry.name);
      } else if (result.enforcement === 'warn') {
        result.message = entry.rule.description || ('Warning from rule: ' + entry.name);
      }

      return result;
    }

    if (ruleName) {
      // Test a specific rule
      const entry = ctx.compiledRules.find(e => e.name === ruleName);
      if (!entry) return respond(res, 404, { error: 'Rule not found: ' + ruleName });
      return respond(res, 200, testRuleEntry(entry));
    }

    // Test ALL rules
    const results = [];
    for (const entry of ctx.compiledRules) {
      if (!ruleMatchesProject(entry, ctx.projectRoot)) continue;
      const r = testRuleEntry(entry);
      if (r.matched) results.push(r);
    }
    return respond(res, 200, results);
  }

  // --- POST /learn ---
  if (method === 'POST' && url === '/learn') {
    let body = null;
    try { body = await readBody(req); } catch {}
    if (!body || !body.action) {
      return respond(res, 400, { error: 'action field required (add, update, remove, promote, list)' });
    }

    // Resolve rulesDir from session or fallback
    let rulesDir = null;
    if (body.session_id && sessionRegistry.has(body.session_id)) {
      rulesDir = sessionRegistry.get(body.session_id).rulesDir;
    } else if (lastRegisteredSessionId && sessionRegistry.has(lastRegisteredSessionId)) {
      rulesDir = sessionRegistry.get(lastRegisteredSessionId).rulesDir;
    }
    if (!rulesDir) {
      const ctx = getRequestContext(null);
      rulesDir = ctx.rulesDir;
    }
    if (!rulesDir) {
      return respond(res, 400, { error: 'No session registered — cannot resolve rulesDir' });
    }

    const learnedFile = path.join(rulesDir, 'learned-rules.json');
    const action = body.action;

    try {
      let result;
      if (action === 'add') {
        if (!body.name || !body.rule) return respond(res, 400, { error: 'name and rule required for add' });
        result = learnLib.add(body.name, body.rule, learnedFile);
      } else if (action === 'update') {
        if (!body.name || !body.rule) return respond(res, 400, { error: 'name and rule required for update' });
        result = learnLib.update(body.name, body.rule, learnedFile);
      } else if (action === 'remove') {
        if (!body.name) return respond(res, 400, { error: 'name required for remove' });
        result = learnLib.remove(body.name, learnedFile);
      } else if (action === 'promote') {
        if (!body.name) return respond(res, 400, { error: 'name required for promote' });
        const toFile = body.toFile || path.join(rulesDir, 'skill-rules.json');
        result = learnLib.promote(body.name, learnedFile, toFile);
      } else if (action === 'list') {
        result = learnLib.list(learnedFile);
      } else {
        return respond(res, 400, { error: 'Unknown action: ' + action + '. Use add, update, remove, promote, or list.' });
      }

      // Invalidate cache after mutations so next request picks up changes
      if (result && result.ok && action !== 'list') {
        ruleCache.invalidate(rulesDir);
      }

      return respond(res, 200, result);
    } catch (err) {
      return respond(res, 500, { ok: false, error: err.message });
    }
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
      const elapsedMs = Number(elapsed) / 1e6;
      totalResponseTimeNs += elapsed;
      timedResponses++;
      res.setHeader('X-Response-Time', elapsedMs.toFixed(2) + 'ms');

      // Record audit entry for enforcement routes
      const hso = result && result.hookSpecificOutput;
      const decision = (hso && hso.permissionDecision) || 'allow';
      const toolName = (body && body.tool_name) || null;
      const filePath = (body && body.tool_input && body.tool_input.file_path) || null;
      // Count rules checked/matched from context
      const ctx = (!paused && process.env.SKILL_ENGINE_OFF !== '1') ? getRequestContext(body) : null;
      const rulesChecked = ctx ? ctx.compiledRules.length : 0;
      // Extract matched rule names from the reason string
      const rulesMatched = [];
      if (hso && hso.permissionDecisionReason) {
        // Reason contains rule name after "Blocked by rule: " or "Requires approval: "
        const reasonMatch = hso.permissionDecisionReason.match(/(?:Blocked by rule|Requires approval): (.+)/);
        if (reasonMatch) rulesMatched.push(reasonMatch[1]);
      }
      if (hso && hso.additionalContext) {
        // Warnings contain "⚠️ ruleName: description"
        const warnMatches = hso.additionalContext.matchAll(/⚠️ ([^:]+):/g);
        for (const wm of warnMatches) rulesMatched.push(wm[1].trim());
      }
      recordAuditEntry({
        timestamp: new Date().toISOString(),
        endpoint: url,
        tool: toolName,
        filePath,
        rulesChecked,
        rulesMatched,
        enforcement: decision,
        responseTimeMs: Math.round(elapsedMs * 100) / 100,
      });

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
  asyncEngine.shutdown();
  server.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
