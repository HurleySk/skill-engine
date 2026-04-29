'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// --- Shared utilities from rules-io.js / glob-match.js ---
const libDir = path.resolve(__dirname, '..', 'hooks', 'lib');
const { normalizePath, globToRegex } = require(path.join(libDir, 'glob-match'));
const { loadRules } = require(path.join(libDir, 'rules-io'));

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
  return rule.enforcement || (defaults && defaults.enforcement) || 'suggest';
}

// --- RuleCache class (mtime-based, stateless per-request) ---
class RuleCache {
  constructor() {
    this._rulesDir = null;
    this._mainMtime = null;
    this._learnedMtime = null;
    this._compiledRules = [];
    this._rulesData = null;
    this._hasToolTriggerRules = false;
    this._hasOutputTriggerRules = false;
    this._hasStopRules = false;
  }

  _getMtime(filePath) {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
  }

  getRules(rulesDir) {
    if (!rulesDir) {
      return {
        compiledRules: [],
        rulesData: { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {} },
        hasToolTriggerRules: false,
        hasOutputTriggerRules: false,
        hasStopRules: false,
      };
    }
    const mainFile = path.join(rulesDir, 'skill-rules.json');
    const learnedFile = path.join(rulesDir, 'learned-rules.json');
    const mainMtime = this._getMtime(mainFile);
    const learnedMtime = this._getMtime(learnedFile);

    // If same rulesDir and mtimes unchanged, return cached data
    if (
      rulesDir === this._rulesDir &&
      mainMtime === this._mainMtime &&
      learnedMtime === this._learnedMtime
    ) {
      return {
        compiledRules: this._compiledRules,
        rulesData: this._rulesData,
        hasToolTriggerRules: this._hasToolTriggerRules,
        hasOutputTriggerRules: this._hasOutputTriggerRules,
        hasStopRules: this._hasStopRules,
      };
    }

    // Recompile
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

    // Compute tri-state flags
    const hasToolTriggerRules = compiled.some(e => e.toolTriggerNamesSet || (e.inputRe && e.inputRe.length));
    const hasOutputTriggerRules = compiled.some(e => e.outputToolNamesSet || (e.outputRe && e.outputRe.length));
    const hasStopRules = compiled.some(e => e.hookEventsSet && e.hookEventsSet.has('Stop'));

    // Cache
    this._rulesDir = rulesDir;
    this._mainMtime = mainMtime;
    this._learnedMtime = learnedMtime;
    this._compiledRules = compiled;
    this._rulesData = rulesData;
    this._hasToolTriggerRules = hasToolTriggerRules;
    this._hasOutputTriggerRules = hasOutputTriggerRules;
    this._hasStopRules = hasStopRules;

    return {
      compiledRules: compiled,
      rulesData,
      hasToolTriggerRules,
      hasOutputTriggerRules,
      hasStopRules,
    };
  }
}

const ruleCache = new RuleCache();

// --- Per-request context helper ---
function getRequestContext(input) {
  // Extract CLAUDE_PROJECT_DIR from input.env (first) or process.env (fallback)
  let projectDir = null;
  if (input && input.env && input.env.CLAUDE_PROJECT_DIR) {
    projectDir = input.env.CLAUDE_PROJECT_DIR;
  } else if (process.env.CLAUDE_PROJECT_DIR) {
    projectDir = process.env.CLAUDE_PROJECT_DIR;
  }

  if (!projectDir) {
    // No project dir available — return empty context
    return {
      projectRoot: null,
      rulesDir: null,
      compiledRules: [],
      rulesData: { version: '1.0', defaults: { enforcement: 'suggest', priority: 'medium' }, rules: {} },
      hasToolTriggerRules: false,
      hasOutputTriggerRules: false,
      hasStopRules: false,
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
  const enforcement = getEnforcement(entry.rule, rulesData.defaults);
  if (enforcement === 'block' && entry.contentRe && entry.contentRe.length) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return entry.contentRe.some(re => re.test(content));
    } catch { return false; }
  }
  return true;
}

