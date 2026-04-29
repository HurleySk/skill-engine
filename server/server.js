'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// --- Shared utilities from rules-io.js / glob-match.js ---
const libDir = path.resolve(__dirname, '..', 'hooks', 'lib');
const { normalizePath, globToRegex } = require(path.join(libDir, 'glob-match'));
const { loadRules } = require(path.join(libDir, 'rules-io'));
const { handlePreWrite: preWriteHandler } = require('./pre-write-safety');

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

// --- Self-upgrade: if a newer version exists in cache, re-exec into it ---
// Old start-server.sh versions (pre-3.2.7) have no semver guard and will
// happily start an ancient server.js, killing whatever was running. This
// check ensures that even if launched from a stale cache entry, the server
// always runs the newest available code.
if (!process.env.SKILL_ENGINE_UPGRADED) {
  const cacheBase = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.claude', 'plugins', 'cache', 'hurleysk-marketplace', 'skill-engine'
  );
  try {
    const versions = fs.readdirSync(cacheBase, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name))
      .map(d => d.name)
      .sort((a, b) => {
        const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] - pb[i]; }
        return 0;
      });
    const latest = versions[versions.length - 1];
    if (latest && latest !== SERVER_VERSION) {
      const lp = latest.split('.').map(Number), cp = SERVER_VERSION.split('.').map(Number);
      let newer = false;
      for (let i = 0; i < 3; i++) {
        if (lp[i] > cp[i]) { newer = true; break; }
        if (lp[i] < cp[i]) break;
      }
      if (newer) {
        const target = path.join(cacheBase, latest, 'server', 'server.js');
        if (fs.existsSync(target)) {
          const { spawn } = require('child_process');
          const child = spawn(process.execPath, [target, ...process.argv.slice(2)], {
            stdio: 'ignore', detached: true,
            env: { ...process.env, SKILL_ENGINE_UPGRADED: '1' }
          });
          child.unref();
          process.exit(0);
        }
      }
    }
  } catch {}
}

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

  getCachedState() {
    return {
      rulesDir: this._rulesDir,
      rulesLoaded: this._compiledRules.length,
      hasToolTriggerRules: this._hasToolTriggerRules,
      hasOutputTriggerRules: this._hasOutputTriggerRules,
      hasStopRules: this._hasStopRules,
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

// --- Project dir: updated by /set-project on each SessionStart ---
let lastProjectDir = process.env.CLAUDE_PROJECT_DIR || null;

// --- Per-request context helper ---
function getRequestContext(input) {
  let projectDir = null;
  if (input && input.env && input.env.CLAUDE_PROJECT_DIR) {
    projectDir = input.env.CLAUDE_PROJECT_DIR;
  } else {
    projectDir = lastProjectDir;
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

function sortBlockFirst(matches) {
  matches.sort((a, b) => {
    if (a.enforcement === 'block' && b.enforcement !== 'block') return -1;
    if (a.enforcement !== 'block' && b.enforcement === 'block') return 1;
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

// --- Activate handler ---
function handleActivate(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const prompt = input && input.prompt;
  if (!prompt) return {};
  const ctx = getRequestContext(input);
  const session = getSession(input.session_id, ctx.projectRoot);

  const matches = collectMatches(ctx.compiledRules, ctx.projectRoot, session, ctx.rulesData, (entry) => {
    if (!entry.keywordsLower && !entry.intentRe) return false;
    if (!matchPromptCompiled(prompt, entry)) return false;
    return {};
  });
  if (!matches.length) return {};
  sortByPriority(matches);
  recordSessionOnce(session, matches);

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
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lines.join('\n') } };
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

  const matches = collectMatches(ctx.compiledRules, ctx.projectRoot, session, ctx.rulesData, (entry, rd) => {
    if (!entry.toolTriggerNamesSet && (!entry.inputRe || !entry.inputRe.length)) return false;
    if (entry.rule.type !== 'guardrail') return false;
    const enforcement = getEnforcement(entry.rule, rd.defaults);
    if (enforcement !== 'block' && enforcement !== 'warn') return false;
    if (entry.toolTriggerNamesSet && toolName && !entry.toolTriggerNamesSet.has(toolName)) return false;
    if (entry.toolTriggerNamesSet && !toolName) return false;
    if (entry.inputRe && entry.inputRe.length && !entry.inputRe.some(re => re.test(inputStr))) return false;
    return { enforcement };
  });
  if (!matches.length) return {};
  sortBlockFirst(matches);

  const blockMatch = matches.find(m => m.enforcement === 'block');
  if (blockMatch) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: blockMatch.rule.blockMessage || ('Blocked by rule: ' + blockMatch.name)
      }
    };
  }
  const warnings = matches.filter(m => m.enforcement === 'warn').map(m => '⚠️ ' + m.name + ': ' + m.rule.description);
  const joined = warnings.join('\n');
  if (joined) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext: joined } };
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
  return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: lines.join('\n') } };
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

  const matches = collectMatches(ctx.compiledRules, ctx.projectRoot, session, ctx.rulesData, (entry, rd) => {
    if (entry.rule.type !== 'guardrail') return false;
    const enforcement = getEnforcement(entry.rule, rd.defaults);
    if (enforcement !== 'block' && enforcement !== 'warn') return false;
    if (!entry.pathRe || !entry.pathRe.length) return false;
    if (entry.toolNamesSet && toolName && !entry.toolNamesSet.has(toolName)) return false;
    if (!matchFileCompiled(filePath, entry, ctx.projectRoot, rd)) return false;
    if (writeContent && entry.contentRe && entry.contentRe.length > 0) {
      if (!entry.contentRe.some(re => re.test(writeContent))) return false;
    }
    return { enforcement };
  });
  if (!matches.length) return {};
  sortBlockFirst(matches);

  const blockMatch = matches.find(m => m.enforcement === 'block');
  if (blockMatch) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: blockMatch.rule.blockMessage || ('Blocked by rule: ' + blockMatch.name)
      }
    };
  }
  const warnings = matches.filter(m => m.enforcement === 'warn').map(m => '⚠️ ' + m.name + ': ' + m.rule.description);
  const joined = warnings.join('\n');
  if (joined) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext: joined } };
  }
  return {};
}

