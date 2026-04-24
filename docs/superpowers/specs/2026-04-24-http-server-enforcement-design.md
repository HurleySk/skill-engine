# Skill Engine v3.0.0 — HTTP Server-Based Rule Enforcement

## Problem

Skill Engine v1.x used `type: "command"` hooks on `UserPromptSubmit` and `PreToolUse` to activate skills and enforce guardrails. Each hook event spawned `bash -> node engine.js`, costing ~250-450ms per invocation on Windows. In a session with 200+ tool calls, this added 40-80 seconds of pure overhead. v2.0.0 removed hooks entirely for performance, but lost enforcement capability.

## Solution

Replace process-spawning command hooks with a persistent HTTP server. The server starts once, loads rules into memory, and handles hook events via `type: "http"` hooks at ~6-21ms per event — a ~30-50x improvement.

## Architecture

Three components:

### 1. Rule Server (`server/server.js`)

A single-file Node.js HTTP server using only built-in modules (`http`, `fs`, `path`). No external dependencies.

**Endpoints:**

| Route | Method | Purpose |
|-------|--------|---------|
| `/activate` | POST | Prompt-based rule matching, returns skill suggestions |
| `/enforce` | POST | File-based guardrail matching, returns block/warn/allow |
| `/health` | GET | Returns status: uptime, rules loaded, port, last event time |
| `/reload` | POST | Hot-reload rules from disk without restarting |

**In-memory state:**

- `rules` — merged `skill-rules.json` + `learned-rules.json`, loaded once
- `compiledRegexes` — `Map<pattern, RegExp>`, built on load, reused every call
- `sessions` — `Map<sessionId, { firedRules: Set, lastSeen: timestamp }>` for `sessionOnce` tracking
- `stats` — `{ startedAt, lastEvent, eventsProcessed, rulesLoaded }` for diagnostics

**Startup:**

```
node server.js --port 19750 --rules-dir /path/to/.claude/skills
```

- `--rules-dir` defaults to walking up from cwd to find `.claude/skills/`
- Port defaults to `19750`, configurable via `--port` or `SKILL_ENGINE_PORT` env var

**Hot-reload:** watches rule files with `fs.watch()`. On change, reloads and recompiles regexes. `/reload` endpoint available as manual trigger (fs.watch can be unreliable on Windows).

**Session cleanup:** `setInterval` every 5 minutes evicts sessions inactive for 30 minutes.

**Estimated size:** ~200-250 lines. Core matching logic reused from existing `engine.js`.

### 2. HTTP Hooks

Registered in `plugin.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/start-server.sh\""
      }
    ],
    "UserPromptSubmit": [
      {
        "type": "http",
        "url": "http://localhost:19750/activate"
      }
    ],
    "PreToolUse": [
      {
        "type": "http",
        "url": "http://localhost:19750/enforce"
      }
    ]
  }
}
```

The only command hook is `SessionStart` — one process spawn, once per session. The two hot-path hooks are HTTP with zero process spawning.

### 3. Lifecycle Management

| Method | Behavior |
|--------|----------|
| Automatic (SessionStart hook) | Starts server if not already running. Silent. |
| `/skill-engine:start` | Starts or confirms running. Shows status. |
| `/skill-engine:stop` | Kills the server. Hooks silently no-op after. |
| `/skill-engine:status` | Health check — port, uptime, rules loaded, last event. |
| `SKILL_ENGINE_OFF=1` | Bypasses everything. SessionStart skips boot, running server returns allow-all. |
| Server not running | Hooks silently no-op. Zero impact on Claude Code. |

`start-server.sh` checks if the port is already in use before spawning. Server stays running across sessions — no startup cost after the first.

## Data Flow

### Activation (UserPromptSubmit)

1. Claude Code fires `UserPromptSubmit` hook
2. HTTP POST to `http://localhost:19750/activate` with `{ prompt, session_id, cwd }`
3. Server matches prompt against in-memory rules (keywords + pre-compiled regex)
4. Server checks skip conditions (envVars, sessionOnce via in-memory session map)
5. Server returns skill suggestions sorted by priority, or empty 200 if no matches
6. Claude Code injects suggestions into context

### Enforcement (PreToolUse)

1. Claude Code fires `PreToolUse` hook
2. HTTP POST to `http://localhost:19750/enforce` with `{ tool_name, tool_input: { file_path, ... }, session_id, cwd }`
3. Server filters to guardrail rules only
4. Server matches file path against pre-compiled glob patterns
5. For block rules with `contentPatterns`: reads file from disk, tests regex
6. Server returns block (with reason), warn (with message), or allow
7. Claude Code blocks tool / shows warning / proceeds

## Rule Schema

Unchanged from v1, except `fileMarkers` removed from skip conditions (required file I/O on every enforce call).