// --- Activate handler ---
function handleActivate(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const prompt = input && input.prompt;
  if (!prompt) return {};

  const ctx = getRequestContext(input);
  const session = getSession(input.session_id, ctx.projectRoot);
  const matches = [];

  for (const entry of ctx.compiledRules) {
    if (!ruleMatchesProject(entry, ctx.projectRoot)) continue;
    if (checkSkip(entry.name, entry.rule, session)) continue;
    if (!entry.keywordsLower && !entry.intentRe) continue;
    if (!matchPromptCompiled(prompt, entry)) continue;
    const priority = getPriority(entry.rule, ctx.rulesData.defaults);
    const enforcement = getEnforcement(entry.rule, ctx.rulesData.defaults);
    matches.push({ name: entry.name, rule: entry.rule, priority, enforcement });
  }

  if (!matches.length) return {};

  matches.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));

  // Record sessionOnce
  if (session) {
    for (const m of matches) {
      if (m.rule.skipConditions && m.rule.skipConditions.sessionOnce) {
        session.firedRules.add(m.name);
      }
    }
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
    if (m.rule.skillPath) lines.push('  → Read: ' + m.rule.skillPath);
    lines.push('');
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: lines.join('\n')
    }
  };
}

// --- Enforce-tool handler (PreToolUse for any tool) ---
function handleEnforceTool(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const ctx = getRequestContext(input);
  if (!ctx.hasToolTriggerRules) return {};
  const toolName = input && input.tool_name;
  const toolInput = input && input.tool_input;
  if (!toolName && !toolInput) return {};

  const inputStr = toolInput ? JSON.stringify(toolInput) : '';
  const session = getSession(input.session_id, ctx.projectRoot);
  const matches = [];

  for (const entry of ctx.compiledRules) {
    if (!ruleMatchesProject(entry, ctx.projectRoot)) continue;
    if (!entry.toolTriggerNamesSet && (!entry.inputRe || !entry.inputRe.length)) continue;
    if (entry.rule.type !== 'guardrail') continue;
    const enforcement = getEnforcement(entry.rule, ctx.rulesData.defaults);
    if (enforcement !== 'block' && enforcement !== 'warn') continue;
    if (checkSkip(entry.name, entry.rule, session)) continue;
    if (entry.toolTriggerNamesSet && toolName && !entry.toolTriggerNamesSet.has(toolName)) continue;
    if (entry.toolTriggerNamesSet && !toolName) continue;
    if (entry.inputRe && entry.inputRe.length && !entry.inputRe.some(re => re.test(inputStr))) continue;
    const priority = getPriority(entry.rule, ctx.rulesData.defaults);
    matches.push({ name: entry.name, rule: entry.rule, priority, enforcement });
  }

  if (!matches.length) return {};

  matches.sort((a, b) => {
    if (a.enforcement === 'block' && b.enforcement !== 'block') return -1;
    if (a.enforcement !== 'block' && b.enforcement === 'block') return 1;
    return (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2);
  });

  const blockMatch = matches.find(m => m.enforcement === 'block');
  if (blockMatch) {
    const reason = blockMatch.rule.blockMessage || ('Blocked by rule: ' + blockMatch.name);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason
      }
    };
  }

  const warnings = matches
    .filter(m => m.enforcement === 'warn')
    .map(m => '⚠️ ' + m.name + ': ' + m.rule.description);
  const joined = warnings.join('\n');
  if (joined) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext: joined
      }
    };
  }
  return {};
}

