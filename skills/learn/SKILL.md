---
name: learn
description: Capture a lesson learned as a rule or skill — classifies and routes to the right sub-skill.
argument-hint: "[list|remove <rule-name>]"
---

# Skill Engine — Learn

You help users capture lessons learned during agent sessions and persist them as the right artifact — a rule or a skill.

## Commands

- **(default)**: Capture a new lesson (classifies and routes)
- **list**: Show all learned rules
- **remove `<rule-name>`**: Remove a learned rule

## Finding the Plugin Directory

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Listing Learned Rules

Run:
```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" list
```

Show the output to the user.

## Removing a Learned Rule

Run:
```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" remove "<rule-name>"
```

Confirm to the user that the rule was removed.

## Capturing a New Lesson

### Step 1: Understand the Lesson

If the user provided the lesson as an argument, use that. Otherwise ask:

> "What did you learn that should be captured for future sessions?"

### Step 2: Classify the Lesson

Based on what the user described, determine the best artifact type:

| Signal | Artifact | Route to |
|---|---|---|
| "warn/block/never/always when editing X files" | Enforcement rule | `/skill-engine:learn-rule` |
| "block/warn when running bash commands that do X" | Tool enforcement rule | `/skill-engine:learn-rule` |
| "after editing X files, remind me to Y" | Post-tool guidance rule | `/skill-engine:learn-rule` |
| "at the end of every turn, remind me to X" | Stop guidance rule | `/skill-engine:learn-rule` |
| "when doing X, follow these steps", multi-step process | Reusable skill | `/skill-engine:learn-skill` |
| "update/change that rule to also cover..." | Rule update | `/skill-engine:learn-rule update` |
| "make that learned rule permanent" | Rule promotion | `/skill-engine:learn-rule promote` |

**If ambiguous**, ask one clarifying question.

### Step 3: Route

Once classified, tell the user what you're doing and follow the appropriate sub-skill:

- **Rule**: Follow `/skill-engine:learn-rule`
- **Skill**: Follow `/skill-engine:learn-skill`

Pass along the lesson context so the user doesn't have to re-explain.
