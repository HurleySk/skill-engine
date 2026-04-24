# Skill Engine Server Refactor

**Date:** 2026-04-24
**Status:** Approved
**Scope:** Remove command hook path, add pause/resume, consolidate code

## Context

The skill-engine v3.0 moved from command hooks (spawning `node engine.js` on every tool call) to a persistent HTTP server for performance. The command hook path remains in `engine.js` but is dead code — it duplicates ~80-100 lines of business logic that `server.js` already has in optimized form (pre-compiled regexes, in-memory sessions).

Additionally, the stop skill kills the server process, but the HTTP hooks in `plugin.json` still fire on every tool call, producing `ECONNREFUSED` errors until the session ends or the server is restarted.

## Changes

### 1. Gut `engine.js` into `rules-io.js`

Rename `hooks/lib/engine.js` to `hooks/lib/rules-io.js`. Keep only:

- `findRulesFile(cwd)` — walks up directory tree to find `skill-rules.json`
- `findLearnedRulesFile(cwd)` — same for `learned-rules.json`
- `loadRules(filePath)` — reads and parses a rules JSON file
- Re-export `normalizePath` from `glob-match.js` (learn.js imports it from engine today)

Delete everything else:
- `activate()`, `enforce()` — duplicated in server.js with pre-compiled regexes
- `matchKeywords()`, `matchIntent()`, `matchPromptTriggers()`, `matchFileTriggers()`, `matchContent()` — server.js has compiled equivalents
- `checkSkip()`, `getPriority()`, `getEnforcement()` — duplicated in server.js
- `PRIORITY_ORDER` constant — duplicated in server.js
- File-based session state (`getSessionStatePath`, `readSessionState`, `writeSessionState`)
- `require.main === module` CLI entry point

Reduces ~274 lines to ~50 lines.

**Import updates:**
- `learn.js`: change `require('./engine.js')` to `require('./rules-io.js')`
- `server.js`: change engine import to rules-io

### 2. Add pause/resume mode to server

Replace the process-kill stop mechanism with an in-process pause mode. When paused, all hook endpoints return `{}` (valid empty hook response — Claude Code accepts silently).

**New endpoints:**
- `POST /pause` — sets `paused = true`, returns `{paused: true}`
- `POST /resume` — sets `paused = false`, returns `{paused: false}`

**Modified endpoints:**
- `GET /health` — add `paused` boolean field to response
- `handleActivate` / `handleEnforce` — early return `{}` when paused

**Replaces `SKILL_ENGINE_OFF` env var:** The pause mechanism supersedes the env var check. The env var is removed from both handlers. `start-server.sh` retains the env var check as a "don't even start the server" gate, which is a different concern.

**Skill updates:**
- **stop skill** — POST to `/pause` instead of killing the process. Verify with health check showing `paused: true`. If server is already down (ECONNREFUSED), report "not running" as today.
- **start skill** — if health check shows `paused: true`, POST to `/resume`. If server is actually down, start it as today.
- **status skill** — include paused state in output.

### 3. Test cleanup

**Rename `engine.test.js` to `rules-io.test.js`:**
- Keep: rule file discovery tests, `loadRules` tests, `normalizePath` re-export test
- Delete: all `activate()`/`enforce()` tests, matching function tests, session state tests, priority sorting tests (covered by `server.test.js`)

**Add to `server.test.js`:**
- `POST /pause` returns `{paused: true}`
- `POST /resume` returns `{paused: false}`
- Enforce returns `{}` when paused (even for files that would normally be blocked)
- Activate returns `{}` when paused
- `/health` includes `paused` field
- Resume restores normal enforcement behavior

## Files Changed

| File | Action |
|------|--------|
| `hooks/lib/engine.js` | Delete |
| `hooks/lib/rules-io.js` | Create (extracted from engine.js) |
| `hooks/lib/learn.js` | Update imports |
| `server/server.js` | Update imports, add pause/resume/health changes, remove SKILL_ENGINE_OFF from handlers |
| `tests/engine.test.js` | Delete |
| `tests/rules-io.test.js` | Create (subset of engine tests) |
| `tests/server.test.js` | Add pause/resume tests |
| `skills/stop/SKILL.md` | Rewrite: POST /pause instead of kill |
| `skills/start/SKILL.md` | Update: handle resume case |
| `skills/status/SKILL.md` | Update: show paused state |

## Out of Scope

- Refactoring `server.js` internals (rule compilation, session management) — working well as-is
- Changes to `glob-match.js`, `hook-manager.js`, `skill-scaffold.js` — unaffected
- Changes to `plugin.json` hook registration — stays the same