// --- Post-tool handler (PostToolUse) ---
function handlePostTool(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const ctx = getRequestContext(input);
  if (!ctx.hasOutputTriggerRules) return {};
  const toolName = input && input.tool_name;
  const toolOutput = input && input.tool_output;

  const outputStr = typeof toolOutput === 'string' ? toolOutput : (toolOutput ? JSON.stringify(toolOutput) : '');
  const session = getSession(input && input.session_id, ctx.projectRoot);
  const matches = [];

  for (const entry of ctx.compiledRules) {
    if (!ruleMatchesProject(entry, ctx.projectRoot)) continue;
    if (!entry.outputToolNamesSet && (!entry.outputRe || !entry.outputRe.length)) continue;
    if (checkSkip(entry.name, entry.rule, session)) continue;
    if (entry.outputToolNamesSet && toolName && !entry.outputToolNamesSet.has(toolName)) continue;
    if (entry.outputToolNamesSet && !toolName) continue;
    if (entry.outputRe && entry.outputRe.length && !entry.outputRe.some(re => re.test(outputStr))) continue;
    const priority = getPriority(entry.rule, ctx.rulesData.defaults);
    matches.push({ name: entry.name, rule: entry.rule, priority });
  }

  if (!matches.length) return {};

  matches.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));

  if (session) {
    for (const m of matches) {
      if (m.rule.skipConditions && m.rule.skipConditions.sessionOnce) {
        session.firedRules.add(m.name);
      }
    }
  }

  const lines = matches.map(m => m.rule.guidance || m.rule.description);
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: lines.join('\n')
    }
  };
}

// --- Stop handler ---
function handleStop(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const ctx = getRequestContext(input);
  if (!ctx.hasStopRules) return {};

  const session = getSession(input && input.session_id, ctx.projectRoot);
  const matches = [];

  for (const entry of ctx.compiledRules) {
    if (!ruleMatchesProject(entry, ctx.projectRoot)) continue;
    if (!entry.hookEventsSet || !entry.hookEventsSet.has('Stop')) continue;
    if (checkSkip(entry.name, entry.rule, session)) continue;
    const priority = getPriority(entry.rule, ctx.rulesData.defaults);
    matches.push({ name: entry.name, rule: entry.rule, priority });
  }

  if (!matches.length) return {};

  matches.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));

  if (session) {
    for (const m of matches) {
      if (m.rule.skipConditions && m.rule.skipConditions.sessionOnce) {
        session.firedRules.add(m.name);
      }
    }
  }

  const lines = matches.map(m => m.rule.guidance || m.rule.description);
  return {
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: lines.join('\n')
    }
  };
}

// --- Enforce handler ---
function handleEnforce(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const filePath = input && input.tool_input && input.tool_input.file_path;
  if (!filePath) return {};
  const toolName = input && input.tool_name;
  const writeContent = input && input.tool_input && (input.tool_input.content || input.tool_input.new_string || '');

  const ctx = getRequestContext(input);
  const session = getSession(input.session_id, ctx.projectRoot);
  const matches = [];

  for (const entry of ctx.compiledRules) {
    if (!ruleMatchesProject(entry, ctx.projectRoot)) continue;
    if (entry.rule.type !== 'guardrail') continue;
    const enforcement = getEnforcement(entry.rule, ctx.rulesData.defaults);
    if (enforcement !== 'block' && enforcement !== 'warn') continue;
    if (!entry.pathRe || !entry.pathRe.length) continue;
    if (checkSkip(entry.name, entry.rule, session)) continue;
    if (entry.toolNamesSet && toolName && !entry.toolNamesSet.has(toolName)) continue;
    if (!matchFileCompiled(filePath, entry, ctx.projectRoot, ctx.rulesData)) continue;
    // Check content patterns against the content being written (if provided)
    if (writeContent && entry.contentRe && entry.contentRe.length > 0) {
      if (!entry.contentRe.some(re => re.test(writeContent))) continue;
    }
    const priority = getPriority(entry.rule, ctx.rulesData.defaults);
    matches.push({ name: entry.name, rule: entry.rule, priority, enforcement });
  }

  if (!matches.length) return {};

  matches.sort((a, b) => {
    if (a.enforcement === 'block' && b.enforcement !== 'block') return -1;
    if (a.enforcement !== 'block' && b.enforcement === 'block') return 1;
    return (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2);
  });

  const blockMatch = matches.find(m => m.enforcement === 'block');
  if (blockMatch) {
    const reason = blockMatch.rule.blockMessage || ('Blocked by rule: ' + blockMatch.name);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason
      }
    };
  }

  const warnings = matches
    .filter(m => m.enforcement === 'warn')
    .map(m => '⚠️ ' + m.name + ': ' + m.rule.description);
  const joined = warnings.join('\n');
  if (joined) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext: joined
      }
    };
  }
  return {};
}

