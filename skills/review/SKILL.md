---
name: review
description: Use when starting a workstream, after refactors, or periodically — audits the project's Claude configuration (CLAUDE.md, skills, rules, hooks, MCP) against the actual codebase and offers to fix what it finds.
---

# Skill Engine — Review

Holistically audit a project's Claude configuration and cross-reference it against the actual codebase. Treats CLAUDE.md, skills, rules, hooks, and MCP config as one interconnected system. Reports findings and offers to fix them through existing skill-engine workflows.

## When to Use

- Starting a new workstream in an established project
- After major refactors that change directory structure or file patterns
- When skills or rules feel stale or outdated
- Periodically as configuration hygiene
- After adding new skills, rules, or hooks

## Finding the Plugin Directory

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Steps

### Step 1: Gather Current State

Collect the raw configuration data. Read these files in parallel (skip any that don't exist):

- `CLAUDE.md` (project root)
- `.claude/settings.json`
- `.claude/settings.local.json`
- `.claude/skills/skill-rules.json`
- `.claude/skills/learned-rules.json`
- `.mcp.json` (project root)

Also run these commands:

**Server health:**
```bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
```

**Learned rules:**
```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" list
```

**Project-local skills:**
```bash
ls .claude/skills/*/SKILL.md 2>/dev/null
```

Read each discovered SKILL.md file.

**Early exit:** If none of these files or directories exist, tell the user: "No Claude configuration found in this project. Consider running `/skill-engine:learn` to start capturing rules, or create a CLAUDE.md." Stop here.

### Step 2: Dispatch Audit Subagent

Dispatch a single Agent subagent with `subagent_type: "general-purpose"`. Include all gathered data from Step 1 as context in the prompt.

Use this subagent prompt (insert the gathered data where indicated):

~~~
You are a Claude Code configuration auditor. Analyze the Claude configuration ecosystem for this project as one interconnected system and cross-reference it against the actual codebase.

## Configuration Data

[Insert all gathered config file contents, server health, rule listings, and skill listings here]

## Audit Checks

Perform ALL of the following. For each finding, output a structured item in a findings list.

### 1. CLAUDE.md Accuracy
- Does CLAUDE.md exist? If not, that is a critical finding.
- Read the project's actual directory structure (ls top-level and key subdirectories).
- Does CLAUDE.md reference files, directories, or technologies that don't exist in the project?
- Does CLAUDE.md omit important aspects of the actual project structure?
- Are build/test commands in CLAUDE.md still correct? (Check package.json, Makefile, etc.)

### 2. Skill Validity
For each SKILL.md in .claude/skills/:
- Does it reference files or paths that actually exist? (Use Glob to check)
- Does it reference tools, commands, or patterns that match the current project?
- Is the description still accurate given the current state of the project?
- Are there SKILL.md files that overlap significantly in scope?

### 3. Rule Validity
For each rule in skill-rules.json and learned-rules.json:
- Do the pathPatterns match any actual files in the project? (Use Glob)
- If the rule has a skillPath, does that skill file exist?
- If the rule has contentPatterns, do any matching files actually contain that content?
- Are there duplicate or conflicting rules (same pathPatterns, different enforcement)?
- Are all regex patterns in intentPatterns and contentPatterns valid?

### 4. Rule Coverage Gaps
- Look at the project's actual file types and directory structure.
- Are there significant file types (e.g., .sql, .bicep, .tf, .yaml pipeline files) with no corresponding rules?
- Are there directories that seem important (config/, infrastructure/, migrations/) with no guardrails?
- Are there areas described in CLAUDE.md that have no matching skill or rule?

### 5. Learned Rule Maturity
For each rule in learned-rules.json:
- Is it well-formed and specific enough to promote to skill-rules.json?
- Flag promotable rules as medium-severity findings.

### 6. Hook Configuration
Read .claude/settings.json hooks section (if it exists).
- Are there hooks that reference commands or paths that don't exist?
- Are there performance concerns? (command hooks on PreToolUse are expensive)
- Are matchers present on tool-specific hooks?
- Cross-reference with any plugin.json hooks — are they compatible?

### 7. MCP Configuration
If .mcp.json exists:
- Are the configured servers relevant to the project?
- Do any skills or CLAUDE.md reference tools that depend on MCP servers not configured?

## Output Format

For each finding, report:

**[SEVERITY] Title** (type: finding-type)
File: path/to/affected/file
Detail: Full explanation
Suggestion: Specific fix

Valid types: stale-skill, stale-rule, missing-rule, missing-skill, promote-rule, claude-md-drift, config-issue, rule-conflict
Valid severities: CRITICAL, HIGH, MEDIUM, LOW

Only report genuine issues. If a config surface is healthy, say "No issues found" for that section and move on. Do not pad findings to look comprehensive.

End with a one-line summary: "N findings: X critical, Y high, Z medium, W low" (or "Configuration looks healthy — no issues found").
~~~

### Step 3: Present Findings

Parse the subagent's findings and present them to the user:

**If no findings:**
> Configuration looks healthy. No issues found across the audit.

**If findings exist, group by severity:**

> **Configuration Review — N findings**
>
> **Critical** (if any)
> - [title] — [detail]
>   Suggested fix: [suggestion]
>
> **High** (if any)
> - [title] — [detail]
>   Suggested fix: [suggestion]
>
> **Medium / Low** (listed as recommendations, not expanded)

### Step 4: Act on Findings

For each critical and high finding, offer to fix it. **Ask the user before each action.** Route to the appropriate remediation:

| Finding Type | Action |
|---|---|
| `stale-rule` | "Want me to update this rule?" Follow `/skill-engine:learn-rule update` with the rule name and suggested changes |
| `stale-skill` | "Want me to update this skill?" Read the skill file and edit it directly |
| `missing-rule` | "Want me to create a rule for this?" Follow `/skill-engine:learn-rule` with the suggested rule details |
| `missing-skill` | "Want me to create a skill for this?" Follow `/skill-engine:learn-skill` with the workflow description |
| `promote-rule` | "Want me to promote this to permanent?" Follow `/skill-engine:learn-rule promote` |
| `claude-md-drift` | "Want me to update CLAUDE.md?" Edit it directly |
| `config-issue` | "Want me to fix this?" Edit the config file directly, or suggest `/skill-engine:perf-check` for hook issues |
| `rule-conflict` | "These rules conflict — which should take precedence?" Present options and let user decide |

After processing all actionable findings (or if the user declines all), summarize:

> **Review complete.** Fixed: N | Skipped: N | Remaining recommendations: [list medium/low if any]

## Proactive Nudge (Optional)

To get reminded to run a review on relevant prompts, add this rule to your project's `.claude/skills/skill-rules.json`:

```json
"review-nudge": {
  "type": "domain",
  "enforcement": "suggest",
  "priority": "low",
  "description": "Consider running /skill-engine:review to audit your Claude configuration for stale skills, drifted CLAUDE.md, and missing rules.",
  "skillPath": ".claude/skills/review/SKILL.md",
  "triggers": {
    "prompt": {
      "keywords": ["review config", "check skills", "audit config", "update skills", "review rules", "check setup", "stale", "out of date"],
      "intentPatterns": ["(review|audit|check).*(config|skill|rule|setup|claude)"]
    }
  },
  "skipConditions": {
    "sessionOnce": true
  }
}
```

For a more aggressive nudge that fires on the first prompt of every session, replace the triggers with:

```json
"triggers": {
  "prompt": {
    "intentPatterns": [".*"]
  }
}
```

Add `"envVars": ["SKIP_REVIEW_NUDGE"]` to `skipConditions` to allow opting out.

## Notes

- This skill adds zero latency to the skill-engine hot path — it is purely on-demand.
- The subagent does the analysis; this skill handles presentation and routing.
- Each fix requires user confirmation — nothing is auto-applied.
- For large projects, the subagent may take 30-60 seconds to complete the audit.
- Run `/skill-engine:status` first if you suspect the server is not running.
