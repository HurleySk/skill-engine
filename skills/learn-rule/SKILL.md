---
name: learn-rule
description: Capture a lesson as an enforcement rule, update an existing rule's triggers, or promote a learned rule to permanent. Operates on learned-rules.json and skill-rules.json.
argument-hint: "[update <rule-name>|promote <rule-name>]"
---

# Skill Engine — Learn Rule

You help users capture lessons as enforcement rules, update existing rules, or promote learned rules to permanent status.

## Commands

- **(default)**: Capture a new lesson as a rule
- **update `<rule-name>`**: Modify an existing rule's triggers, enforcement, or priority
- **promote `<rule-name>`**: Move a learned rule from learned-rules.json to skill-rules.json

## Finding the Plugin Directory

To run backing code, find the skill-engine plugin directory:
```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Capturing a New Rule

### Step 1: Understand the Lesson

If the user provided the lesson as context from the triage router or as an argument, use that. Otherwise ask:

> "What should be enforced going forward?"

Accept natural language. Examples:
- "always use parameterized queries in SQL files"
- "don't modify files in the legacy/ directory"
- "warn when editing config files without a backup"

### Step 2: Infer Rule Details

Based on the lesson and conversation context, infer:

1. **Rule name**: Slugified from the lesson (e.g., `parameterized-queries-sql`). Lowercase, hyphens, no special characters.
2. **Type**: Almost always `guardrail` — the user wants enforcement.
3. **Enforcement**: Default to `warn` unless the user explicitly says "block" or "prevent."
4. **Priority**: Default to `medium`. Use `high` if emphasized. Use `critical` only for absolute statements.
5. **Triggers**:
   - Derive `pathPatterns` from file extensions or directories in context.
   - If specific content patterns mentioned, derive `contentPatterns`.
   - Keep patterns relative — use `**/*.sql` not absolute paths.
   - **CRITICAL (Windows):** All path patterns must use forward slashes. Never write backslashes.
6. **Description**: Clear, human-readable sentence that appears as the warning message.

### Step 3: Present the Proposed Rule

Show the complete rule for confirmation:

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

### Step 4: Save

On confirmation:

```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" add "<rule-name>" '<rule-json>'
```

Tell the user: Rule saved. It will fire next time a matching file is edited.

## Updating an Existing Rule

### Step 1: Identify the Rule

If a rule name was provided, look it up. Otherwise list rules and let the user pick:

```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" list
```

### Step 2: Show Current State

Display the rule's current configuration.

### Step 3: Collect Changes

Ask what to change. Common updates:
- Add file patterns: "also cover .psql files"
- Change enforcement: "make this a block instead of warn"
- Add prompt keywords: "also trigger on 'database' keyword"
- Change priority

### Step 4: Build Update JSON

Build a partial update object. For trigger arrays, only include new values to append — the backing code merges them:

```json
{
  "triggers": { "file": { "pathPatterns": ["**/*.psql"] } }
}
```

Show a before/after comparison and get confirmation.

### Step 5: Save

```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" update "<rule-name>" '<updates-json>'
```

To update a rule in skill-rules.json instead of learned-rules.json, use the `--file` flag:

```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" update "<rule-name>" '<updates-json>' --file .claude/skills/skill-rules.json
```

## Promoting a Learned Rule

### Step 1: Identify the Rule

If a rule name was provided, look it up. Otherwise list learned rules and let the user pick:

```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" list
```

### Step 2: Confirm Promotion

Show the rule and explain: "This will move the rule from learned-rules.json (auto-generated) to skill-rules.json (permanent, version-controlled). The rule behavior stays the same."

### Step 3: Promote

```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" promote "<rule-name>"
```

If the `--to` flag is not provided, the CLI auto-detects the project's skill-rules.json.

## Notes

- All path patterns must use forward slashes, even on Windows
- Update merges trigger arrays — existing patterns are preserved, new ones are appended
- Promote checks for name conflicts in the target file before moving
