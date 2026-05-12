# Skill Engine

Rule-based skill activation and guardrail enforcement for Claude Code. Persistent Node.js HTTP server, zero dependencies.

## How It Works

A Node.js HTTP server starts at session begin, loads all rules into memory, and pre-compiles regex patterns. Claude Code hooks route events to the server:

- **UserPromptSubmit** hits `/activate` -- matches prompt text against activation rules, suggests relevant skills, and delivers any pending async analyzer findings.
- **PreToolUse** hits `/pre-tool` -- consolidated endpoint handling file-path guardrails, tool-input guardrails, and project-specific safety checks in a single round-trip (replaced the previous 3-endpoint split at `/enforce`, `/enforce-tool`, `/pre-write`).
- **PostToolUse** hits `/post-tool` -- evaluates output-trigger rules for mutation tools.

Matchers in `plugin.json` filter hooks at the harness level, so read-only tools (Read, Grep, Glob, LS, Agent, etc.) never trigger HTTP calls. This cuts ~50% of round-trips in a typical session. HTTP hooks cost ~6-21ms per event.

Async analyzers run off-thread in worker threads and deliver findings on the next prompt submit, adding analysis capability without blocking the hot path.

## Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Server status, version, rule counts, compilation warnings |
| `/activate` | POST | Skill activation + async finding delivery (UserPromptSubmit) |
| `/pre-tool` | POST | Consolidated PreToolUse guardrails (file-path, tool-input, safety) |
| `/enforce` | POST | Legacy file-path guardrails (use `/pre-tool` instead) |
| `/enforce-tool` | POST | Legacy tool-input guardrails (use `/pre-tool` instead) |
| `/pre-write` | POST | Legacy project safety checks (use `/pre-tool` instead) |
| `/post-tool` | POST | Output-trigger rules (PostToolUse) |
| `/stop` | POST | Shut down server |
| `/register-session` | POST | Register session with project root for cross-repo scoping |
| `/pause` | POST | Pause enforcement (hooks no-op) |
| `/resume` | POST | Resume enforcement |
| `/skill-feedback` | POST | Record performance signal for a skill |
| `/skill-health` | GET | Accumulated feedback and threshold state per skill |
| `/skill-feedback/clear` | POST | Clear feedback for a skill |
| `/skill-feedback/signals` | GET | Raw signal history |

## Skills

| Skill | Command | Purpose |
|---|---|---|
| learn | `/skill-engine:learn` | Capture a lesson as a rule or skill (triage router) |
| learn-rule | `/skill-engine:learn-rule` | Create, update, or promote enforcement rules |
| learn-skill | `/skill-engine:learn-skill` | Create SKILL.md workflow files |
| learn-analyzer | `/skill-engine:learn-analyzer` | Create async analyzer scripts + wire async rules |
| start | `/skill-engine:start` | Start the server or confirm running |
| stop | `/skill-engine:stop` | Stop the server (hooks silently no-op) |
| status | `/skill-engine:status` | Show server diagnostics |
| review | `/skill-engine:review` | Audit Claude config ecosystem |
| skill-improve | `/skill-engine:skill-improve` | Review accumulated feedback, propose skill edits |
| debrief | `/skill-engine:debrief` | End-of-session lesson capture + skill health |
| rule-review | `/skill-engine:rule-review` | Audit rules for validity, conflicts, dead patterns |
| rule-consistency | `/skill-engine:rule-consistency` | Detect contradictory or redundant rules |
| perf-check | `/skill-engine:perf-check` | Performance audit of hooks, MCP, plugins |
| using-skill-engine-skills | `/skill-engine:using-skill-engine-skills` | Session-start orientation |

## Server Lifecycle

The server auto-starts via the `SessionStart` hook -- no manual setup needed.

Manual control:

- `/skill-engine:start` -- start or confirm running
- `/skill-engine:stop` -- stop the server (hooks silently no-op until restarted)
- `/skill-engine:status` -- show diagnostics

Kill switch: set `SKILL_ENGINE_OFF=1` to prevent the server from starting.

## Port Configuration

Default port is **19750**, configurable via `SKILL_ENGINE_PORT` env var for the server and start script.

**Limitation:** The HTTP hook URLs in `plugin.json` are hardcoded to `http://localhost:19750`. The plugin.json format does not support env var interpolation in URLs. If you change the port via `SKILL_ENGINE_PORT`, the hooks will not reach the server. Only change the port if you also fork the plugin and update `plugin.json` to match.

