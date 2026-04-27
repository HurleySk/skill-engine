'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// --- Shared utilities from rules-io.js / glob-match.js ---
const libDir = path.resolve(__dirname, '..', 'hooks', 'lib');
const { normalizePath, globToRegex, matchPath } = require(path.join(libDir, 'glob-match'));
const { loadRules, findRulesFile, findLearnedRulesFile } = require(path.join(libDir, 'rules-io'));

// --- CLI args ---
const args = process.argv.slice(2);
function argVal(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}
const PORT = parseInt(argVal('--port') || process.env.SKILL_ENGINE_PORT || '19750', 10);
let RULES_DIR = argVal('--rules-dir') || null;
let PROJECT_ROOT = null;

function deriveProjectRoot(rulesDir) {
  if (!rulesDir) return null;
  const normalized = normalizePath(rulesDir);
  const suffix = '/.claude/skills';
  if (normalized.endsWith(suffix)) return normalized.slice(0, -suffix.length);
  return normalizePath(path.dirname(path.dirname(rulesDir)));
}

function ruleMatchesProject(entry) {
  if (!entry.sourceRepo) return true;
  if (!PROJECT_ROOT) return true;
  return entry.sourceRepo === PROJECT_ROOT;
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

// --- Pre-compiled rule cache ---
let rulesData = null;     // merged { version, defaults, rules }
let compiledRules = [];   // [{ name, rule, intentRe[], keywordsLower[], pathRe[], exclRe[], contentRe[] }]
let hasToolTriggerRules = false;
let hasOutputTriggerRules = false;
let hasStopRules = false;

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

  hasToolTriggerRules = compiled.some(e => e.toolTriggerNamesSet || (e.inputRe && e.inputRe.length));
  hasOutputTriggerRules = compiled.some(e => e.outputToolNamesSet || (e.outputRe && e.outputRe.length));
  hasStopRules = compiled.some(e => e.hookEventsSet && e.hookEventsSet.has('Stop'));

  return compiled;
}

function loadAndCompile() {
  PROJECT_ROOT = deriveProjectRoot(RULES_DIR);
  let mainFile, learnedFile;
  if (RULES_DIR) {
    mainFile = path.join(RULES_DIR, 'skill-rules.json');
    learnedFile = path.join(RULES_DIR, 'learned-rules.json');
  } else {
    mainFile = findRulesFile(process.cwd());
    learnedFile = findLearnedRulesFile(process.cwd());
  }
  const mainData = loadRules(mainFile);
  const learnedData = loadRules(learnedFile);
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
  compiledRules = compileRules(rulesData);
  return compiledRules.length;
}

// --- Session tracking ---
const sessions = new Map(); // sessionId -> { firedRules: Set, lastSeen: number }

