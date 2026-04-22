---
name: learn-hook
description: Capture a lesson as a Claude Code hook entry in settings.json. Creates PreToolUse, PostToolUse, or UserPromptSubmit hooks that run shell commands automatically.
argument-hint: "[list|remove]"
---

# Skill Engine — Learn Hook

You help users capture lessons as Claude Code hook entries in `.claude/settings.json`. Hooks run shell commands automatically in response to events — before tool use, after tool use, or on prompt submit.

## Commands

- **(default)**: Capture a new lesson as a hook
- **list**: Show all configured hooks
- **remove**: Remove a hook entry

## Finding the Plugin Directory

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Listing Hooks

```bash
node "$PLUGIN_DIR/hooks/lib/hook-manager.js" list
```

Show the output to the user.

## Removing a Hook

First list hooks to identify the entry. Then:

```bash
node "$PLUGIN_DIR/hooks/lib/hook-manager.js" remove "<hookType>" "<command>"
```

Where `<hookType>` is e.g. `PreToolUse` and `<command>` is the exact command string.

## Capturing a New Hook

### Step 1: Understand the Lesson

If the user provided context from the triage router, use that. Otherwise ask:

> "What should happen automatically? For example: 'lint Bicep files before saving', 'run tests after editing source files'"

### Step 2: Determine Hook Configuration

Based on the lesson, determine:

1. **Hook type** — When should this run?
   - `PreToolUse`: Before Claude uses a tool (Edit, Write, etc.) — good for linting, validation
   - `PostToolUse`: After Claude uses a tool — good for formatting, post-processing
   - `UserPromptSubmit`: When the user sends a message — good for context injection, checks

2. **Command** — What shell command should run?
   - Must be a valid bash command
   - Use `$CLAUDE_PROJECT_DIR` for project-relative paths
   - Example: `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/lint-bicep.sh"`

3. **Matcher** (PreToolUse and PostToolUse only) — Which tools trigger this?
   - Common matchers: `["Edit", "Write", "MultiEdit"]`, `["Bash"]`, `["Read"]`
   - Omit for UserPromptSubmit hooks

### Step 3: Present the Proposed Hook

Show the complete hook entry for confirmation:

```
Proposed hook:
  Type: PreToolUse
  Matcher: Edit, Write
  Command: bash "$CLAUDE_PROJECT_DIR/.claude/hooks/lint-bicep.sh"

JSON entry:
{
  "matcher": ["Edit", "Write"],
  "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/lint-bicep.sh\""
}

This will be added to .claude/settings.json under hooks.PreToolUse.
Want to adjust anything, or should I save this?
```

### Step 4: Check if the Hook Script Exists

If the command references a script file (e.g., `.claude/hooks/lint-bicep.sh`), check if it exists:
- If it exists, proceed to save.
- If it doesn't, ask: "The script doesn't exist yet. Want me to create a basic template?"
  - If yes, create the script with a shebang and placeholder logic, then `chmod +x` it.

### Step 5: Save

On confirmation, save via the backing code — **never construct settings.json manually**:

```bash
node "$PLUGIN_DIR/hooks/lib/hook-manager.js" add "<hookType>" '<entry-json>'
```

Where `<entry-json>` is the hook entry as a single-quoted JSON string.

Tell the user: Hook saved. It will fire automatically on the next matching event.

## Important

- **Never edit settings.json directly** — always use hook-manager.js to ensure safe read-modify-write.
- Hook entries are appended to existing arrays — other hooks are never removed or modified.
- The `command` field must be a string, `matcher` must be an array of tool name strings.
- Known hook types: UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop.