## Rule Files

- **skill-rules.json** -- Permanent, version-controlled rules. Ship these with your project.
- **learned-rules.json** -- Auto-generated rules created via `/skill-engine:learn-rule`. Promote to `skill-rules.json` when stable.

Both files use the same schema. Rules may include an `async` block to trigger off-thread analysis (see Async Analyzers below). See `skills/learn-rule/SKILL.md` for the full rule structure.

## Async Analyzers

Project-local JavaScript scripts that run off-thread in worker threads. Findings are delivered on the next `UserPromptSubmit`, so they never block the hook path.

### File location

```
.claude/skills/analyzers/{name}.js
```

### Contract

```js
/**
 * @param {Object} context - Event context from the triggering hook
 * @param {Object} config  - Config object from the rule's async block
 * @returns {Array<{ severity: string, message: string, relatedFiles?: string[] }>}
 */
export async function analyze(context, config) {
  // ... your analysis logic
  return [
    { severity: "warning", message: "Something needs attention", relatedFiles: ["path/to/file.json"] }
  ];
}
```

### Rule format

```json
{
  "id": "my-analyzer",
  "event": "PostToolUse",
  "async": {
    "handler": "analyzer",
    "name": "my-analyzer",
    "config": { "key": "value" }
  }
}
```

The deprecated shorthand `async: { analyzer: "my-analyzer" }` still works and is auto-mapped to the handler format with a compilation warning.

### Characteristics

- Advisory only -- async rules cannot block tools or reject writes
- Run in Node.js worker threads, isolated from the main server
- Create via `/skill-engine:learn-analyzer`

## Skill Feedback Loop

The feedback system tracks skill performance across sessions:

1. **Signal recording** -- `/skill-feedback` accepts performance signals (positive/negative) per skill.
2. **Threshold tracking** -- `/skill-health` returns accumulated feedback and whether improvement thresholds have been crossed.
3. **Debrief integration** -- The `debrief` skill routes end-of-session lessons into the feedback system.
4. **Session-start nudges** -- When thresholds are crossed, nudges appear at session start prompting a `/skill-engine:skill-improve` review.

## Handler Registry (v5.0.0)

The async subsystem uses a modular handler registry with two handler types:

| Handler | Purpose |
|---|---|
| `analyzer` | Runs project-local JS scripts (`.claude/skills/analyzers/*.js`) |
| `hook` | Background hook work (internal server operations) |

The registry validates `async` blocks at rule compile time. Invalid handler references or malformed configs produce compilation warnings, surfaced in the `/health` endpoint.

## Requirements

- Node.js (any recent version)
- Claude Code with plugin and hook support
- Bash (Git Bash on Windows)

## Version History

| Version | Changes |
|---|---|
| **v5.0.0** | Modular async subsystem with handler registry, typed handlers, compile-time validation |
| v4.0.5 | Expand async triggers to all handlers |
| **v4.0.1** | Async analysis system with worker threads and analyzer scripts |
| v3.4.1 | Session contexts, skill feedback loop |
| v3.3.6 | Consolidated PreToolUse hooks (3 endpoints to 1 round-trip) |
| v3.3.4 | Session-keyed isolation, multi-key rule cache |
| v3.3.0 | Stateless per-request cache, structural refactor |
| **v3.2.0** | Add matchers to enforce-tool/post-tool hooks (skip read-only tools); add `/pre-write` endpoint for project-specific safety checks; configurable via `safety-rules.json` |
| v3.1.5 | Windows case-insensitive sourceRepo matching, sourceRepo display in list |
| v3.1.4 | Cross-repo rule isolation via sourceRepo scoping |
| v3.1.3 | Fail-open for unknown POST routes; null-safety in handlePostTool |
| **v3.1.0** | Fix rules not loading when CLAUDE_PROJECT_DIR is unset; add CLAUDE.md |
| v3.0.9 | Fix Windows process kill in start-server.sh |
| v3.0.7 | Fix false-positive enforcement on read-only tools; version-aware restart |
| v3.0.6 | Pause/resume endpoints; hook schema fix |
| v3.0.0 | HTTP server-based enforcement |
| v2.0.0 | Hooks removed for performance |
| v1.x | Command hook-based enforcement |

## License

MIT