// --- Pre-write safety handler (ported from boomerang pre-write.sh) ---
const DEFAULT_SAFETY_RULES = {
  prodFactories: ['prd'],
  prodConnections: ['prd', 'ferconlineprod'],
  prodEnvironments: ['ferc', 'spprod', 'PRODSPO', 'hotlineprod', 'doidms', 'galprod'],
  prodDeployStepTypes: ['adf-deploy-pipeline', 'sql-deploy-sp', 'adf-run-pipeline', 'adf-run-and-wait', 'adf-sandbox-run-and-wait'],
  prodMutationStepTypes: ['sql-deploy-sp'],
  prodUriPatterns: [
    'ferc.crm9.dynamics.com', 'almsptier3prod.crm9.dynamics.com', 'orgc37aa7be.crm9.dynamics.com',
    'hotlineprod.crm9.dynamics.com', 'doidms.crm9.dynamics.com', 'galprod.crm9.dynamics.com',
    'fercalmstagingprd.database.usgovcloudapi.net', 'FDC1S-FOLSQLP2'
  ],
  devRevertAllowedFactories: ['dev1'],
  blockedExportBranches: ['main', 'master'],
  readOnlyStepTypes: [
    'sql-query', 'sql-file', 'dataverse-query', 'dataverse-file',
    'schema-pull', 'schema-index', 'adf-pull', 'adf-pull-all',
    'sql-schema-pull', 'sql-schema-pull-all', 'work-repo-diff',
    'adf-query-runs', 'adf-activity-errors', 'adf-trigger-status',
    'adf-export-errors', 'adf-trace-run'
  ],
  prodUriRegex: 'ferc\\.crm9|hotlineprod\\.crm9|doidms\\.crm9|galprod\\.crm9|orgc37aa7be\\.crm9|almsptier3prod\\.crm9',
  prodNameRegex: '\\bprod\\b|PRODSPO|spprod'
};

function loadSafetyRules(projectDir) {
  if (!projectDir) return DEFAULT_SAFETY_RULES;
  const rulesPath = path.join(projectDir, '.claude', 'safety-rules.json');
  try {
    const data = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    // Merge with defaults — each field falls back to default if missing
    const merged = {};
    for (const key of Object.keys(DEFAULT_SAFETY_RULES)) {
      merged[key] = data[key] != null ? data[key] : DEFAULT_SAFETY_RULES[key];
    }
    return merged;
  } catch {
    return DEFAULT_SAFETY_RULES;
  }
}

function preWriteDeny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'SAFETY: ' + reason
    }
  };
}

function preWriteAsk(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'SAFETY: ' + reason
    }
  };
}

