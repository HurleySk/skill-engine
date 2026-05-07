---
name: skill-improve
description: Review accumulated skill feedback, identify improvement targets, propose and apply targeted skill edits. Use when skills have accumulated feedback or when you want to audit a specific skill.
argument-hint: "[skill-name | --lessons]"
---

# Skill Engine — Skill Improve

Review accumulated feedback about skills and propose targeted improvements. Works with both project-local skills and plugin (boomerang) skills.

**Invoke:** `/skill-engine:skill-improve`

## Finding the Plugin Directory

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Invocation Modes

- **(default)** — audit mode: reads feedback log, processes all flagged skills
- **`<skill-name>`** — target a specific skill by name
- **`--lessons`** — interactive: asks what went wrong, then finds relevant skill(s)

## Process

### Step 1: Gather Context

Check the skill-engine server for accumulated feedback:

```bash
curl -s http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-health
```

If invoked with a specific skill name, filter the feedback log for that skill. If `--lessons` mode, ask the user:

> "What went wrong or could be improved?"

Then search installed skills for relevance based on their description and content.

**Early exit:** If no flagged skills, no specific target, and no user-provided lessons, tell the user: "No skills have accumulated feedback. Use `/skill-engine:debrief` after sessions to capture feedback, or invoke with a specific skill name." Stop here.

For each flagged skill (or the targeted skill):
- Read the full SKILL.md content — check both plugin cache and project-local `.claude/skills/`
- Collect all unresolved signals for that skill from the feedback log

### Step 2: Dispatch Analysis Subagent

For each flagged skill, dispatch a `general-purpose` subagent with the skill content and all signals. Use this prompt:

~~~
You are a skill quality analyst. Review this skill definition and the accumulated user feedback to identify specific improvements.

## Skill Content

[Insert full SKILL.md content here]

## Accumulated Feedback Signals

[Insert all signals for this skill here]

## Analysis Instructions

1. For each feedback signal, identify which section of the skill is responsible. Quote the relevant lines.
2. Propose a **concrete edit** for each issue — show what the text says now and what it should say. Keep edits minimal and targeted.
3. Look for structural issues beyond what the signals report: overly rigid steps, vague instructions, missing edge cases, contradictory guidance.
4. **Boomerang check:** These skills run across many projects. Flag any proposed edit that seems project-specific vs. universally beneficial. Only propose universal improvements.
5. **Infrastructure gaps:** If the real fix isn't a skill edit but rather a skill-engine feature (e.g., conditional steps, project-type detection), flag it separately.

## Output Format

For each finding:

**Finding N: [title]**
- Signals: [which signals relate to this]
- Location: [line numbers or section name in the skill]
- Current text: [quote what's there now]
- Proposed edit: [what it should say instead]
- Scope: universal | project-specific
- Type: skill-edit | infrastructure-suggestion

End with a one-line summary: "N findings: X skill-edits, Y infrastructure suggestions"
~~~

### Step 3: Present Findings

For each skill, present the subagent's findings grouped:

```
[skill-name] — N corrections, M activations last 7 days

Skill Edits:
1. [title] (lines X-Y) — N signals
   Current: "..."
   Proposed: "..."

Infrastructure Suggestions:
- [description]
```

### Step 4: User Approves Per-Finding

For each finding, ask: **approve / edit / skip**

Apply approved edits to the skill file.

### Step 5: Edit Target Logic

- **Project-local skills** (`.claude/skills/`) → edit in place
- **Plugin skills** (in plugin cache at `~/.claude/plugins/cache/`) → check if the source repo exists locally (look for common paths like `~/source/repos/HurleySk/<plugin-name>`). If found, apply edit there and commit. If not, save proposed diffs to `pending-skill-improvements.md` in the current project for later application.

### Step 6: Clear Processed Feedback

After the user processes all findings for a skill, clear it:

```bash
curl -s -X POST http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-feedback/clear \
  -H 'Content-Type: application/json' \
  -d '{"skillName":"<skill-name>"}'
```

### Step 7: Summary

```
Skill improvement complete.
- [skill]: N edits applied, M skipped
- Infrastructure suggestions: N (saved to memory)
- Feedback log: N signals resolved, M remaining
```
