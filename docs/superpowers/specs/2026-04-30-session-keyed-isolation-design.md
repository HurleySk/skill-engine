# Session-Keyed Isolation for Skill Engine Server

**Date:** 2026-04-30
**Status:** Approved
**Addresses:** GitHub Issues #5, #6

## Problem

The skill-engine server has 10 identified architectural failure modes rooted in three structural weaknesses:

1. **Global mutable state** — `lastProjectDir` is a single variable shared across all requests. Two concurrent sessions from different projects race on it. The server has no way to know which project a request belongs to because Claude Code HTTP hook payloads do not include `env.CLAUDE_PROJECT_DIR`.

2. **Dual version management** — `start-server.sh` and `server.js` both independently perform semver comparison against the plugin cache directory. They can disagree, causing version reversion, multiple server instances, and stale processes.

3. **Single-slot rule cache** — `RuleCache` stores one `_rulesDir` at a time. Switching projects blows away the cache and triggers recompilation. Concurrent requests can mutate the cache mid-evaluation.

These produce user-visible symptoms: rules silently stop enforcing, wrong project's rules apply, versions revert after updates, and there's no signal when any of this happens.

## Design

### Approach: Session-Keyed Isolation in One Process

Keep a single server on port 19750. Replace global project state with session-scoped lookups. Each request resolves its own project context from its own `session_id`.

This was chosen over per-project server instances (separate processes per project with a routing layer) because:
- A router process is itself a singleton with mutable state (the routing table)
- N server processes multiply the version management problem
- HTTP forwarding adds 1-2ms per request against a 25ms budget
- A router crash takes down all projects anyway
- Session-keyed isolation provides the same guarantee — session X always gets project X's rules — without the operational tax

### 1. Session Registry

Replaces `lastProjectDir`.

```
SessionRegistry: Map<sessionId, { projectDir, rulesDir, registeredAt, lastRequest }>
```

**Registration:** SessionStart hook calls `POST /register-session` with `{ sessionId, projectDir }`. The shell script reads `$CLAUDE_SESSION_ID` from the hook environment. If unavailable (older Claude Code versions), it generates a deterministic fallback using Node.js: `$(node -e "console.log(require('crypto').createHash('md5').update(process.argv[1]).digest('hex').slice(0,16))" "$CLAUDE_PROJECT_DIR")`.

**Request resolution:** Every hook request carries `session_id`. The server looks up `session_id → projectDir → rulesDir`. No global state touched during request handling. Two concurrent sessions from different projects resolve independently.

**Fallback:** If a request has no `session_id` or an unregistered one, fall back to the most recently registered session's project. This is strictly better than today's `lastProjectDir` — same behavior, but only as a safety net.

**Cleanup:** 30-minute staleness sweep over the registry (same interval as existing session cleanup). When a session expires, its registry entry and firedRules set are both removed.

### 2. Multi-Key RuleCache

Replaces the single-slot `RuleCache`.

```
Map<rulesDir, { mainMtime, learnedMtime, compiledRules, rulesData, flags }>
```

**Per-key mtime invalidation:** `fs.statSync` on `skill-rules.json` and `learned-rules.json` for the specific project's `rulesDir`. If mtime changed, recompile that project's rules only. Other projects' caches are untouched.

**Immutable snapshots:** `getRules(rulesDir)` returns a frozen object. A request evaluating rules cannot be affected by a concurrent recompile triggered by another request.

**LRU eviction:** Cap at 10 entries. When a new project is registered and the cache is full, evict the least-recently-used entry. 10 is generous — most users work in 2-3 projects.

**Performance:** Same `fs.statSync` per request (~0.1ms), scoped to the requesting project. Cache hit returns a pre-frozen object with zero allocation. Recompilation only happens when a specific project's rules actually change.

### 3. Startup Simplification

**server.js — remove self-upgrade entirely.**

Delete lines 41-77 (the `SKILL_ENGINE_UPGRADED` re-exec block). The server runs whatever code it was started with. One version decision point, in the shell script.

**start-server.sh — three states:**

| State | Action |
|---|---|
| No server running | Start server, register session |
| Server running, same version | Register session, done |
| Server running, different version | Kill, start new, register session |

Version comparison is string equality (`!=`), not semver. If versions differ at all, kill and restart. The latest cached plugin directory is the source of truth.

The `_semver_newer` function, fail-safe version guards, and self-upgrade coordination are all removed.

**`register_session` in bash:**
```bash
register_session() {
  local SESSION_ID="${CLAUDE_SESSION_ID:-$(node -e "console.log(require('crypto').createHash('md5').update(process.argv[1]).digest('hex').slice(0,16))" "$CLAUDE_PROJECT_DIR" 2>/dev/null)}"
  local PAYLOAD
  PAYLOAD=$(node -e "console.log(JSON.stringify({sessionId:process.argv[1],projectDir:process.argv[2]}))" \
    "$SESSION_ID" "$CLAUDE_PROJECT_DIR" 2>/dev/null)
  curl -s --max-time 1 -X POST -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "http://localhost:$PORT/register-session" 2>/dev/null
}
```

