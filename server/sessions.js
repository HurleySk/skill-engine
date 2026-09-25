'use strict';

const fs = require('fs');
const path = require('path');
const libDir = path.resolve(__dirname, '..', 'hooks', 'lib');
const { normalizePath } = require(path.join(libDir, 'glob-match'));
const { ruleCache, EMPTY_SNAPSHOT } = require('./rule-cache');

const STALE_MS = 30 * 60 * 1000;

const sessions = new Map();
let lastRegisteredSessionId = null;

function rulesDirFor(projectDir) {
  return projectDir + '/.claude/skills';
}

function touch(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { project: null, contexts: null, firedRules: new Map(), lastSeen: Date.now() };
    sessions.set(sessionId, s);
  }
  s.lastSeen = Date.now();
  return s;
}

function registered(sessionId) {
  const s = sessionId ? sessions.get(sessionId) : null;
  return s && s.project ? s : null;
}

function registerSession(sessionId, projectDir) {
  const normalizedDir = normalizePath(projectDir);
  const rulesDir = rulesDirFor(normalizedDir);
  const errors = [];
  if (!fs.existsSync(path.join(rulesDir, 'skill-rules.json')) && !fs.existsSync(path.join(rulesDir, 'learned-rules.json'))) {
    errors.push('No skill-rules.json or learned-rules.json found in ' + rulesDir);
  }
  const cached = ruleCache.getRules(rulesDir);
  touch(sessionId).project = { projectDir: normalizedDir, rulesDir, registeredAt: Date.now() };
  lastRegisteredSessionId = sessionId;
  return { sessionId, projectDir: normalizedDir, rulesDir, rulesLoaded: cached.compiledRules.length, errors };
}

function resolveProjectDir(input) {
  if (input && input.env && input.env.CLAUDE_PROJECT_DIR) return input.env.CLAUDE_PROJECT_DIR;
  const s = registered(input && input.session_id) || registered(lastRegisteredSessionId);
  if (s) {
    s.lastSeen = Date.now();
    return s.project.projectDir;
  }
  return process.env.CLAUDE_PROJECT_DIR || null;
}

function getRequestContext(input) {
  const projectDir = resolveProjectDir(input);
  if (!projectDir) return { projectRoot: null, rulesDir: null, ...EMPTY_SNAPSHOT };
  const projectRoot = normalizePath(projectDir);
  const rulesDir = rulesDirFor(projectRoot);
  return { projectRoot, rulesDir, ...ruleCache.getRules(rulesDir) };
}

function getSession(sessionId, projectRoot) {
  if (!sessionId) return null;
  const s = touch(sessionId);
  const key = projectRoot || '';
  if (!s.firedRules.has(key)) s.firedRules.set(key, new Set());
  return { firedRules: s.firedRules.get(key), contexts: s.contexts };
}

function addContexts(sessionId, tags) {
  if (!sessionId || !tags.length) return;
  const s = touch(sessionId);
  if (!s.contexts) s.contexts = new Set();
  for (const tag of tags) s.contexts.add(tag);
}

function getContexts(sessionId) {
  const s = sessionId ? sessions.get(sessionId) : null;
  return (s && s.contexts) || null;
}

function registeredSessions() {
  const out = new Map();
  for (const [id, s] of sessions) {
    if (s.project) out.set(id, { ...s.project, lastRequest: s.lastSeen });
  }
  return out;
}

function allContexts() {
  const out = {};
  for (const [id, s] of sessions) {
    if (s.contexts) out[id] = [...s.contexts];
  }
  return out;
}

function cleanStaleSessions() {
  const cutoff = Date.now() - STALE_MS;
  for (const [id, s] of sessions) {
    if (s.lastSeen >= cutoff) continue;
    sessions.delete(id);
    if (lastRegisteredSessionId === id) lastRegisteredSessionId = null;
  }
  return new Set([...sessions.keys()].filter(id => sessions.get(id).project));
}

module.exports = {
  registerSession, getRequestContext, getSession, addContexts, getContexts,
  registeredSessions, allContexts, cleanStaleSessions,
};
