# Skill Engine

Rule-based skill activation and guardrail enforcement for Claude Code. Persistent Node.js HTTP server, zero dependencies.

## Development

No package.json. Tests use the Node.js built-in test runner:

```bash
node --test tests/*.test.js
```

Server tests spawn real processes on ports 19751-19785. Ensure those ports are free before running tests. Modules with persistent state (e.g., `skill-feedback.js`) must support a env var override for their storage directory so test servers get isolated state — see `SKILL_FEEDBACK_DIR` pattern in `test-harness.js`.

## Architecture

- `hooks/start-server.sh` — server lifecycle (start, version-check, restart). Launched by SessionStart hook.
- `server/server.js` — HTTP server: `/health`, `/activate`, `/pre-tool`, `/enforce`, `/enforce-tool`, `/post-tool`, `/pre-write`, `/stop`, `/register-session`, `/pause`, `/resume`, `/skill-feedback`, `/skill-health`, `/skill-feedback/clear`, `/skill-feedback/signals` (`/set-project` deprecated)
- `server/skill-feedback.js` — feedback signal recording, threshold tracking, health reporting for the skill improvement feedback loop
- `server/pre-write-safety.js` — production safety validation for task files and security model configs
- `hooks/lib/rules-io.js` — finds and loads `skill-rules.json` and `learned-rules.json`
- `hooks/lib/glob-match.js` — path pattern matching for file guardrails
- `hooks/lib/learn.js` — rule/skill classification
- `hooks/lib/skill-scaffold.js` — creates SKILL.md files
- `.claude-plugin/plugin.json` — plugin metadata, version, hook definitions
- `skills/` — SKILL.md files for each slash command (includes `skill-improve`, `debrief`, `using-skill-engine-skills`)

## Release Procedure

1. Commit changes with conventional prefixes: `feat:`, `fix:`, `perf:`, `docs:`, `refactor:`, `test:`
2. When ready to release, commit with `[release]` in the message:
   ```bash
   git commit -m "[release] description of what changed"
   ```
3. Push to master. CI (`.github/workflows/version-bump.yml`) will:
   - Bump patch version in `.claude-plugin/plugin.json`
   - Commit as `[release] vX.Y.Z` and create git tag
   - Dispatch update to HurleySk/claude-plugins-marketplace
4. Pull to get the CI bot's version bump commit:
   ```bash
   git pull
   ```
5. After `/reload-plugins` in a session, run `/skill-engine:start` to restart the server to the new version.

Multiple fix commits can precede a single `[release]` commit. Non-release pushes sync the current version to the marketplace without bumping.

## Cross-Repo Rule Scoping

Learned rules are auto-stamped with `sourceRepo` (the normalized `CLAUDE_PROJECT_DIR` at learn time). At enforcement time, each request derives its project root from its `session_id` (looked up in the session registry), `env.CLAUDE_PROJECT_DIR` (per-request override), or `process.env.CLAUDE_PROJECT_DIR` (startup fallback). Sessions are registered via `POST /register-session` called by the SessionStart hook. Rules with a `sourceRepo` that doesn't match the request's project root are skipped. Rules without `sourceRepo` are treated as global and match everywhere (backward compatible).

## Performance

The server runs on mutation tool calls (`PreToolUse` via consolidated `/pre-tool` for `Write|Edit|Bash|PowerShell|NotebookEdit`), every prompt (`UserPromptSubmit`), and mutation tools for output triggers (`PostToolUse` for `Write|Edit|Bash|PowerShell|NotebookEdit`). A single PreToolUse hook replaces the previous 3 separate hooks, reducing HTTP round-trips from 3 to 1. All changes must be evaluated for latency impact:

- Rules are compiled on first access and cached; `fs.statSync` (~0.1ms) on each request checks if rule files changed
- No recompilation unless file mtime actually changes
- `/health` tracks `avgResponseTimeMs` — target is under 25ms per request
- PostToolUse hooks fire on mutation tools only. The `hasOutputTriggerRules` fast-path returns empty immediately when no output triggers exist
- Multi-key rule cache (keyed by rulesDir) eliminates recompilation when switching projects

## Windows Compatibility

- Use PowerShell `Stop-Process` for killing Node processes (POSIX `kill` fails silently on Windows)
- Normalize backslash paths with `normalizePath()` in `glob-match.js`
- Server launches via Git Bash (bash invoked from plugin.json SessionStart hook)
- Port-based kill fallback: `Get-NetTCPConnection` on Windows, `lsof` on Unix