function validateTaskSteps(content, rules, projectDir) {
  let task;
  try {
    task = JSON.parse(content);
  } catch {
    return null; // Malformed JSON — allow (same as shell script)
  }

  const steps = task.steps || [];
  const prodFactories = rules.prodFactories || [];
  const prodConns = rules.prodConnections || [];
  const prodEnvs = rules.prodEnvironments || [];
  const prodDeployTypes = rules.prodDeployStepTypes || [];
  const prodMutationTypes = rules.prodMutationStepTypes || [];
  const prodUriPatterns = rules.prodUriPatterns || [];
  const devRevertAllowed = rules.devRevertAllowedFactories || [];
  const readOnly = rules.readOnlyStepTypes || [];
  const blockedBranches = rules.blockedExportBranches || [];
  const prodUriRe = new RegExp(rules.prodUriRegex || '', 'i');

  // Load connections.json for URI resolution
  let dvEnvs = {};
  if (projectDir) {
    try {
      const connPath = path.join(projectDir, 'connections.json');
      const connData = JSON.parse(fs.readFileSync(connPath, 'utf8'));
      dvEnvs = connData.dataverse || {};
    } catch {}
  }

  function envUriIsProd(envName) {
    const env = dvEnvs[envName];
    if (!env || !env.url) return false;
    return prodUriPatterns.some(p => env.url.toLowerCase().includes(p.toLowerCase()));
  }

  for (const s of steps) {
    const ty = s.type || '';

    // Read-only SQL query with DML/DDL check
    if (ty === 'sql-query' && s.connection && prodConns.includes(s.connection)) {
      if (s.sql && /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|EXEC)\b/i.test(s.sql)) {
        return { decision: 'deny', reason: 'Step ' + ty + ' contains DML/DDL targeting production connection ' + s.connection };
      }
      return { decision: 'ask', reason: 'Step ' + ty + ' targets production connection ' + s.connection };
    }

    if (readOnly.includes(ty)) continue;

    // dev-revert factory check
    if (ty === 'dev-revert' && s.factory && !devRevertAllowed.includes(s.factory)) {
      return { decision: 'deny', reason: 'dev-revert only allowed against factory ' + devRevertAllowed.join('/') + ' -- not ' + s.factory };
    }

    // Factory check
    if (s.factory && prodFactories.includes(s.factory)) {
      if (prodDeployTypes.includes(ty)) {
        return { decision: 'deny', reason: 'Step ' + ty + ' targets production factory ' + s.factory };
      }
      return { decision: 'ask', reason: 'Step ' + ty + ' targets production factory ' + s.factory };
    }

    // Connection check
    if (s.connection && prodConns.includes(s.connection)) {
      if (prodMutationTypes.includes(ty) || prodDeployTypes.includes(ty)) {
        return { decision: 'deny', reason: 'Step ' + ty + ' targets production connection ' + s.connection };
      }
      return { decision: 'ask', reason: 'Step ' + ty + ' targets production connection ' + s.connection };
    }

    // Environment check
    if (s.environment && prodEnvs.includes(s.environment)) {
      return { decision: 'deny', reason: 'Step ' + ty + ' targets production environment ' + s.environment };
    }

    // URI-based environment check
    if (s.environment && envUriIsProd(s.environment)) {
      return { decision: 'deny', reason: 'Step ' + ty + ' targets environment ' + s.environment + ' (resolves to prod URI)' };
    }

    // run-script file content check
    if (ty === 'run-script' && s.file && projectDir) {
      try {
        const scriptPath = path.resolve(projectDir, s.file);
        if (fs.existsSync(scriptPath)) {
          const scriptContent = fs.readFileSync(scriptPath, 'utf8');
          if (prodUriRe.test(scriptContent)) {
            return { decision: 'ask', reason: 'Script ' + s.file + ' contains production URI patterns' };
          }
        }
      } catch {}
    }

    // work-repo-export branch check
    if (ty === 'work-repo-export' && s.branch && blockedBranches.includes(s.branch)) {
      return { decision: 'deny', reason: 'work-repo-export targets blocked branch ' + s.branch + ' -- use a feature branch' };
    }
  }

  return null; // All steps OK
}

