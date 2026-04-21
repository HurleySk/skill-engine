---
name: learn
description: Use when the user wants to capture a lesson learned as an enforcement rule. Persists best practices from the current session into learned-rules.json so they are automatically enforced in future edits.
argument-hint: "[list|remove <rule-name>]"
---

# Skill Engine — Learn

You help users capture lessons learned during agent sessions and persist them as enforcement rules. Rules are saved to `learned-rules.json` and automatically enforced by the existing skill-engine hooks.

## Commands

- **(default)**: Capture a new lesson as a rule
- **list**: Show all learned rules
- **remove `<rule-name>`**: Remove a learned rule

## Listing Rules

Run:
```bash
node "<PLUGIN_DIR>/hooks/lib/learn.js" list
```

Where `<PLUGIN_DIR>` is the skill-engine plugin directory. To find it:
```bash
ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/
```

Show the output to the user.

## Removing a Rule

Run:
```bash
node "<PLUGIN_DIR>/hooks/lib/learn.js" remove "<rule-name>"
```

Confirm to the user that the rule was removed.

## Capturing a New Lesson

### Step 1: Understand the Lesson

If the user provided the lesson as an argument, use that. Otherwise ask:

> "What should be enforced going forward?"

Accept natural language. Examples:
- "always use parameterized queries in SQL files"
- "don't modify files in the legacy/ directory"
- "warn when editing config files without a backup"

### Step 2: Infer Rule Details from Context

Based on the lesson and the current conversation context, infer:

1. **Rule name**: Slugified from the lesson (e.g., `parameterized-queries-sql`). Lowercase, hyphens, no special characters.

2. **Type**: Almost always `guardrail` — the user wants enforcement, not just suggestions.

3. **Enforcement**: Default to `warn` unless the user explicitly says "block" or "prevent."

4. **Priority**: Default to `medium`. Use `high` if the user emphasizes importance. Use `critical` only if they say "always" + "never" type absolutes.

5. **Triggers**:
   - Look at what file the user is currently editing or was recently editing. Derive `pathPatterns` from the file extension or directory.
   - If the lesson mentions specific content patterns (e.g., "string concatenation"), derive `contentPatterns`.
   - Keep patterns **relative** — use `**/*.sql` not absolute paths.
   - **CRITICAL (Windows):** All path patterns must use forward slashes. Never write backslashes into patterns. If you derive a pattern from a Windows file path, convert backslashes to forward slashes.

6. **Description**: A clear, human-readable sentence that will appear as the warning message.

### Step 3: Present the Proposed Rule

Show the user the complete rule for confirmation:

```
Proposed rule: parameterized-queries-sql
Type: guardrail | Enforcement: warn | Priority: medium
Triggers: **/*.sql files
Message: "Use parameterized queries — avoid string concatenation in SQL"

Full JSON:
{
  "type": "guardrail",
  "enforcement": "warn",
  "priority": "medium",
  "description": "Use parameterized queries — avoid string concatenation in SQL",
  "triggers": {
    "file": {
      "pathPatterns": ["**/*.sql"]
    }
  }
}

Want to adjust anything, or should I save this?
```

### Step 4: Revise or Save

If the user wants changes, update the rule and re-present.

On confirmation, save the rule:

```bash
node "<PLUGIN_DIR>/hooks/lib/learn.js" add "<rule-name>" '<rule-json>'
```

The `<rule-json>` argument is the complete rule object as a single-quoted JSON string.

If the `--file` flag is not provided, `learn.js` automatically finds (or creates) `learned-rules.json` in the project's `.claude/skills/` directory.

### Step 5: Confirm

Tell the user:

> "Rule `<rule-name>` saved. It will fire as a **warn** next time you edit a matching file. Use `/skill-engine:learn list` to see all learned rules, or `/skill-engine:learn remove <rule-name>` to delete one."

## Notes

- Learned rules live in `.claude/skills/learned-rules.json`, separate from hand-authored `skill-rules.json`
- The engine merges both files automatically — no setup needed beyond having skill-engine installed
- Default enforcement is `warn` (non-blocking). Users can edit `learned-rules.json` directly to change a rule to `block`
- All path patterns must use forward slashes, even on Windows
