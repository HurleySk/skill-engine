---
name: learn-skill
description: Capture a multi-step workflow or process as a reusable SKILL.md file. Scaffolds project-local skills in .claude/skills/.
argument-hint: "[list]"
---

# Skill Engine — Learn Skill

You help users capture workflows, processes, and multi-step knowledge as reusable SKILL.md files. Skills are project-local and auto-discovered by Claude Code.

## Commands

- **(default)**: Capture a new workflow as a skill
- **list**: Show all project-local skills

## Finding the Plugin Directory

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Listing Skills

```bash
node "$PLUGIN_DIR/hooks/lib/skill-scaffold.js" list --dir .claude/skills
```

## Capturing a New Skill

### Step 1: Understand the Workflow

If the user provided context from the triage router, use that. Otherwise ask:

> "What workflow or process should be captured? Describe it as you'd explain it to a colleague."

Probe for specifics:
- What triggers this workflow? ("When deploying...", "When debugging...", "When setting up...")
- What are the steps?
- Are there gotchas or things that commonly go wrong?
- What does success look like?

### Step 2: Draft the Skill Content

Write the skill body as clear instructions that another Claude session could follow. Structure it as:

1. **When to use** — one paragraph on when this skill applies
2. **Steps** — numbered steps with enough detail to execute without prior context
3. **Key principles** — important constraints or patterns to follow
4. **Common mistakes** — things that go wrong and how to avoid them (if applicable)

Keep it focused. A skill should capture one workflow, not an encyclopedia. Aim for 50-150 lines of useful content.

### Step 3: Choose a Name and Description

- **Name**: Short, descriptive. "Deploy Staging", "Debug Pipeline", "Setup Dev Environment"
- **Description**: One line explaining when to use this skill. This is what Claude Code shows in the skill list, so make it actionable: "Use when deploying changes to the staging environment" not "Staging deployment skill."

### Step 4: Present for Review

Show the complete SKILL.md content including frontmatter:

```
---
name: Deploy Staging
description: Use when deploying changes to the staging environment — covers cache flush, migrations, and smoke tests.
---

# Deploy Staging

## When to Use
...

## Steps
1. ...
2. ...

## Key Principles
- ...
```

Ask: "Want to adjust anything, or should I save this?"

### Step 5: Save

On confirmation:

```bash
node "$PLUGIN_DIR/hooks/lib/skill-scaffold.js" create "<name>" "<description>" "<body>" --dir .claude/skills
```

**Note:** For long body content that would exceed command-line argument limits, write the body to a temp file first, then use node to read and pass it:

```bash
# Write body to temp file
cat > /tmp/skill-body.md << 'SKILLEOF'
[body content here]
SKILLEOF

# Create via node directly
node -e "
const s = require('$PLUGIN_DIR/hooks/lib/skill-scaffold.js');
const fs = require('fs');
const body = fs.readFileSync('/tmp/skill-body.md', 'utf8');
const r = s.create('$NAME', '$DESC', body, '.claude/skills');
if (r.ok) console.log('Skill created at ' + r.path);
else { console.error('Error: ' + r.error); process.exit(1); }
"
```

Tell the user: Skill created at `.claude/skills/<slug>/SKILL.md`. It will be auto-discovered by Claude Code — no registration needed.

## Notes

- Skills are saved to `.claude/skills/<slug>/SKILL.md` — project-local, not part of the plugin
- Claude Code auto-discovers skills in `.claude/skills/` — no registration step needed
- The scaffold validates frontmatter structure before writing
- Skill names are slugified for the directory name (e.g., "Deploy Staging" → `deploy-staging/`)