```json
{
  "version": "1.0",
  "defaults": { "enforcement": "suggest", "priority": "medium" },
  "rules": {
    "rule-name": {
      "type": "domain|guardrail",
      "enforcement": "suggest|warn|block",
      "priority": "critical|high|medium|low",
      "description": "Human-readable message",
      "skillPath": "./{name}/SKILL.md",
      "triggers": {
        "prompt": {
          "keywords": ["keyword1"],
          "intentPatterns": ["regex.*pattern"]
        },
        "file": {
          "pathPatterns": ["**/*.sql"],
          "pathExclusions": ["**/test/**"],
          "contentPatterns": ["CREATE\\s+PROC"]
        }
      },
      "blockMessage": "Custom block message",
      "skipConditions": {
        "envVars": ["SKIP_RULE"],
        "sessionOnce": true
      }
    }
  }
}
```

Rule files:
- `.claude/skills/skill-rules.json` — permanent, version-controlled
- `.claude/skills/learned-rules.json` — auto-generated from learn sessions

Merge behavior unchanged: main rules win on name collision.

## Performance

### Per-Event Cost Comparison

| Component | v1 Command Hook | v3 HTTP Hook |
|-----------|----------------|--------------|
| Process spawn | ~200-400ms | 0ms (server running) |
| Rule loading from disk | ~10-20ms | 0ms (in memory) |
| Regex compilation | ~0.5ms | 0ms (pre-compiled) |
| Rule evaluation | ~0.01ms | ~0.01ms |
| IPC overhead | ~1ms (stdout) | ~5-20ms (HTTP) |
| **Total per event** | **~250-450ms** | **~6-21ms** |

### Session Cost Comparison

| Session Profile | v1 Command Hooks | v3 HTTP Hooks |
|-----------------|-----------------|---------------|
| Light (10 prompts, 50 tool calls) | ~21 seconds | ~0.7 seconds |
| Heavy (20 prompts, 200 tool calls) | ~77 seconds | ~2.6 seconds |

### Scaling With Rules

Rule evaluation is O(N) where N = number of rules, but the coefficient is ~0.005ms per rule with pre-compiled regexes. The HTTP overhead (~10ms) dominates until ~2,000+ rules. For any realistic rule count (<100), rule evaluation is negligible.

## Plugin Structure

```
skill-engine/
├── .claude-plugin/
│   └── plugin.json              # v3.0.0, hooks + skills
├── server/
│   └── server.js                # HTTP rule server
├── hooks/
│   ├── start-server.sh          # boot server if not running
│   └── lib/
│       ├── engine.js            # core matching logic (reused by server)
│       ├── glob-match.js        # pattern matching
│       ├── learn.js             # rule CRUD
│       ├── skill-scaffold.js    # SKILL.md creation
│       └── hook-manager.js      # settings.json CRUD
├── skills/
│   ├── learn/SKILL.md           # triage router (ACTIVE)
│   ├── learn-skill/SKILL.md     # create SKILL.md files (ACTIVE)
│   ├── learn-rule/SKILL.md      # create/update rules (RE-ACTIVATED)
│   ├── start/SKILL.md           # start server / check status (NEW)
│   ├── stop/SKILL.md            # stop server (NEW)
│   └── status/SKILL.md          # diagnostics (NEW)
├── tests/
│   └── ...                      # existing + new server tests
└── README.md
```

Deprecated skills deleted from disk: `learn-hook/`, `setup/`, `rules/`. Their directories and SKILL.md files are removed entirely, not just unlisted.

## CI/CD

Existing workflow handles publication:

1. Push to `master` with `plugin.json` version set to `3.0.0`
2. Workflow detects manual version bump, skips auto-increment
3. Tags `v3.0.0`, pushes tag
4. Dispatches `plugin-version-update` event to `HurleySk/claude-plugins-marketplace`
5. Marketplace syncs the new version

No workflow changes required.

## Graceful Degradation

Every failure mode degrades to "no enforcement, Claude Code unaffected":

| Failure | Behavior |
|---------|----------|
| Server not running | HTTP hooks get connection refused, silently no-op |
| Server crashes mid-session | Same as above — subsequent hooks no-op |
| No rule files found | Server starts, matches nothing |
| Malformed rule file | Server logs error, skips file, uses whatever loaded |
| `SKILL_ENGINE_OFF=1` set | SessionStart skips boot, server (if running) returns allow-all |
| Port conflict | SessionStart detects port in use, logs warning, skips |

## Why Not MCP Server

Considered `type: "mcp_tool"` hooks backed by an MCP server (lower latency via stdio). Rejected due to:

1. **Parameter serialization bugs** — multiple documented issues where MCP servers receive `{}` or stringified objects instead of actual parameters (#3966, #5504, #4192). Fix/regress cycle ongoing.
2. **Deny decisions ignored** — PreToolUse hook deny/block decisions not enforced for MCP tool calls (#33106). Directly breaks enforcement.
3. **Session startup blocking** — MCP servers block Claude Code startup until handshake completes, adding 1-3s to every session even if no rules fire.
4. **HTTP is sufficient** — ~5-10ms additional latency vs stdio is acceptable given the reliability gains.
