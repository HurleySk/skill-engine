'use strict';

const asyncEngine = require('./async/engine');
const skillFeedback = require('./skill-feedback');
const { getRequestContext, getSession, addContexts, getContexts } = require('./sessions');
const {
  checkSkip, ruleMatchesProject, hasPromptTrigger, matchPrompt, matchFile,
  matchToolTrigger, matchOutputTrigger, relevantRules, collectMatches, enforcingGuardrail,
  sortByPriority, sortBlockFirst, recordSessionOnce, ruleMessage,
} = require('./match');

const ASYNC_HELPERS = { getSession, checkSkip, ruleMatchesProject };

function names(matches) {
  return matches.map(m => m.name);
}

function appendTrailer(lines, sessionId) {
  if (sessionId) lines.push(...asyncEngine.drain(sessionId));
  const health = skillFeedback.getHealth();
  if (!health.flagged.length) return;
  const n = health.flagged.length;
  if (lines.length) lines.push('');
  lines.push('\u{1F4CB} **Skill health:** ' + n + ' skill' + (n > 1 ? 's have' : ' has') +
    ' accumulated feedback (' + health.flagged.map(f => f.skillName).join(', ') +
    ') — run `/skill-engine:skill-improve` to review.');
}

function activate(input) {
  const prompt = input.prompt;
  if (!prompt) return { response: {} };
  const sid = input.session_id;
  const ctx = getRequestContext(input);
  const session = getSession(sid, ctx.projectRoot);
  const promptMatches = entry => hasPromptTrigger(entry) && matchPrompt(prompt, entry);

  const matches = collectMatches(ctx.compiledRules, ctx.projectRoot, session, ctx.rulesData,
    entry => promptMatches(entry) ? {} : false);

  const lines = [];
  if (matches.length) {
    sortByPriority(matches);
    recordSessionOnce(session, matches);
    for (const m of matches) {
      skillFeedback.recordSignal({ skillName: m.name, type: 'activation', summary: '', sessionId: sid || '' });
    }
    addContexts(sid, matches.map(m => m.rule.sessionContext).filter(Boolean));
    asyncEngine.dispatch(ctx, input, promptMatches, () => ({ prompt }), ASYNC_HELPERS);

    const contexts = getContexts(sid);
    lines.push('⚡ Skill Engine — ' + matches.length + ' relevant skill' + (matches.length > 1 ? 's' : '') + ' detected:', '');
    for (const m of matches) {
      lines.push('[' + m.priority.toUpperCase() + '] ' + m.name + (m.rule.type === 'guardrail' ? ' (guardrail)' : ''));
      lines.push('  ' + m.rule.description);
      if (m.rule.contextEnhancement && contexts) {
        for (const tag of contexts) {
          if (m.rule.contextEnhancement[tag]) lines.push('  ⚡ ' + m.rule.contextEnhancement[tag]);
        }
      }
      if (m.rule.skillPath) lines.push('  → Read: ' + m.rule.skillPath);
      lines.push('');
    }
  }

  appendTrailer(lines, sid);
  const response = lines.length
    ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lines.join('\n') } }
    : {};
  return { response, ctx, matched: names(matches) };
}

function fileMatches(input, ctx, session) {
  const filePath = input.tool_input && input.tool_input.file_path;
  if (!filePath) return [];
  const toolName = input.tool_name;
  return collectMatches(ctx.compiledRules, ctx.projectRoot, session, ctx.rulesData, (entry, rd) => {
    const enforcement = enforcingGuardrail(entry, rd.defaults);
    if (!enforcement) return false;
    if (entry.toolNamesSet && toolName && !entry.toolNamesSet.has(toolName)) return false;
    return matchFile(filePath, entry, ctx.projectRoot) ? { enforcement } : false;
  });
}

function toolMatches(input, ctx, session) {
  if (!ctx.hasToolTriggerRules) return [];
  const toolName = input.tool_name;
  const toolInput = input.tool_input;
  if (!toolName && !toolInput) return [];
  const inputStr = toolInput ? JSON.stringify(toolInput) : '';
  const rules = relevantRules(ctx.toolTriggerIndex, ctx.toolWildcardRules, toolName);

  const matches = collectMatches(rules, ctx.projectRoot, session, ctx.rulesData, (entry, rd) => {
    const enforcement = enforcingGuardrail(entry, rd.defaults);
    return enforcement && matchToolTrigger(entry, toolName, inputStr) ? { enforcement } : false;
  });
  asyncEngine.dispatch({ ...ctx, compiledRules: rules }, input,
    entry => matchToolTrigger(entry, toolName, inputStr), () => ({ toolName, toolInput }), ASYNC_HELPERS);
  return matches;
}

