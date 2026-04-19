---
name: rules
description: Use when the user wants to add, edit, list, or test activation rules in their project's skill-rules.json. Guides creating trigger patterns for skill activation and guardrail enforcement.
argument-hint: "[add|list|test|help]"
---

# Skill Engine — Rules Management

You help users create and manage rules in `.claude/skills/skill-rules.json`. Each rule maps triggers (prompt keywords, file patterns) to skills (SKILL.md files) with optional enforcement.

## Commands

- **add** (default): Create a new rule interactively
- **list**: Show all current rules with their triggers and enforcement
- **test**: Test a rule against a sample prompt or file path
- **help**: Show this guide

## Adding a Rule

### Step 1: Read Current Rules

Read `.claude/skills/skill-rules.json`. If it doesn't exist, tell the user to run `/skill-engine:setup` first.

Show the current rules (if any):
```
Current rules:
  - sql-standards (guardrail/block) — triggers on: **/*.sql
  - pipeline-guidance (domain/suggest) — triggers on: "pipeline" keyword
```

### Step 2: Understand What to Protect/Guide

Ask the user:
1. **What guidance should activate?** (e.g., "SQL coding standards", "pipeline patterns")
2. **Where does this guidance live?** Options:
   - A section in CLAUDE.md → extract it into `.claude/skills/{name}/SKILL.md`
   - An existing marketplace skill → create a pointer
   - New guidance to write → create `.claude/skills/{name}/SKILL.md`
3. **How should it activate?** Options:
   - **suggest** — show a suggestion when the topic comes up (non-blocking)
   - **warn** — show a warning when editing matching files (non-blocking)
   - **block** — prevent edits until the skill is acknowledged (blocking)

### Step 3: Define Triggers

Build triggers based on the user's answers:

**Prompt triggers** (for suggest enforcement):
```json
"prompt": {
  "keywords": ["stored proc", "sproc"],
  "intentPatterns": ["(create|modify).*?proc"]
}
```

- Keywords: short phrases that appear in user prompts (case-insensitive)
- Intent patterns: regex matching user intent, not just keywords

**File triggers** (for warn/block enforcement):
```json
"file": {
  "pathPatterns": ["**/*.sql", "**/StoredProcedures/**"],
  "pathExclusions": ["**/migrations/**"],
  "contentPatterns": ["CREATE\\s+PROC"]
}
```

- Path patterns: glob patterns matching files (use `**` for recursive)
- Path exclusions: glob patterns to exclude from matching
- Content patterns: regex checked against file contents (only for `block` rules — expensive)

### Step 4: Define Skip Conditions

Ask if the user wants escape hatches:

```json
"skipConditions": {
  "fileMarkers": ["-- @skip-rule-name"],
  "envVars": ["SKIP_RULE_NAME"],
  "sessionOnce": true
}
```

- **fileMarkers**: comment at top of file to bypass the rule
- **envVars**: environment variable to set for bypassing
- **sessionOnce**: only suggest once per session (good for domain/suggest rules)

### Step 5: Extract Skill Content

If the user's guidance lives in CLAUDE.md:

1. Read the relevant section from CLAUDE.md
2. Create `.claude/skills/{rule-name}/SKILL.md` with the extracted content
3. Add minimal frontmatter:
   ```yaml
   ---
   name: {rule-name}
   description: {one-line description of what this skill covers}
   ---
   ```

### Step 6: Generate and Write the Rule

Build the complete rule JSON:

```json
"{rule-name}": {
  "type": "domain|guardrail",
  "enforcement": "suggest|warn|block",
  "priority": "critical|high|medium|low",
  "description": "Human-readable description",
  "skillPath": "./{rule-name}/SKILL.md",
  "triggers": { ... },
  "blockMessage": "...",
  "skipConditions": { ... }
}
```

Show the generated JSON to the user for approval. On approval, merge it into `.claude/skills/skill-rules.json`.

### Step 7: Test the Rule

Run a quick test:

```bash
# Test prompt trigger
echo '{"prompt":"<sample prompt>","session_id":"rule-test","cwd":"'$(pwd)'"}' \
  | bash .claude/hooks/skill-engine/activate.sh

# Test file trigger
echo '{"tool_name":"Edit","tool_input":{"file_path":"<sample file>"},"session_id":"rule-test","cwd":"'$(pwd)'"}' \
  | bash .claude/hooks/skill-engine/enforce.sh
echo "Exit code: $?"
```

Show the output and confirm the rule fires as expected.

## Listing Rules

Read `.claude/skills/skill-rules.json` and display a formatted summary:

```
Rules in this project:

  sql-standards
    Type: guardrail | Enforcement: block | Priority: critical
    Prompt: "stored proc", "sproc" | Intent: (create|modify).*?proc
    Files: **/*.sql (excl: **/migrations/**)
    Content: CREATE\s+PROC
    Skip: -- @skip-sql-standards, $SKIP_SQL_STANDARDS

  pipeline-guidance
    Type: domain | Enforcement: suggest | Priority: high
    Prompt: "pipeline", "ADF" | Intent: (debug|fix|create).*?pipeline
    Session once: yes
```

## Testing Rules

Accept a prompt string or file path and run it through the hooks, reporting what would fire:

```bash
# Prompt test
echo '{"prompt":"<user input>","session_id":"manual-test","cwd":"'$(pwd)'"}' \
  | bash .claude/hooks/skill-engine/activate.sh

# File test
echo '{"tool_name":"Edit","tool_input":{"file_path":"<path>"},"session_id":"manual-test","cwd":"'$(pwd)'"}' \
  | bash .claude/hooks/skill-engine/enforce.sh 2>&1
echo "Exit: $?"
```

## Trigger Pattern Reference

### Common Keyword Patterns
| Domain | Keywords |
|---|---|
| SQL/Database | stored proc, sproc, procedure, migration, schema |
| ETL/Pipeline | pipeline, ADF, data factory, ETL, data flow |
| Config | appsettings, connection string, environment |
| API | endpoint, route, controller, REST |
| Frontend | component, page, layout, CSS, styling |

### Common Intent Patterns
| Intent | Pattern |
|---|---|
| Creating something | `(create\|add\|implement\|build).*?(feature\|endpoint\|component)` |
| Modifying something | `(modify\|update\|change\|refactor).*?(procedure\|schema\|config)` |
| Debugging | `(debug\|fix\|troubleshoot\|investigate).*?(error\|bug\|issue)` |
| Testing | `(test\|write test\|add test).*?(for\|to verify)` |

### Common File Path Patterns
| Target | Pattern |
|---|---|
| All SQL files | `**/*.sql` |
| Stored procedures | `**/StoredProcedures/**` |
| Pipeline JSON | `**/pipeline/**/*.json` |
| Config files | `**/*.config`, `**/appsettings*.json` |
| C# files | `**/*.cs` |
| TypeScript | `**/*.ts`, `**/*.tsx` |
