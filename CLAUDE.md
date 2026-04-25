# Skill Engine

Rule-based skill activation and guardrail enforcement for Claude Code. Persistent Node.js HTTP server, zero dependencies.

## Development

No package.json. Tests use the Node.js built-in test runner:

```bash
node --test tests/*.test.js
```

Server tests spawn real processes on ports 19751-19757. Ensure those ports are free before running tests.

## Architecture

- `hooks/start-server.sh` — server lifecycle (start, version-check, restart). Launched by SessionStart hook.
- `server/server.js` — HTTP server: `/health`, `/activate`, `/enforce`, `/reload`, `/pause`, `/resume`
- `hooks/lib/rules-io.js` — finds and loads `skill-rules.json` and `learned-rules.json`
- `hooks/lib/glob-match.js` — path pattern matching for file guardrails
- `hooks/lib/hook-manager.js` — validates and manages hooks in settings.json
- `hooks/lib/learn.js` — rule/skill classification
- `hooks/lib/skill-scaffold.js` — creates SKILL.md files
- `.claude-plugin/plugin.json` — plugin metadata, version, hook definitions
- `skills/` — SKILL.md files for each slash command

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

## Performance

The server runs on every tool call (`PreToolUse` for `Edit|Write|NotebookEdit`) and every prompt (`UserPromptSubmit`). All changes must be evaluated for latency impact:

- Rules are pre-compiled at startup (regex patterns, keyword lowercase, toolNames Sets)
- No per-request allocation or I/O beyond the rule evaluation itself
- `/health` tracks `avgResponseTimeMs` — target is under 25ms per request

## Windows Compatibility

- Use PowerShell `Stop-Process` for killing Node processes (POSIX `kill` fails silently on Windows)
- Normalize backslash paths with `normalizePath()` in `glob-match.js`
- Server launches via Git Bash (bash invoked from plugin.json SessionStart hook)
- Port-based kill fallback: `Get-NetTCPConnection` on Windows, `lsof` on Unix
