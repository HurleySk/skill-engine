# Changelog

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
