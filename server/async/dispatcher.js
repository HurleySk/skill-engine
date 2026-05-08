'use strict';

function dispatch(ctx, input, matchFn, contextBuilder, postJob, helpers) {
  if (!ctx || !ctx.hasAsyncRules) return;
  const session = helpers.getSession(input.session_id, ctx.projectRoot);
  for (const entry of ctx.compiledRules) {
    if (!entry.isAsync) continue;
    if (!helpers.ruleMatchesProject(entry, ctx.projectRoot)) continue;
    if (helpers.checkSkip(entry.name, entry.rule, session)) continue;
    if (!matchFn(entry)) continue;
    postJob({
      sessionId: input.session_id || 'unknown',
      projectRoot: ctx.projectRoot,
      handlerType: entry.asyncHandler,
      handlerName: entry.asyncHandlerName,
      config: entry.asyncConfig,
      context: { ...contextBuilder(entry), ruleName: entry.name },
    });
  }
}

module.exports = { dispatch };
