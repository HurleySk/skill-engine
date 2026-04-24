---
name: perf-check
description: Dispatch a Claude Code performance expert subagent to audit hooks, MCP servers, and plugin configuration for latency issues. Reusable across projects.
---

# Skill Engine — Performance Check

Dispatch a subagent that acts as a Claude Code performance expert. It audits the current project's hook configuration, MCP servers, and plugin setup for performance issues.

## When to Use

- After adding or modifying hooks
- When Claude Code feels sluggish
- Before publishing a plugin to the marketplace
- As a periodic health check on project configuration

## Steps

1. Dispatch an Agent subagent with `subagent_type: "general-purpose"` and the following prompt:

~~~
You are a Claude Code performance expert. Audit this project for performance issues.

## What to Check

### 1. Hook Configuration
Read .claude/settings.json and .claude/settings.local.json (if they exist) and any plugin.json files.
For each hook:
- What type is it? (command, http, mcp_tool, prompt, agent)
- What event does it fire on? (PreToolUse, PostToolUse, UserPromptSubmit, etc.)
- Does it have an `if` filter to limit when it fires?
- Estimate the per-event cost:
  - `command` hooks: ~200-500ms on Windows, ~50-200ms on macOS/Linux (process spawn)
  - `http` hooks: ~5-20ms (localhost), ~50-500ms (remote)
  - `mcp_tool` hooks: ~4-9ms (if MCP server is running)
  - `prompt` hooks: variable (LLM call)
  - `agent` hooks: variable (full agent invocation)

### 2. MCP Servers
Check for .mcp.json or MCP server declarations in settings.
For each MCP server:
- Does it use stdio or HTTP transport?
- How many tools does it expose? (each tool adds to context window consumption)
- Is it needed for every session, or could it be lazily loaded?

### 3. Hot Path Analysis
Identify hooks on PreToolUse and UserPromptSubmit — these fire most frequently.
Flag any command hooks on these events as high-impact.
Calculate estimated overhead per session:
  total = (prompt_count x per_prompt_hook_cost) + (tool_count x per_tool_hook_cost)
  Assume: ~10 prompts, ~100 tool calls for a moderate session.

### 4. Recommendations
For each issue found, recommend a specific fix:
- Replace command hooks with http hooks (if a server is available)
- Add `if` filters to limit when hooks fire
- Move expensive hooks from PreToolUse to PostToolUse if they don't need to block
- Consolidate multiple hooks on the same event
- Flag MCP servers that could be lazy-loaded

## Output Format

Report as:

**Performance Audit**

| Hook/Server | Event | Type | Est. Cost | Issue | Fix |
|---|---|---|---|---|---|

**Estimated Session Overhead:** X seconds (for 10 prompts + 100 tool calls)

**Recommendations:**
1. ...
2. ...
~~~

2. Present the subagent's findings to the user.
