---
name: setup
description: Use when the user wants to set up skill-engine activation hooks in their project, or wants to uninstall them. Installs UserPromptSubmit and PreToolUse hooks that read skill-rules.json to suggest skills and enforce guardrails.
argument-hint: "[setup|uninstall|status|help]"
---

# Skill Engine — Setup

You are the installer for the Skill Engine hook infrastructure. You copy hook scripts into the user's project and wire them into `.claude/settings.json`.

## Commands

- **setup** (default): Install hooks and scaffold skill-rules.json
- **uninstall**: Remove hooks from settings.json and delete hook files
- **status**: Check if hooks are installed and working
- **help**: Show this guide

## Setup Process

### Step 1: Preflight Checks

1. Verify `node` is available (required):
   ```bash
   node --version
   ```
   If node is not available, stop — the engine requires Node.js.

2. Check for existing hooks in project's `.claude/settings.json`:
   - Look for existing `UserPromptSubmit` and `PreToolUse` entries
   - If CICD-Safety hooks exist (safety-gate.sh, guard-reminder.sh), note them — we will append alongside, not replace
   - Warn the user about any potential conflicts

3. Detect project structure:
   - Is there already a `.claude/skills/` directory?
   - Is there already a `.claude/hooks/` directory?
   - Are there `.sql` files, `pipeline/` dirs, or other patterns we can pre-populate rules for?

### Step 2: Copy Hook Files

Copy the hook scripts from the skill-engine plugin into the project:

```
.claude/
├── hooks/
│   └── skill-engine/
│       ├── activate.sh
│       ├── enforce.sh
│       └── lib/
│           └── engine.js
└── skills/
    └── skill-rules.json    ← scaffold if doesn't exist
```

The hook files are located in the skill-engine plugin directory at `hooks/`. Copy them to the project's `.claude/hooks/skill-engine/` directory.

To find the plugin directory, check:
```bash
ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/hooks/
```

Copy the entire `hooks/` subtree:
```bash
mkdir -p .claude/hooks/skill-engine/lib
cp -r <plugin-hooks-dir>/* .claude/hooks/skill-engine/
chmod +x .claude/hooks/skill-engine/activate.sh
chmod +x .claude/hooks/skill-engine/enforce.sh
```

### Step 3: Configure settings.json

Read the project's `.claude/settings.json` (create if it doesn't exist). Merge these hook entries:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/skill-engine/activate.sh\""
      }
    ],
    "PreToolUse": [
      {
        "matcher": ["Edit", "Write", "MultiEdit"],
        "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/skill-engine/enforce.sh\""
      }
    ]
  }
}
```

**IMPORTANT:** Do NOT overwrite existing hook entries. Append to existing arrays. Show the user a diff of what will change and get confirmation before writing.

### Step 4: Scaffold skill-rules.json

If `.claude/skills/skill-rules.json` doesn't exist, create it with auto-detected rules:

1. Scan the repo for common file types:
   - `.sql` files → suggest a SQL standards rule
   - `pipeline/` or `dataflow/` dirs → suggest a pipeline guidance rule
   - `appsettings*.json` or `*.config` → suggest a config safety rule
   - `CLAUDE.md` sections → suggest extracting into skills

2. Create the scaffold with 1-2 pre-populated rules based on what was found. Use the schema:

```json
{
  "version": "1.0",
  "defaults": {
    "enforcement": "suggest",
    "priority": "medium"
  },
  "rules": {}
}
```

3. Tell the user to use `/skill-engine:rules` to add more rules.

### Step 5: Verify Installation

Run a quick test to confirm hooks are working:

```bash
echo '{"prompt":"test activation","session_id":"setup-verify","cwd":"'$(pwd)'","hook_event_name":"UserPromptSubmit"}' \
  | bash .claude/hooks/skill-engine/activate.sh
```

If the output is empty (no matching rules yet) or shows formatted suggestions, the hook is working. If there's an error, troubleshoot.

## Uninstall Process

1. Remove skill-engine hook entries from `.claude/settings.json` (keep other hooks)
2. Delete `.claude/hooks/skill-engine/` directory
3. Do NOT delete `.claude/skills/` — that's the user's content
4. Report what was removed

## Status Check

1. Check if `.claude/hooks/skill-engine/` exists
2. Check if `.claude/settings.json` has skill-engine hook entries
3. Check if `.claude/skills/skill-rules.json` exists and is valid JSON
4. Report status of each component

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "hook error" banner in Claude Code | Hook script error | Check `node --version`, ensure engine.js exists |
| No suggestions appearing | Rules don't match | Test with: `echo '{"prompt":"your prompt","cwd":"'$(pwd)'"}' \| bash .claude/hooks/skill-engine/activate.sh` |
| Block not firing | Rule type not "guardrail" or enforcement not "block" | Check skill-rules.json rule configuration |
| Hook too slow | Large skill-rules.json or slow disk | Keep rules under 50 entries |