function buildEnforcementResponse(matches) {
  if (!matches.length) return {};
  sortBlockFirst(matches);
  const decisive = matches.find(m => m.enforcement === 'block') || matches.find(m => m.enforcement === 'ask');
  if (decisive) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse',
      permissionDecision: decisive.enforcement === 'block' ? 'deny' : 'ask',
      permissionDecisionReason: ruleMessage(decisive.name, decisive.rule, decisive.enforcement) } };
  }
  const warnings = matches.filter(m => m.enforcement === 'warn').map(m => '⚠️ ' + m.name + ': ' + m.rule.description);
  if (!warnings.length) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext: warnings.join('\n') } };
}

function mergePreToolResponses(results) {
  let decisive = null;
  const contexts = [];
  for (const r of results) {
    const hso = r.hookSpecificOutput;
    if (!hso) continue;
    const d = hso.permissionDecision;
    if (d === 'deny' && (!decisive || decisive.permissionDecision !== 'deny')) decisive = hso;
    else if (d === 'ask' && !decisive) decisive = hso;
    if (hso.additionalContext) contexts.push(hso.additionalContext);
  }
  if (decisive) {
    const out = { ...decisive };
    if (contexts.length) out.additionalContext = contexts.join('\n');
    return { hookSpecificOutput: out };
  }
  if (contexts.length) return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: contexts.join('\n') } };
  return {};
}

function enforceWith(collectors) {
  return (input) => {
    const ctx = getRequestContext(input);
    const session = getSession(input.session_id, ctx.projectRoot);
    const groups = collectors.map(collect => collect(input, ctx, session));
    const all = groups.flat();
    recordSessionOnce(session, all);
    const responses = groups.map(buildEnforcementResponse);
    const response = responses.length === 1 ? responses[0] : mergePreToolResponses(responses);
    return { response, ctx, matched: names(all) };
  };
}

const enforce = enforceWith([fileMatches]);
const enforceTool = enforceWith([toolMatches]);
const enforceAll = enforceWith([fileMatches, toolMatches]);

function preTool(input) {
  const out = enforceAll(input);
  const toolInput = input.tool_input;
  if (toolInput && toolInput.file_path) {
    const { ctx } = out;
    const filePath = toolInput.file_path;
    asyncEngine.dispatch(ctx, input, entry => matchFile(filePath, entry, ctx.projectRoot),
      () => ({ filePath, content: toolInput.content || toolInput.new_string || '', toolName: input.tool_name || '' }),
      ASYNC_HELPERS);
  }
  return out;
}

function postTool(input) {
  const ctx = getRequestContext(input);
  const toolName = input.tool_name;
  const toolOutput = input.tool_output;
  const outputStr = typeof toolOutput === 'string' ? toolOutput : (toolOutput ? JSON.stringify(toolOutput) : '');
  const sid = input.session_id;
  const rules = relevantRules(ctx.outputTriggerIndex, ctx.outputWildcardRules, toolName);

  if (ctx.hasAsyncRules) {
    asyncEngine.dispatch({ ...ctx, compiledRules: rules }, input,
      entry => matchOutputTrigger(entry, toolName, outputStr),
      () => ({ toolName, toolInput: input.tool_input, toolOutput: outputStr }), ASYNC_HELPERS);
  }

  const lines = [];
  let matches = [];
  if (ctx.hasOutputTriggerRules) {
    const session = getSession(sid, ctx.projectRoot);
    matches = collectMatches(rules, ctx.projectRoot, session, ctx.rulesData,
      entry => !entry.isAsync && matchOutputTrigger(entry, toolName, outputStr) ? {} : false);
    sortByPriority(matches);
    recordSessionOnce(session, matches);
    lines.push(...matches.map(m => m.rule.guidance || m.rule.description));
  }
  if (sid) lines.push(...asyncEngine.drain(sid));

  const response = lines.length
    ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lines.join('\n') } }
    : {};
  return { response, ctx, matched: names(matches) };
}

function stop(input) {
  const ctx = getRequestContext(input);
  if (!ctx.hasStopRules) return { response: {}, ctx };
  const session = getSession(input.session_id, ctx.projectRoot);
  const matches = collectMatches(ctx.compiledRules, ctx.projectRoot, session, ctx.rulesData,
    entry => entry.hookEventsSet && entry.hookEventsSet.has('Stop') ? {} : false);
  if (!matches.length) return { response: {}, ctx };
  sortByPriority(matches);
  recordSessionOnce(session, matches);
  return {
    response: { decision: 'block', reason: matches.map(m => m.rule.guidance || m.rule.description).join('\n') },
    ctx,
    matched: names(matches),
  };
}

module.exports = { activate, enforce, enforceTool, preTool, postTool, stop };
