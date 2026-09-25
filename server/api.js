'use strict';

const fs = require('fs');
const path = require('path');
const libDir = path.resolve(__dirname, '..', 'hooks', 'lib');
const learnLib = require(path.join(libDir, 'learn'));
const asyncEngine = require('./async/engine');
const skillFeedback = require('./skill-feedback');
const { ruleCache } = require('./rule-cache');
const sessions = require('./sessions');
const stats = require('./stats');
const {
  getEnforcement, getPriority, ruleMatchesProject, matchFilePath, matchFileContent, ruleMessage,
} = require('./match');

function describeRule(e, defaults) {
  return {
    name: e.name,
    type: e.rule.type,
    enforcement: getEnforcement(e.rule, defaults),
    priority: getPriority(e.rule, defaults),
    description: e.rule.description,
    sourceRepo: e.sourceRepo || null,
    triggers: Object.keys(e.rule.triggers || {}),
    hookEvents: e.rule.hookEvents || null,
    compiledPatterns: e._compiledPatterns || {},
  };
}

function health({ port, version }) {
  const ctx = sessions.getRequestContext(null);
  const sessionsObj = {};
  for (const [sid, entry] of sessions.registeredSessions()) {
    sessionsObj[sid] = {
      projectDir: entry.projectDir,
      rulesDir: entry.rulesDir,
      rulesLoaded: ruleCache.getRules(entry.rulesDir).compiledRules.length,
      registeredAt: new Date(entry.registeredAt).toISOString(),
      lastRequest: new Date(entry.lastRequest).toISOString(),
    };
  }
  return [200, {
    version,
    cacheDir: path.resolve(__dirname, '..'),
    pid: process.pid,
    uptime: process.uptime(),
    rulesLoaded: ctx.compiledRules.length,
    port,
    lastEvent: stats.state.lastEvent,
    eventsProcessed: stats.state.eventsProcessed,
    activeSessions: Object.keys(sessionsObj).length,
    avgResponseTimeMs: stats.avgResponseMs(),
    paused: stats.state.paused,
    rulesDir: ctx.rulesDir || null,
    hasToolTriggerRules: ctx.hasToolTriggerRules,
    hasOutputTriggerRules: ctx.hasOutputTriggerRules,
    hasStopRules: ctx.hasStopRules,
    hasAsyncRules: ctx.hasAsyncRules,
    async: asyncEngine.getStatus(),
    sessions: sessionsObj,
    sessionContexts: sessions.allContexts(),
    cache: ruleCache.getCachedState(),
    auditLog: stats.auditSummary(),
    compilationWarnings: { count: ctx.compilationWarnings.length, details: ctx.compilationWarnings },
  }];
}

function rules({ params }) {
  const registered = sessions.registeredSessions();
  const sessionFilter = params.get('session');
  const entry = sessionFilter && registered.get(sessionFilter);
  if (entry) {
    const cached = ruleCache.getRules(entry.rulesDir);
    const list = cached.compiledRules.map(e => describeRule(e, cached.rulesData.defaults));
    return [200, {
      session: sessionFilter,
      projectDir: entry.projectDir,
      rulesDir: entry.rulesDir,
      count: list.length,
      compilationWarnings: cached.compilationWarnings.filter(w => list.some(r => r.name === w.ruleName)),
      rules: list,
    }];
  }

  const allRules = [];
  const allWarnings = [];
  for (const [sid, e] of registered) {
    const cached = ruleCache.getRules(e.rulesDir);
    for (const c of cached.compiledRules) {
      allRules.push({ session: sid, projectDir: e.projectDir, ...describeRule(c, cached.rulesData.defaults) });
    }
    allWarnings.push(...cached.compilationWarnings.map(w => ({ session: sid, ...w })));
  }
  return [200, { count: allRules.length, compilationWarnings: allWarnings, rules: allRules }];
}

function briefing({ params }) {
  const context = params.get('context');
  if (!context) return [400, { error: 'context parameter required' }];
  const ctx = sessions.getRequestContext(null);
  if (!ctx.rulesDir) return [500, { error: 'No project registered' }];
  const fileList = (ctx.rulesData.briefings || {})[context];
  if (!Array.isArray(fileList)) return [404, { error: 'Unknown context: ' + context }];

  const sections = ['# Subagent Briefing: ' + context, ''];
  for (const fileName of fileList) {
    try {
      sections.push(fs.readFileSync(path.join(ctx.rulesDir, context, fileName), 'utf8').trim(), '');
    } catch {}
  }
  const guardrails = ctx.compiledRules
    .filter(e => e.rule.type === 'guardrail' && (e.rule.guidance || e.rule.description))
    .map(e => '- **' + e.name + ':** ' + (e.rule.guidance || e.rule.description));
  if (guardrails.length) sections.push('## Active Guardrails', '', guardrails.join('\n'), '');
  return [200, { context, briefing: sections.join('\n') }];
}