function validateSecurityModelConfig(content, rules) {
  const prodUriRe = new RegExp(rules.prodUriRegex || DEFAULT_SAFETY_RULES.prodUriRegex, 'i');
  const prodNameRe = new RegExp(rules.prodNameRegex || DEFAULT_SAFETY_RULES.prodNameRegex, 'i');

  // Extract (env_name, dv_name, _, uri) tuples from SQL INSERT VALUES
  const tupleRe = /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'/g;
  let m;
  while ((m = tupleRe.exec(content)) !== null) {
    const envName = m[1];
    const dvName = m[2];
    const svcUri = m[4];

    const isProdOrg = prodNameRe.test(dvName) || prodUriRe.test(svcUri);

    if (isProdOrg) {
      if (envName === 'prod') {
        // OK
      } else if (envName === 'dataqa') {
        return { decision: 'ask', reason: "Prod org '" + dvName + "' under environment_name='dataqa' — confirm this is intentional." };
      } else {
        return { decision: 'deny', reason: "Prod org '" + dvName + "' (URI: " + svcUri + ") under environment_name='" + envName + "' — must be under 'prod'" };
      }
    }

    // Dev URI under prod env check
    if (/dev\.crm9|almwave3|almappdev1|lms-dev/i.test(svcUri)) {
      if (envName === 'prod') {
        return { decision: 'deny', reason: "Dev URI '" + svcUri + "' under environment_name='prod' — wrong environment" };
      }
    }
  }

  return null; // All tuples OK
}

function handlePreWrite(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};

  const toolInput = input && input.tool_input;
  if (!toolInput) return {};

  const filePath = toolInput.file_path || toolInput.file || '';
  if (!filePath) return {};

  // Normalize to forward slashes
  const normalized = normalizePath(filePath);

  // Get relative path by stripping up to the project dir
  const ctx = getRequestContext(input);
  let relPath = normalized;
  const projectDir = ctx.projectRoot;
  if (projectDir) {
    const rootTest = IS_WIN ? projectDir.toLowerCase() : projectDir;
    const pathTest = IS_WIN ? normalized.toLowerCase() : normalized;
    if (pathTest.startsWith(rootTest + '/')) {
      relPath = normalized.slice(projectDir.length + 1);
    }
  }

  // Fast exit: only inspect risky paths
  let check = null;
  if (/^tasks\/.*\.json$/.test(relPath)) {
    check = 'task';
  } else if (/work-repo-staging\/.*ADFCreateAndPopulateSecurityModelConfig/.test(relPath)) {
    check = 'secmodel';
  }

  if (!check) return {};

  // Extract content from the tool input
  const content = toolInput.content || toolInput.new_string || '';
  if (!content) return {};

  // Load safety rules from project dir
  const rules = loadSafetyRules(projectDir);

  if (check === 'task') {
    const result = validateTaskSteps(content, rules, projectDir);
    if (result) {
      return result.decision === 'deny' ? preWriteDeny(result.reason) : preWriteAsk(result.reason);
    }
  }

  if (check === 'secmodel') {
    const result = validateSecurityModelConfig(content, rules);
    if (result) {
      return result.decision === 'deny' ? preWriteDeny(result.reason) : preWriteAsk(result.reason);
    }
  }

  return {};
}

// --- Stats ---
let eventsProcessed = 0;
let lastEvent = null;
let paused = false;

// --- Route table ---
const routes = {
  '/activate':     { handler: handleActivate,    event: 'activate' },
  '/enforce':      { handler: handleEnforce,     event: 'enforce' },
  '/enforce-tool': { handler: handleEnforceTool, event: 'enforce-tool' },
  '/post-tool':    { handler: handlePostTool,    event: 'post-tool' },
  '/pre-write':    { handler: handlePreWrite,    event: 'pre-write' },
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
    const avgMs = timedResponses > 0
      ? Number(totalResponseTimeNs / BigInt(timedResponses)) / 1e6
      : 0;
    return respond(res, 200, {
      version: SERVER_VERSION,
      pid: process.pid,
      uptime: process.uptime(),
      rulesLoaded: ctx.compiledRules.length,
      port: PORT,
      lastEvent,
      eventsProcessed,
      activeSessions: sessions.size,
      avgResponseTimeMs: Math.round(avgMs * 100) / 100,
      paused,
      rulesDir: ctx.rulesDir || null,
      projectRoot: ctx.projectRoot || null,
      hasToolTriggerRules: ctx.hasToolTriggerRules,
      hasOutputTriggerRules: ctx.hasOutputTriggerRules,
      hasStopRules: ctx.hasStopRules,
    });
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
  server.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
