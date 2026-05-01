# Changelog

## 3.3.5

### Fixes

- File guardrail `contentPatterns` now enforced for `warn` rules, not just `block`. Previously, `warn` rules with `contentPatterns` would match on path patterns alone (ignoring file content), while the secondary check only tested the edit diff text — not the full file. Now `matchFileCompiled` reads the full file for all enforcement levels.
- Address code review: missing test, `/set-project` fallback, Date perf

## 3.3.4

### Features

- Session-keyed isolation: session registry replaces `lastProjectDir` for multi-session support
- Multi-key `RuleCache` with LRU eviction
- `/health` shows per-session state, `/rules` accepts session scoping
- Simplified `start-server.sh` with `register_session`

### Fixes

- PostToolUse matcher includes `Read|Grep|Glob` (#6)
- Session cleanup sweeps registry alongside `firedRules`
- Remove self-upgrade logic from `server.js`

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
- Evaluate `contentPatterns` on PreToolUse in `/enforce` handler

## 3.2.2

### Fixes

- Evaluate `contentPatterns` on PreToolUse in `/enforce` handler (content-based rules like `fetchxml-must-have-top` were previously only evaluated in PostToolUse where warnings don't surface)

## 3.2.0

### Performance

- Add `matcher` to `/enforce-tool` hook (PreToolUse): `Write|Edit|Bash|PowerShell|NotebookEdit`. Previously fired on ALL tool calls including Read, Grep, Glob, etc.
- Add `matcher` to `/post-tool` hook (PostToolUse): `Write|Edit|Bash|PowerShell|NotebookEdit`. Same reduction.
- Estimated ~50% fewer HTTP round-trips in a typical session (read-only tools now skip these hooks entirely at the harness level).

### Features

- Add `/pre-write` endpoint: project-specific safety checks for Write/Edit tools
  - Task file validation: detects production targeting (factories, connections, environments, URIs) and blocks/asks accordingly
  - Security model config validation: detects prod org/URI misassignment to wrong environment_name
  - Configurable via `$CLAUDE_PROJECT_DIR/.claude/safety-rules.json` with sensible defaults
- Register `/pre-write` in plugin.json as PreToolUse hook with `matcher: "Write|Edit"`

## 3.1.6

### Fixes

- Windows case-insensitive `sourceRepo` matching
- Show `sourceRepo` in rule list output

## 3.1.5

### Fixes

- Cross-repo rule isolation via `sourceRepo` scoping (#4)

## 3.1.4

### Fixes

- Fail-open for unknown POST routes (prevents 404 hook errors during version transitions)
- Null-safety in `handlePostTool`

## 3.1.3

### Features

- Server-based hook rules: `/enforce-tool`, `/post-tool`, `/stop` endpoints
- Rule-review skill

## 3.1.2

### Features

- Add `/review` skill for holistic Claude config auditing with proactive nudge

## 3.1.1

### Fixes

- `/reload` accepts `rulesDir` to support multi-project sessions (#3)

## 3.1.0

### Fixes

- Resolve `RULES_DIR` when `CLAUDE_PROJECT_DIR` is unset (#2)

### Docs

- Add CLAUDE.md with development and release procedures
- Update README version history

## 3.0.9

### Fixes

- Use PowerShell to kill server on Windows (POSIX `kill` fails silently)

## 3.0.8

### Fixes

- Handle pre-3.0.7 servers with no `pid` in health response (port-kill fallback)

## 3.0.7

### Fixes

- Fix false-positive enforcement on read-only tools
- Add version-aware restart to `start-server.sh`
- Align hook-manager tests with implementation

## 3.0.6

### Features

- Add pause/resume endpoints to eliminate `ECONNREFUSED` on stop

### Refactoring

- Extract `rules-io.js` from `engine.js`, delete command hook path

### Fixes

- Use Claude Code `hookSpecificOutput` schema for HTTP hook responses

## 3.0.5

### Fixes

- Only auto-bump version on `[release]` commits (stop spurious CI bumps)
- Correct hook nesting in `plugin.json` for Claude Code validator

## 3.0.3

### Fixes

- Pass `--rules-dir` to server in start script, fix empty stderr

## 3.0.2

### Features

- Add `X-Response-Time` header and timing stats to server

## 3.0.1

### Features

- Add `perf-check` skill for Claude Code performance auditing

### Chore

- Remove deprecated skills and old hook scripts for v3

## 3.0.0

### Features

- HTTP server-based architecture replaces command hooks for activation and enforcement
- Add HTTP server with `/health`, `/activate`, `/enforce`, `/reload` endpoints
- Add `start-server.sh` lifecycle script
- Add `start`, `stop`, `status` lifecycle skills
- HTTP hooks for `UserPromptSubmit` (activation) and `PreToolUse` (enforcement)

### Refactoring

- Remove `fileMarkers` skip condition from engine

### Fixes

- Add request body size limit to HTTP server

## 2.0.0

### Breaking

- Remove hook-based activation and enforcement for performance (shell hooks too slow; replaced by HTTP server in v3)

## 1.2.4

### Performance

- Replace `node` with `jq` in `hook-helpers.sh` for faster JSON parsing

## 1.2.2

### Fixes

- `hook-manager` uses correct Claude Code format (`matcher` string + `hooks` array)

## 1.2.0

### Features

- Rewrite `/learn` skill as triage router dispatching to sub-skills
- Add `/learn-rule` skill: create, update, promote enforcement rules
- Add `/learn-hook` skill: capture lessons as Claude Code hooks
- Add `/learn-skill` skill: scaffold SKILL.md files from lessons
- Add `hook-manager.js`: CRUD for Claude Code hooks in `settings.json`
- Add `skill-scaffold.js`: create and list SKILL.md files
- Add `update()` and `promote()` to `learn.js` with CLI support

### Fixes

- Normalize paths before dedup in `update()` to handle cross-format duplicates
- Review findings: stale description, corrupt JSON guard, clean docs
- Setup skill copies `hook-manager.js` and `skill-scaffold.js`

## 1.1.0

### Features

- Add shared `hook-helpers.sh` (deny/ask/parse_command) for bash hooks
- Add shared `glob-match.js` module with tests

### Refactoring

- `engine.js` imports glob matching from shared module
- Extract glob tests to `glob-match.test.js`

## 1.0.1

### Features

- `learn.js` CRUD: add, list, remove learned rules
- `learn.js` CLI entry point: add, list, remove commands
- Engine loads and merges `learned-rules.json` alongside `skill-rules.json`
- Learn SKILL.md: conversational UX for capturing lessons as rules
- Integration test for learned rule enforcement

### Refactoring

- Deduplicate `loadLearnedFile` by reusing `loadRules` from `engine.js`
- Extract `findFileInAncestors` helper, default enforcement to warn

### Fixes

- Reject empty rule names in `learn.js add()`
- Clean up test imports and suppress stderr noise in CLI tests
- Trigger CI on `master` branch, not `main`
- Point README schema reference to rules SKILL.md instead of dead spec link

## 1.0.0

### Features

- Core engine: rules loading with `findRulesFile` and `loadRules`
- Core engine: prompt matching with keywords and intent patterns
- Core engine: file path matching with glob patterns, exclusions, and content checks
- Core engine: skip conditions with env vars, file markers, and `sessionOnce`
- Activate hook: `UserPromptSubmit` skill suggestion with priority sorting and `sessionOnce`
- Enforce hook: `PreToolUse` guardrail enforcement with block/warn and skip conditions
- Setup skill: installation, uninstall, and status checking
- Rules skill: interactive rule creation, listing, and testing
- README and CI/CD version-bump workflow
- Project scaffold with `plugin.json`, license, and test fixtures

### Fixes

- Add try/catch around regex compilation in `matchIntent` and `matchContent`
