# Skill Engine

Hook-driven skill activation and guardrail enforcement for Claude Code projects.

## What It Does

Skill Engine reads a `skill-rules.json` file from your project and uses Claude Code hooks to:

- **Suggest relevant skills** when your prompt mentions related topics (UserPromptSubmit)
- **Enforce guardrails** when editing files that match rule patterns (PreToolUse — can warn or block)
- **Skip intelligently** via env vars, file markers, or session-once tracking

## Quick Start

1. Install from marketplace:
   ```
   claude install hurleysk-marketplace/skill-engine
   ```

2. Set up in your project:
   ```
   /skill-engine:setup
   ```

3. Add rules:
   ```
   /skill-engine:rules add
   ```

## How It Works

```
User prompt → activate.sh → reads skill-rules.json → suggests matching skills
Claude edits → enforce.sh → reads skill-rules.json → blocks/warns on guardrail rules
```

### skill-rules.json

Lives at `.claude/skills/skill-rules.json` in your project. Each rule defines:

- **type**: `domain` (guidance) or `guardrail` (enforcement)
- **enforcement**: `suggest`, `warn`, or `block`
- **triggers**: prompt keywords/patterns and/or file path/content patterns
- **skipConditions**: env vars, file markers, session-once

See the [spec](docs/superpowers/specs/2026-04-19-skill-engine-design.md) for the full schema.

## Skills

| Skill | Purpose |
|---|---|
| `/skill-engine:setup` | Install hooks, scaffold rules, configure settings.json |
| `/skill-engine:rules` | Add, list, and test activation rules |

## Requirements

- Node.js (any recent version)
- Claude Code with hooks support
- Bash (Git Bash on Windows)

## License

MIT
