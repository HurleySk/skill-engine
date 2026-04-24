# Skill Engine

Rule-based skill activation and guardrail enforcement for Claude Code, powered by a persistent HTTP server for near-zero latency.

## How It Works

A Node.js HTTP server starts at session begin, loads all rules into memory, and pre-compiles regex patterns. Two HTTP hooks in `plugin.json` route Claude Code events to the server:

- **UserPromptSubmit** hits `/activate` -- matches prompt text against activation rules and suggests relevant skills.
- **PreToolUse** hits `/enforce` -- evaluates guardrail rules against the tool call and warns or blocks.

HTTP hooks cost ~6-21ms per event. The v1 command hooks spawned a new process each time, costing ~250-450ms. The server approach keeps enforcement on the hot path without the latency penalty.

## Skills

| Skill | Command | Purpose |
|---|---|---|
| learn | `/skill-engine:learn` | Capture a lesson as a rule or skill (triage router) |
| learn-rule | `/skill-engine:learn-rule` | Create, update, or promote enforcement rules |
| learn-skill | `/skill-engine:learn-skill` | Create SKILL.md workflow files |
| start | `/skill-engine:start` | Start the server or check if it is already running |
| stop | `/skill-engine:stop` | Stop the server |
| status | `/skill-engine:status` | Show server diagnostics (port, uptime, rules, events) |
| perf-check | `/skill-engine:perf-check` | Dispatch a performance audit subagent |

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

Both files use the same schema. See `skills/learn-rule/SKILL.md` for the rule structure.

## Requirements

- Node.js (any recent version)
- Claude Code with plugin and hook support
- Bash (Git Bash on Windows)

## Version History

| Version | Architecture |
|---|---|
| **v3.0.0** | HTTP server-based enforcement (current) |
| v2.0.0 | Hooks removed entirely for performance |
| v1.x | Command hook-based enforcement |

## License

MIT
