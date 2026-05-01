# Changelog

## 3.3.4

### Fixes

- File guardrail `contentPatterns` now enforced for `warn` rules, not just `block`. Previously, `warn` rules with `contentPatterns` would match on path patterns alone (ignoring file content), while the secondary check only tested the edit diff text — not the full file. Now `matchFileCompiled` reads the full file for all enforcement levels.

## 3.3.3

### Features

- Add `/skill-engine:debrief` skill for session lesson capture and routing
- Remove stale `docs/` directory

## 3.3.2

### Fixes

- Server self-upgrades from latest cache on startup (prevents stale server code after plugin update)

## 3.3.1

### Fixes

- Prevent version reversion in SessionStart hook and `/start` skill

## 3.3.0

Milestone release: stateless per-request cache and structural refactor. Consolidates changes from 3.2.4-3.2.10 under a single major version bump.

### Breaking Changes

- `/reload` endpoint removed (replaced by mtime-based auto-reload)
- `--rules-dir` CLI arg removed (project derived from `CLAUDE_PROJECT_DIR`)

### Highlights

- `RuleCache` class with mtime-gated lazy compilation
- Per-request project context from `CLAUDE_PROJECT_DIR`
- Session state keyed by `(sessionId, projectRoot)`
- Semver version guard, `GET /rules` diagnostic endpoint, `learn.js` stdin support
- `server/pre-write-safety.js` extracted, `collectMatches`/`sortByPriority` shared infrastructure
- `server.js`: 977 to 650 lines; 154 tests pass

## 3.2.10

### Features

- Add `GET /rules` diagnostic endpoint for inspecting loaded rule state

## 3.2.9

### Fixes

- Safe JSON serialization in `/set-project` endpoint

## 3.2.8

### Refactoring

- Server structural improvements: test harness factory, module extraction, DRY handlers
- Deduplicate handler matching with `collectMatches` infrastructure
- Extract pre-write safety logic into `server/pre-write-safety.js`
- Extract test harness factory to reduce setup boilerplate

### Features

- Add `/set-project` endpoint for cross-session project switching

## 3.2.7

### Fixes

- `learn.js` accepts JSON from stdin to avoid shell escaping bugs with regex patterns

## 3.2.6

### Fixes

- Never downgrade running server -- semver-aware version guard prevents stale sessions from reverting the server

## 3.2.5

### Fixes

- Health endpoint reports cached rule state after first request
- Fix version display in `start-server.sh` on Windows

## 3.2.4

### Features

- Stateless per-request cache: replace global state with `RuleCache` class and per-request context to eliminate stale-state bugs

### Fixes

- Null guard in `RuleCache`, remove unused imports, fix Windows path in pre-write safety

### Refactoring

- Simplify `start-server.sh` -- remove `/reload` and `--rules-dir`

## 3.2.3

### Fixes

- Use `additionalContext` instead of `systemMessage` for warn rules (aligns with Claude Code hook schema)
- Strip project root in `matchFileCompiled` for absolute path matching on Windows

## 3.2.2

### Fixes

- Evaluate `contentPatterns` on PreToolUse in `/enforce` handler (content-based rules like `fetchxml-must-have-top` were previously only evaluated in PostToolUse where warnings don't surface)

## 3.2.0

### Performance

- Add `matcher` to `/enforce-tool` hook (PreToolUse): `Write|Edit|Bash|PowerShell|NotebookEdit`. Previously fired on ALL tool calls including Read, Grep, Glob, etc.
- Add `matcher` to `/post-tool` hook (PostToolUse): `Write|Edit|Bash|PowerShell|NotebookEdit`. Same reduction.
- Estimated ~50% fewer HTTP round-trips in a typical session (read-only tools now skip these hooks entirely at the harness level).

### Features

- Add `/pre-write` endpoint: project-specific safety checks for Write/Edit tools. Ported from the boomerang project's `pre-write.sh` command hook (~300-500ms) to an HTTP endpoint (~5-20ms).
  - Task file validation: detects production targeting (factories, connections, environments, URIs) and blocks/asks accordingly.
  - Security model config validation: detects prod org/URI misassignment to wrong environment_name.
  - Configurable via `$CLAUDE_PROJECT_DIR/.claude/safety-rules.json` with sensible defaults.
- Register `/pre-write` in plugin.json as PreToolUse hook with `matcher: "Write|Edit"`.

## 3.1.5

- Windows case-insensitive sourceRepo matching
- Show sourceRepo in rule list output

## 3.1.4

- Cross-repo rule isolation via sourceRepo scoping

## 3.1.3

- Fail-open for unknown POST routes (prevents 404 hook errors during version transitions)
- Null-safety in handlePostTool
