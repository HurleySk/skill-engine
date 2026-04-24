# Issue #1: False-positive enforcement + version staleness

**Date:** 2026-04-24
**Issue:** HurleySk/skill-engine#1
**Status:** Approved

## Problem

Three related problems surfaced during a triage session:

1. **False-positive enforcement on Read** — The `PreToolUse` hook fires for every tool, and `handleEnforce()` evaluates guardrail rules whenever `tool_input.file_path` is present. This means `Read` (and any tool providing a file path) triggers enforcement, blocking research workflows.

2. **Version staleness on start** — `start-server.sh` exits if any server is running on the port, even from an older plugin version. The `/health` endpoint doesn't report its version, so there's no way to detect staleness. This caused the v3.0.5 server to persist after v3.0.6 was downloaded.

3. **`/pause` returned 404** — A consequence of (2). The pause endpoint was added in v3.0.6 but the running server was still v3.0.5.

## Design

### 1. Fix false-positive enforcement on read-only tools

Two filtering layers, both cheap:

**Layer 1 — `plugin.json` matcher (eliminates HTTP call):**

Add `"matcher": "Edit|Write|NotebookEdit"` to the `PreToolUse` hook entry in `plugin.json`. Claude Code evaluates this before invoking the hook — `Read`, `Grep`, `Glob`, `Bash`, etc. never hit the server. This is the primary performance win: zero network overhead for the most frequent tools.

**Layer 2 — Per-rule `toolNames` in the server (optional, fine-grained):**

Rules can optionally specify a `toolNames` array in their file triggers:

```json
{
  "triggers": {
    "file": {
      "toolNames": ["Edit"],
      "pathPatterns": ["tasks/**/*.json"],
      "contentPatterns": ["entity_name"]
    }
  }
}
```

During `handleEnforce()`, the server reads `tool_name` from the hook payload and skips rules whose `toolNames` don't include it. If a rule omits `toolNames`, it applies to all tools that pass the matcher gate.

**Implementation details:**

- `compileRules()` pre-compiles `toolNames` into a `Set` per rule at load time — no allocation at request time.
- `handleEnforce()` does a single `Set.has(toolName)` check per rule — O(1), before any regex evaluation.
- `toolNames` is optional. Omitting it means "match any tool" — since the `plugin.json` matcher already filters to write tools, no server-side default list is needed. The server simply skips the `toolNames` check when the field is absent.

### 2. Version-aware server restart

**Health endpoint additions:**

Add `version` (from `plugin.json`) and `pid` (`process.pid`) to the `/health` response. Version is read once at startup and stored in a module-level constant. PID is a property access — both are zero-cost at request time.

```json
{
  "version": "3.0.6",
  "pid": 12345,
  "uptime": 3600,
  "rulesLoaded": 5,
  "...": "..."
}
```

**`start-server.sh` version check:**

When the health check succeeds (server already running):

1. Parse `version` from the health response JSON.
2. Read the current version from `plugin.json` in the plugin directory.
3. If versions differ:
   - Parse `pid` from the health response.
   - Kill the old process.
   - Start the new server.
   - Emit: `skill-engine: restarted (old → new)` to stdout.
4. If versions match: exit silently (no change to happy path).

### 3. Out of scope

- **/pause and /resume** — Already implemented in v3.0.6. No changes needed.
- **Rule authoring** — The `dataverse-entity-logical-name` rule being too broad is a rule config issue. The `toolNames` filter prevents the false positive at the code level. Rule authors can independently tighten their patterns.

## Files changed

| File | Change |
|---|---|
| `.claude-plugin/plugin.json` | Add `matcher: "Edit\|Write\|NotebookEdit"` to PreToolUse hook |
| `server/server.js` | Add `version` + `pid` to `/health`; add `tool_name` filtering in `handleEnforce()`; pre-compile `toolNames` sets in `compileRules()` |
| `hooks/start-server.sh` | Version comparison + auto-restart logic |
| `tests/server.test.js` | Tests for tool filtering and health version/pid |

## Performance impact

- **PreToolUse for read-only tools:** Eliminated entirely (matcher gate in `plugin.json`).
- **PreToolUse for write tools:** One additional `Set.has()` per rule, before regex evaluation. Negligible.
- **Server startup:** One additional `JSON.parse` of `plugin.json` (once, on boot). Zero impact on request path.
- **`start-server.sh`:** One additional `jq`/`grep` parse of health response when server is already running. Only runs once per session start.
