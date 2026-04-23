# Skill Engine

Lesson capture and skill scaffolding for Claude Code projects.

## v2.0.0 — Breaking Change

**Hook-based activation and enforcement have been removed.**

### Why

Every Claude Code hook spawns a new process on each invocation. On Windows (Git Bash), each process spawn costs ~0.2-0.5s. Skill Engine v1 registered two hooks (activate on UserPromptSubmit, enforce on PreToolUse), which added ~0.5-0.7s of latency to every prompt submission and every tool call. This overhead scales linearly with the number of hooks and is unacceptable for interactive use.

Claude Code's built-in skill activation (prompt-matching in CLAUDE.md and plugin skill descriptions) handles the suggestion use case without process spawns. Guardrail enforcement is better done in project-specific hooks that only fire when needed, rather than a generic engine that runs on every action.

### What Remains

| Skill | Purpose | Status |
|---|---|---|
| `/skill-engine:learn-skill` | Capture a multi-step workflow as a reusable SKILL.md file | **Active** |
| `/skill-engine:learn` | Triage router — classifies a lesson and routes to the right sub-skill | **Active** |
| `/skill-engine:learn-rule` | Capture a lesson as an activation rule | **Deprecated** — feeds the removed hook system |
| `/skill-engine:learn-hook` | Capture a lesson as a Claude Code hook entry | **Deprecated** — feeds the removed hook system |
| `/skill-engine:setup` | Install hooks and scaffold rules | **Deprecated** — hooks removed |
| `/skill-engine:rules` | Add, list, and test activation rules | **Deprecated** — hooks removed |

### What Was Removed

- `hooks/activate.sh` and `hooks/enforce.sh` are no longer registered in the plugin config. The scripts remain on disk for reference but are not executed.
- `hooks/lib/engine.js` (the activation/enforcement engine) is no longer invoked by any hook.
- `skill-rules.json` is no longer read at runtime. Existing rule files are inert.

## Skills

### learn-skill (active)

Capture a multi-step workflow or process as a reusable SKILL.md file. Scaffolds project-local skills in `.claude/skills/`.

```
/skill-engine:learn-skill
```

### learn (active)

Triage router that classifies a lesson learned and routes to the appropriate sub-skill (rule, hook, or skill).

```
/skill-engine:learn
```

## Requirements

- **Node.js** (any recent version) — used by learn-skill for scaffolding
- **jq** — used by hook-helpers.sh (only needed if referencing the library from other hooks)
- Claude Code with skills support
- Bash (Git Bash on Windows)

## Migration from v1

If you previously installed skill-engine v1.x, you may have hook entries in your project's `.claude/settings.json` referencing `activate.sh` and `enforce.sh`. To clean up:

1. Open `.claude/settings.json` (or `settings.local.json`)
2. Find and remove any hook entries whose `command` references `skill-engine/hooks/activate.sh` or `skill-engine/hooks/enforce.sh`
3. The `skill-rules.json` file in your project can be deleted or kept for reference — it is no longer read at runtime

Alternatively, run `/skill-engine:setup` which will detect the v2 state and offer to remove stale hook entries.

## License

MIT