### 4. Observability

**`/health` shows per-session project state:**

```json
{
  "version": "3.4.0",
  "pid": 12345,
  "port": 19750,
  "uptime": 3600,
  "paused": false,
  "avgResponseTimeMs": 2.15,
  "eventsProcessed": 842,
  "sessions": {
    "abc-123": {
      "projectDir": "/users/sam/repos/adf-graph",
      "rulesDir": "/users/sam/repos/adf-graph/.claude/skills",
      "rulesLoaded": 7,
      "registeredAt": "2026-04-30T18:00:00Z",
      "lastRequest": "2026-04-30T18:45:12Z"
    }
  },
  "cache": {
    "entries": 2,
    "maxEntries": 10
  }
}
```

**`/register-session` returns actionable confirmation:**

```json
{
  "sessionId": "abc-123",
  "projectDir": "/users/sam/repos/adf-graph",
  "rulesDir": "/users/sam/repos/adf-graph/.claude/skills",
  "rulesLoaded": 7,
  "errors": []
}
```

If rules can't load (bad JSON, missing file), the `errors` array says why. `start-server.sh` can check this and echo a warning the user sees during SessionStart.

**`/rules` accepts session scoping:** Optional `?session=abc-123` query param to inspect rules for a specific session. Default: all loaded rules grouped by project.

### 5. PostToolUse Matcher (Issue #6)

**Current plugin.json:**
```
PostToolUse matcher: Write|Edit|Bash|PowerShell|NotebookEdit
```

**New:**
```
PostToolUse matcher: Read|Grep|Glob|Write|Edit|Bash|PowerShell|NotebookEdit
```

Output trigger rules should fire on read-only tools — detecting patterns in file contents or search results is the primary use case. The `hasOutputTriggerRules` fast-path in `handlePostTool` already returns `{}` immediately when no output trigger rules exist, so projects without output triggers pay only the HTTP round-trip cost (~2ms).

PreToolUse matchers are unchanged. No reason to run guardrails on reads.

### 6. Migration & Backward Compatibility

**`/set-project` stays as a deprecated fallback.** If an older cached `start-server.sh` calls `/set-project`, the server handles it by registering a synthetic session entry with a deterministic ID derived from the project path. No breakage. `/health` includes a `deprecatedSetProjectCalls` counter so the user knows something is using the old path.

**`sourceRepo` scoping on rules** is unchanged. Session isolation ensures each project loads its own rules. `sourceRepo` filtering remains a second layer of defense within that set.

**Rollback path:** Killing the server and restarting with an older cached version works — the older server uses `lastProjectDir` as before. The new `start-server.sh` can fall back to calling `/set-project` if `/register-session` returns a non-200 response.

## Files Changed

| File | Change |
|---|---|
| `server/server.js` | SessionRegistry, multi-key RuleCache, remove self-upgrade (lines 41-77), new `/register-session` endpoint, updated `/health` with per-session detail, updated `/rules` with session scoping, `/set-project` deprecated fallback |
| `hooks/start-server.sh` | Simplified lifecycle (3 states), `register_session()` replaces `_set_project()`, remove `_semver_newer`, remove fail-safe version guards |
| `.claude-plugin/plugin.json` | PostToolUse matcher: add `Read\|Grep\|Glob` |
| `CLAUDE.md` | Updated architecture section, document session registry, updated performance notes for PostToolUse |

## Testing Strategy

- **Session registry isolation:** Two sessions registered with different projects, verify each gets its own rules
- **Multi-key cache:** Register project A, register project B, verify both are cached, verify mtime invalidation per-key
- **LRU eviction:** Register 11 projects, verify oldest is evicted
- **Immutable snapshots:** Modify rules mid-request, verify in-flight evaluation is unaffected
- **Startup lifecycle:** Server not running → start. Same version → register only. Different version → kill and restart.
- **Deprecated `/set-project`:** Call `/set-project`, verify synthetic session is registered
- **Fallback:** Request with unknown session_id falls back to most recent project
- **PostToolUse on read-only tools:** Output trigger rule with `toolNames: ["Read"]` fires on Read output

## Performance Impact

| Path | Before | After |
|---|---|---|
| Request context resolution | O(1) global read | O(1) Map lookup by session_id |
| Rule cache hit | O(1) single-slot | O(1) Map lookup by rulesDir |
| Rule cache miss (recompile) | Same | Same, but only for the affected project |
| PostToolUse on Read/Grep/Glob | Not invoked | ~2ms round-trip, returns `{}` if no output trigger rules |
| `/health` response | Flat object | Slightly larger (session detail), still <1ms |

No regression expected on the hot path. Multi-key cache is strictly better for multi-project workflows (eliminates thrashing recompilation).