function handlePreWrite(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  const ctx = getRequestContext(input);
  return preWriteHandler(input, ctx.projectRoot);
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
    getRequestContext(null); // warm cache from process.env if not yet populated
    const cached = ruleCache.getCachedState();
    const avgMs = timedResponses > 0
      ? Number(totalResponseTimeNs / BigInt(timedResponses)) / 1e6
      : 0;
    return respond(res, 200, {
      version: SERVER_VERSION,
      pid: process.pid,
      uptime: process.uptime(),
      rulesLoaded: cached.rulesLoaded,
      port: PORT,
      lastEvent,
      eventsProcessed,
      activeSessions: sessions.size,
      avgResponseTimeMs: Math.round(avgMs * 100) / 100,
      paused,
      rulesDir: cached.rulesDir || null,
      hasToolTriggerRules: cached.hasToolTriggerRules,
      hasOutputTriggerRules: cached.hasOutputTriggerRules,
      hasStopRules: cached.hasStopRules,
    });
  }

  if (method === 'GET' && url === '/rules') {
    const ctx = getRequestContext(null);
    const rules = ctx.compiledRules.map(e => ({
      name: e.name,
      type: e.rule.type,
      enforcement: getEnforcement(e.rule, ctx.rulesData.defaults),
      priority: getPriority(e.rule, ctx.rulesData.defaults),
      description: e.rule.description,
      sourceRepo: e.sourceRepo || null,
      triggers: Object.keys(e.rule.triggers || {}),
      hookEvents: e.rule.hookEvents || null,
    }));
    return respond(res, 200, { projectDir: lastProjectDir, rulesDir: ctx.rulesDir, count: rules.length, rules });
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

  if (method === 'POST' && url === '/set-project') {
    let body = null;
    try { body = await readBody(req); } catch {}
    if (body && body.projectDir) {
      lastProjectDir = body.projectDir;
    }
    const ctx = getRequestContext(null);
    return respond(res, 200, { projectDir: lastProjectDir, rulesLoaded: ctx.compiledRules.length });
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
