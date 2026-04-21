'use strict';

const fs = require('fs');
const path = require('path');

// Shared glob utilities — resolve from sibling (repo/dev) or shared install location
const { normalizePath, globToRegex, matchPath } = (() => {
  try { return require('./glob-match'); } catch {}
  try { return require('../../lib/glob-match'); } catch {}
  throw new Error('glob-match.js not found — run skill-engine setup');
})();

function findFileInAncestors(startDir, filename) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, '.claude', 'skills', filename);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir || dir === root) return null;
    dir = parent;
  }
}

function findRulesFile(startDir) {
  return findFileInAncestors(startDir, 'skill-rules.json');
}

function findLearnedRulesFile(startDir) {
  return findFileInAncestors(startDir, 'learned-rules.json');
}

function loadRules(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data.rules || data.version !== '1.0') return null;
    return data;
  } catch {
    return null;
  }
}

function matchKeywords(prompt, keywords) {
  if (!keywords || !keywords.length) return false;
  const lower = prompt.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

function matchIntent(prompt, patterns) {
  if (!patterns || !patterns.length) return false;
  return patterns.some(pat => {
    try {
      return new RegExp(pat, 'i').test(prompt);
    } catch {
      return false;
    }
  });
}

function matchPromptTriggers(prompt, rule) {
  const triggers = rule.triggers?.prompt;
  if (!triggers) return false;
  return matchKeywords(prompt, triggers.keywords) || matchIntent(prompt, triggers.intentPatterns);
}

// normalizePath, globToRegex, matchPath — imported from ./glob-match

function matchContent(filePath, contentPatterns) {
  if (!contentPatterns || !contentPatterns.length) return false;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return contentPatterns.some(pat => {
      try {
        return new RegExp(pat).test(content);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function matchFileTriggers(filePath, rule) {
  const triggers = rule.triggers?.file;
  if (!triggers) return false;
  if (!matchPath(filePath, triggers.pathPatterns, triggers.pathExclusions)) return false;
  if (rule.enforcement === 'block' && triggers.contentPatterns && triggers.contentPatterns.length) {
    return matchContent(filePath, triggers.contentPatterns);
  }
  return true;
}

function getSessionStatePath(sessionId) {
  const tmpDir = process.env.TEMP || process.env.TMPDIR || require('os').tmpdir();
  return path.join(tmpDir, 'skill-engine-' + sessionId + '.json');
}

function readSessionState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(getSessionStatePath(sessionId), 'utf8'));
  } catch {
    return { firedRules: [] };
  }
}

function writeSessionState(sessionId, state) {
  fs.writeFileSync(getSessionStatePath(sessionId), JSON.stringify(state), 'utf8');
}

function checkSkip(ruleName, rule, sessionId, filePath) {
  const skip = rule.skipConditions;
  if (!skip) return false;

  if (skip.envVars && skip.envVars.length) {
    if (skip.envVars.some(v => process.env[v])) return true;
  }

  if (filePath && skip.fileMarkers && skip.fileMarkers.length) {
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').slice(0, 5).join('\n');
      if (skip.fileMarkers.some(marker => lines.includes(marker))) return true;
    } catch {}
  }

  if (skip.sessionOnce && sessionId) {
    const state = readSessionState(sessionId);
    if (state.firedRules.includes(ruleName)) return true;
  }

  return false;
}

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function getPriority(rule, defaults) {
  return rule.priority || (defaults && defaults.priority) || 'medium';
}

function getEnforcement(rule, defaults) {
  return rule.enforcement || (defaults && defaults.enforcement) || 'suggest';
}

function activate(input, rulesData) {
  const prompt = input && input.prompt;
  const sessionId = input && input.session_id;
  if (!prompt || !rulesData) return '';

  const matches = [];
  for (const [name, rule] of Object.entries(rulesData.rules)) {
    if (checkSkip(name, rule, sessionId, null)) continue;
    if (!matchPromptTriggers(prompt, rule)) continue;
    const priority = getPriority(rule, rulesData.defaults);
    const enforcement = getEnforcement(rule, rulesData.defaults);
    matches.push({ name, rule, priority, enforcement });
  }

  if (!matches.length) return '';

  matches.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));

  if (sessionId) {
    const state = readSessionState(sessionId);
    for (const m of matches) {
      if (m.rule.skipConditions && m.rule.skipConditions.sessionOnce && !state.firedRules.includes(m.name)) {
        state.firedRules.push(m.name);
      }
    }
    writeSessionState(sessionId, state);
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
    if (m.rule.skillPath) {
      lines.push('  \u2192 Read: ' + m.rule.skillPath);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function enforce(input, rulesData) {
  const filePath = input && input.tool_input && input.tool_input.file_path;
  if (!filePath || !rulesData) return { exit: 0 };

  const sessionId = input.session_id;
  const matches = [];

  for (const [name, rule] of Object.entries(rulesData.rules)) {
    if (rule.type !== 'guardrail') continue;
    const enforcement = getEnforcement(rule, rulesData.defaults);
    if (enforcement !== 'block' && enforcement !== 'warn') continue;
    if (checkSkip(name, rule, sessionId, filePath)) continue;
    if (!matchFileTriggers(filePath, rule)) continue;
    const priority = getPriority(rule, rulesData.defaults);
    matches.push({ name, rule, priority, enforcement });
  }

  if (!matches.length) return { exit: 0 };

  matches.sort((a, b) => {
    if (a.enforcement === 'block' && b.enforcement !== 'block') return -1;
    if (a.enforcement !== 'block' && b.enforcement === 'block') return 1;
    return (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2);
  });

  const blockMatch = matches.find(m => m.enforcement === 'block');
  if (blockMatch) {
    const msg = blockMatch.rule.blockMessage || ('Blocked by rule: ' + blockMatch.name);
    return { exit: 2, stderr: msg };
  }

  const warnings = matches
    .filter(m => m.enforcement === 'warn')
    .map(m => '\u26A0\uFE0F ' + m.name + ': ' + m.rule.description)
    .join('\n');

  return { exit: 0, stderr: warnings || undefined };
}

module.exports = {
  findRulesFile,
  findLearnedRulesFile,
  loadRules,
  matchKeywords,
  matchIntent,
  matchPromptTriggers,
  normalizePath,
  globToRegex,
  matchPath,
  matchContent,
  matchFileTriggers,
  getSessionStatePath,
  readSessionState,
  writeSessionState,
  checkSkip,
  activate,
  enforce,
};

if (require.main === module) {
  const mode = process.argv[2];
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const rulesFile = findRulesFile(cwd);
  const rulesData = loadRules(rulesFile);
  if (!rulesData) process.exit(0);

  // Merge learned rules if they exist
  const learnedFile = findLearnedRulesFile(cwd);
  const learnedData = loadRules(learnedFile);
  if (learnedData) {
    // Learned rules go first in spread so main rules win on collision
    rulesData.rules = { ...learnedData.rules, ...rulesData.rules };
  }

  if (mode === 'activate') {
    const output = activate(input, rulesData);
    if (output) process.stdout.write(output);
    process.exit(0);
  } else if (mode === 'enforce') {
    const result = enforce(input, rulesData);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exit);
  }
  process.exit(0);
}