function getSession(sessionId) {
  if (!sessionId) return null;
  let s = sessions.get(sessionId);
  if (!s) {
    s = { firedRules: new Set(), lastSeen: Date.now() };
    sessions.set(sessionId, s);
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

function matchFileCompiled(filePath, entry) {
  const normalized = normalizePath(filePath);
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

  const session = getSession(input.session_id);
  const matches = [];

  for (const entry of compiledRules) {
    if (!ruleMatchesProject(entry)) continue;
    if (checkSkip(entry.name, entry.rule, session)) continue;
    if (!entry.keywordsLower && !entry.intentRe) continue;
    if (!matchPromptCompiled(prompt, entry)) continue;
    const priority = getPriority(entry.rule, rulesData.defaults);
    const enforcement = getEnforcement(entry.rule, rulesData.defaults);
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
    '\u26A1 Skill Engine \u2014 ' + count + ' relevant skill' + (count > 1 ? 's' : '') + ' detected:',
    ''
  ];
  for (const m of matches) {
    const typeLabel = m.rule.type === 'guardrail' ? ' (guardrail)' : '';
    lines.push('[' + m.priority.toUpperCase() + '] ' + m.name + typeLabel);
    lines.push('  ' + m.rule.description);
    if (m.rule.skillPath) lines.push('  \u2192 Read: ' + m.rule.skillPath);
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
  if (!hasToolTriggerRules) return {};
  const toolName = input && input.tool_name;
  const toolInput = input && input.tool_input;
  if (!toolName && !toolInput) return {};

  const inputStr = toolInput ? JSON.stringify(toolInput) : '';
  const session = getSession(input.session_id);
  const matches = [];

  for (const entry of compiledRules) {
    if (!ruleMatchesProject(entry)) continue;
    if (!entry.toolTriggerNamesSet && (!entry.inputRe || !entry.inputRe.length)) continue;
    if (entry.rule.type !== 'guardrail') continue;
    const enforcement = getEnforcement(entry.rule, rulesData.defaults);
    if (enforcement !== 'block' && enforcement !== 'warn') continue;
    if (checkSkip(entry.name, entry.rule, session)) continue;
    if (entry.toolTriggerNamesSet && toolName && !entry.toolTriggerNamesSet.has(toolName)) continue;
    if (entry.toolTriggerNamesSet && !toolName) continue;
    if (entry.inputRe && entry.inputRe.length && !entry.inputRe.some(re => re.test(inputStr))) continue;
    const priority = getPriority(entry.rule, rulesData.defaults);
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
    .map(m => '\u26A0\uFE0F ' + m.name + ': ' + m.rule.description);
  const joined = warnings.join('\n');
  if (joined) {
    return {
      systemMessage: joined,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow'
      }
    };
  }
  return {};
}

// --- Post-tool handler (PostToolUse) ---
function handlePostTool(input) {
  if (paused || process.env.SKILL_ENGINE_OFF === '1') return {};
  if (!hasOutputTriggerRules) return {};
  const toolName = input && input.tool_name;
  const toolOutput = input && input.tool_output;

  const outputStr = typeof toolOutput === 'string' ? toolOutput : (toolOutput ? JSON.stringify(toolOutput) : '');
  const session = getSession(input && input.session_id);
  const matches = [];

  for (const entry of compiledRules) {
    if (!ruleMatchesProject(entry)) continue;
    if (!entry.outputToolNamesSet && (!entry.outputRe || !entry.outputRe.length)) continue;
    if (checkSkip(entry.name, entry.rule, session)) continue;
    if (entry.outputToolNamesSet && toolName && !entry.outputToolNamesSet.has(toolName)) continue;
    if (entry.outputToolNamesSet && !toolName) continue;
    if (entry.outputRe && entry.outputRe.length && !entry.outputRe.some(re => re.test(outputStr))) continue;
    const priority = getPriority(entry.rule, rulesData.defaults);
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
  if (!hasStopRules) return {};

  const session = getSession(input && input.session_id);
  const matches = [];

  for (const entry of compiledRules) {
    if (!ruleMatchesProject(entry)) continue;
    if (!entry.hookEventsSet || !entry.hookEventsSet.has('Stop')) continue;
    if (checkSkip(entry.name, entry.rule, session)) continue;
    const priority = getPriority(entry.rule, rulesData.defaults);
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

  const session = getSession(input.session_id);
  const matches = [];

  for (const entry of compiledRules) {
    if (!ruleMatchesProject(entry)) continue;
    if (entry.rule.type !== 'guardrail') continue;
    const enforcement = getEnforcement(entry.rule, rulesData.defaults);
    if (enforcement !== 'block' && enforcement !== 'warn') continue;
    if (!entry.pathRe || !entry.pathRe.length) continue;
    if (checkSkip(entry.name, entry.rule, session)) continue;
    // Fail-open: if toolName is absent, still evaluate the rule (over-enforce > under-enforce for guardrails)
    if (entry.toolNamesSet && toolName && !entry.toolNamesSet.has(toolName)) continue;
    if (!matchFileCompiled(filePath, entry)) continue;
    const priority = getPriority(entry.rule, rulesData.defaults);
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
    .map(m => '\u26A0\uFE0F ' + m.name + ': ' + m.rule.description);
  const joined = warnings.join('\n');
  if (joined) {
    return {
      systemMessage: joined,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow'
      }
    };
  }
  return {};
}

// --- Stats ---
let eventsProcessed = 0;
let lastEvent = null;
let paused = false;

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
    const avgMs = timedResponses > 0
      ? Number(totalResponseTimeNs / BigInt(timedResponses)) / 1e6
      : 0;
    return respond(res, 200, {
      version: SERVER_VERSION,
      pid: process.pid,
      uptime: process.uptime(),
      rulesLoaded: compiledRules.length,
      port: PORT,
      lastEvent,
      eventsProcessed,
      activeSessions: sessions.size,
      avgResponseTimeMs: Math.round(avgMs * 100) / 100,
      paused,
      rulesDir: RULES_DIR || null,
      projectRoot: PROJECT_ROOT || null,
      hasToolTriggerRules,
      hasOutputTriggerRules,
      hasStopRules,
    });
  }

  if (method === 'POST' && url === '/activate') {
    try {
      const body = await readBody(req);
      eventsProcessed++;
      lastEvent = 'activate';
      const result = handleActivate(body);
      const elapsed = process.hrtime.bigint() - startNs;
      totalResponseTimeNs += elapsed;
      timedResponses++;
      res.setHeader('X-Response-Time', (Number(elapsed) / 1e6).toFixed(2) + 'ms');
      return respond(res, 200, result);
    } catch {
      return respond(res, 400, { error: 'Invalid JSON' });
    }
  }

  if (method === 'POST' && url === '/enforce') {
    try {
      const body = await readBody(req);
      eventsProcessed++;
      lastEvent = 'enforce';
      const result = handleEnforce(body);
      const elapsed = process.hrtime.bigint() - startNs;
      totalResponseTimeNs += elapsed;
      timedResponses++;
      res.setHeader('X-Response-Time', (Number(elapsed) / 1e6).toFixed(2) + 'ms');
      return respond(res, 200, result);
    } catch {
      return respond(res, 400, { error: 'Invalid JSON' });
    }
  }

  if (method === 'POST' && url === '/enforce-tool') {
    try {
      const body = await readBody(req);
      eventsProcessed++;
      lastEvent = 'enforce-tool';
      const result = handleEnforceTool(body);
      const elapsed = process.hrtime.bigint() - startNs;
      totalResponseTimeNs += elapsed;
      timedResponses++;
      res.setHeader('X-Response-Time', (Number(elapsed) / 1e6).toFixed(2) + 'ms');
      return respond(res, 200, result);
    } catch {
      return respond(res, 400, { error: 'Invalid JSON' });
    }
  }

  if (method === 'POST' && url === '/post-tool') {
    try {
      const body = await readBody(req);
      eventsProcessed++;
      lastEvent = 'post-tool';
      const result = handlePostTool(body);
      const elapsed = process.hrtime.bigint() - startNs;
      totalResponseTimeNs += elapsed;
      timedResponses++;
      res.setHeader('X-Response-Time', (Number(elapsed) / 1e6).toFixed(2) + 'ms');
      return respond(res, 200, result);
    } catch {
      return respond(res, 400, { error: 'Invalid JSON' });
    }
  }

  if (method === 'POST' && url === '/stop') {
    try {
      const body = await readBody(req);
      eventsProcessed++;
      lastEvent = 'stop';
      const result = handleStop(body);
      const elapsed = process.hrtime.bigint() - startNs;
      totalResponseTimeNs += elapsed;
      timedResponses++;
      res.setHeader('X-Response-Time', (Number(elapsed) / 1e6).toFixed(2) + 'ms');
      return respond(res, 200, result);
    } catch {
      return respond(res, 400, { error: 'Invalid JSON' });
    }
  }

  if (method === 'POST' && url === '/reload') {
    let body = null;
    try { body = await readBody(req); } catch {}
    if (body && body.rulesDir) {
      RULES_DIR = body.rulesDir;
    }
    const count = loadAndCompile();
    closeWatchers();
    activeWatchers = watchRuleFiles();
    eventsProcessed++;
    lastEvent = 'reload';
    return respond(res, 200, { reloaded: true, rulesLoaded: count, rulesDir: RULES_DIR || null });
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

// --- File watching for hot-reload ---
let activeWatchers = [];
function closeWatchers() {
  for (const w of activeWatchers) { try { w.close(); } catch {} }
  activeWatchers = [];
}
function watchRuleFiles() {
  const files = [];
  if (RULES_DIR) {
    files.push(path.join(RULES_DIR, 'skill-rules.json'));
    files.push(path.join(RULES_DIR, 'learned-rules.json'));
  } else {
    const mf = findRulesFile(process.cwd());
    if (mf) files.push(mf);
    const lf = findLearnedRulesFile(process.cwd());
    if (lf) files.push(lf);
  }

  const watchers = [];
  let debounce = null;
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    try {
      const w = fs.watch(f, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          loadAndCompile();
          debounce = null;
        }, 200);
      });
      w.unref();
      watchers.push(w);
    } catch {}
  }
  return watchers;
}

// --- Start ---
loadAndCompile();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    if (!res.writableEnded) respond(res, 500, { error: 'Internal error' });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('skill-engine server listening on port ' + PORT + '\n');
  activeWatchers = watchRuleFiles();
});

// Graceful shutdown
function shutdown() {
  clearInterval(cleanupInterval);
  server.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