function skillFeedbackSignals({ params }) {
  const sessionId = params.get('sessionId');
  const skillName = params.get('skillName');
  const type = params.get('type') || undefined;
  let signals;
  if (sessionId) {
    signals = skillFeedback.getSignalsForSession(sessionId, { type });
    if (skillName) signals = signals.filter(s => s.skillName === skillName);
  } else if (skillName) {
    signals = skillFeedback.getSignalsForSkill(skillName);
    if (type) signals = signals.filter(s => s.type === type);
  } else {
    signals = skillFeedback.getAllSignals({ type });
  }
  return [200, signals];
}

function recordSkillFeedback({ body }) {
  if (!body || !body.skillName) return [400, { error: 'skillName required' }];
  return [200, skillFeedback.recordSignal(body)];
}

function clearSkillFeedback({ body }) {
  if (!body || !body.skillName) return [400, { error: 'skillName required' }];
  skillFeedback.clearSkill(body.skillName);
  return [200, { cleared: true }];
}

function testRule({ body }) {
  if (!body) return [400, { error: 'Request body required' }];
  const ctx = sessions.getRequestContext(body);
  if (!ctx.projectRoot) return [400, { error: 'No project registered — cannot resolve rules' }];
  const simulatedPath = body.simulatedPath || null;
  const simulatedContent = body.simulatedContent || '';

  function test(entry) {
    const enforcement = getEnforcement(entry.rule, ctx.rulesData.defaults);
    const result = { name: entry.name, matched: false, pathMatched: false, contentMatched: false, enforcement, message: null };
    if (!simulatedPath || !matchFilePath(simulatedPath, entry, ctx.projectRoot)) return result;
    result.pathMatched = true;
    if (!matchFileContent(entry, () => simulatedContent)) return result;
    result.contentMatched = true;
    result.matched = true;
    if (enforcement === 'block' || enforcement === 'ask' || enforcement === 'warn') {
      result.message = ruleMessage(entry.name, entry.rule, enforcement);
    }
    return result;
  }

  if (body.ruleName) {
    const entry = ctx.compiledRules.find(e => e.name === body.ruleName);
    if (!entry) return [404, { error: 'Rule not found: ' + body.ruleName }];
    return [200, test(entry)];
  }
  return [200, ctx.compiledRules.filter(e => ruleMatchesProject(e, ctx.projectRoot)).map(test).filter(r => r.matched)];
}

const LEARN_ACTIONS = {
  add: (b, file, ctx) => b.name && b.rule ? learnLib.add(b.name, b.rule, file, ctx.projectRoot) : 'name and rule required for add',
  update: (b, file) => b.name && b.rule ? learnLib.update(b.name, b.rule, file) : 'name and rule required for update',
  remove: (b, file) => b.name ? learnLib.remove(b.name, file) : 'name required for remove',
  promote: (b, file, ctx) => b.name
    ? learnLib.promote(b.name, file, b.toFile || path.join(ctx.rulesDir, 'skill-rules.json'))
    : 'name required for promote',
  list: (b, file) => learnLib.list(file),
};

function learn({ body }) {
  if (!body || !body.action) return [400, { error: 'action field required (add, update, remove, promote, list)' }];
  const ctx = sessions.getRequestContext(body);
  if (!ctx.rulesDir) return [400, { error: 'No session registered — cannot resolve rulesDir' }];
  const action = LEARN_ACTIONS[body.action];
  if (!action) {
    return [400, { error: 'Unknown action: ' + body.action + '. Use add, update, remove, promote, or list.' }];
  }
  try {
    const result = action(body, path.join(ctx.rulesDir, 'learned-rules.json'), ctx);
    if (typeof result === 'string') return [400, { error: result }];
    if (result && result.ok && body.action !== 'list') ruleCache.invalidate(ctx.rulesDir);
    return [200, result];
  } catch (err) {
    return [500, { ok: false, error: err.message }];
  }
}

function registerSession({ body }) {
  if (!body || !body.sessionId || !body.projectDir) return [400, { error: 'sessionId and projectDir required' }];
  return [200, sessions.registerSession(body.sessionId, body.projectDir)];
}

function setPaused(paused) {
  return () => {
    stats.state.paused = paused;
    return [200, { paused }];
  };
}

module.exports = {
  'GET /health': health,
  'GET /rules': rules,
  'GET /briefing': briefing,
  'GET /skill-health': () => [200, skillFeedback.getHealth()],
  'GET /skill-feedback/signals': skillFeedbackSignals,
  'GET /audit-log': () => [200, stats.auditEntries()],
  'POST /skill-feedback': recordSkillFeedback,
  'POST /skill-feedback/clear': clearSkillFeedback,
  'POST /test-rule': testRule,
  'POST /learn': learn,
  'POST /register-session': registerSession,
  'POST /pause': setPaused(true),
  'POST /resume': setPaused(false),
};
