---
name: rule-review
description: Audit skill-engine rules for validity, conflicts, dead patterns, coverage gaps, and hook event usage. Focused on rules specifically, not the broader Claude config ecosystem.
---

# Skill Engine — Rule Review

Audit all configured skill-engine rules for correctness, conflicts, and coverage. Unlike `/skill-engine:review` (which audits the entire Claude config ecosystem), this skill focuses specifically on the rule system.

## When to Use

- After adding or modifying rules
- When rules feel stale or aren't firing as expected
- After major refactors that change directory structure or file types
- To discover whether new hook event capabilities (tool triggers, PostToolUse, Stop) are being used

## Finding the Plugin Directory

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Steps

### Step 1: Gather State

Read these files in parallel (skip any that don't exist):

- `.claude/skills/skill-rules.json`
- `.claude/skills/learned-rules.json`

Also run:

**Server health:**
```bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
```

**Learned rules list:**
```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" list
```

**Early exit:** If no rule files exist and the server has 0 rules loaded, tell the user: "No rules configured. Use `/skill-engine:learn-rule` to create your first rule." Stop here.

### Step 2: Dispatch Audit Subagent

Dispatch a single Agent subagent with `subagent_type: "general-purpose"`. Include all gathered data from Step 1 as context in the prompt.

Use this subagent prompt (insert the gathered data where indicated):

~~~
You are a skill-engine rule auditor. Analyze the rule configuration for this project and cross-reference rules against the actual codebase.

## Rule Data

[Insert skill-rules.json contents, learned-rules.json contents, server health output, and learned rules list here]

## Audit Checks

Perform ALL of the following. For each finding, output a structured item in a findings list.

### 1. Rule Validity
For each rule in both files:
- Are required fields present (type, description, triggers)?
- Is type a valid value ("domain" or "guardrail")?
- Is enforcement a valid value ("suggest", "warn", or "block")?
- Are all regex patterns in intentPatterns, contentPatterns, inputPatterns, and outputPatterns valid? (Try constructing them)
- Do pathPatterns use forward slashes only (not backslashes)?
- If skillPath is set, does the file exist? (Use Glob to check)
- If hookEvents is set, is it an array containing valid event names ("PreToolUse", "PostToolUse", "Stop")?
- If enforcement is "block" on a rule with triggers.output or hookEvents:["Stop"], flag it — PostToolUse and Stop cannot block.

### 2. Rule Conflicts
- Are there rules with overlapping pathPatterns but different enforcement levels?
- Are there rules with the same toolNames in triggers.tool but contradictory enforcement?
- Are there duplicate rules (same triggers, different names)?

### 3. Dead Rules
For each rule with triggers.file.pathPatterns:
- Do the patterns match any actual files? (Use Glob for each pattern)
- Flag rules whose patterns match zero files as potentially dead.

For each rule with triggers.tool.toolNames:
- Are the tool names valid Claude Code tools? (Bash, PowerShell, Edit, Write, Read, Grep, Glob, NotebookEdit, Agent, etc.)

### 4. Coverage Gaps
- Run `ls` on top-level and key subdirectories to see the project's file landscape.
- Are there significant file types (.sql, .bicep, .tf, .yaml, .json config, .env) with no corresponding file rules?
- Are there important directories (config/, infrastructure/, migrations/, deploy/) with no guardrails?

### 5. Learned Rule Maturity
For each rule in learned-rules.json:
- Is it well-formed with specific triggers (not overly broad)?
- Has it been stable long enough to promote? (Flag as medium-severity recommendation)

### 6. Hook Event Coverage
- Are there any rules using triggers.tool? If not, inform that tool-level enforcement is available (e.g., block dangerous Bash commands).
- Are there any rules using triggers.output? If not, inform that PostToolUse guidance is available (e.g., remind to test after edits).
- Are there any rules with hookEvents:["Stop"]? If not, inform that end-of-turn reminders are available.
- Check server health: do hasToolTriggerRules, hasOutputTriggerRules, hasStopRules match what's in the rule files?

### 7. Server Health Cross-Check
- Does rulesLoaded in /health match the total count of rules in both files?
- Is the server paused? If so, warn that no rules are being enforced.
- Is avgResponseTimeMs above 25ms? If so, flag a performance concern.

## Output Format

For each finding, report:

**[SEVERITY] Title** (type: finding-type)
File: path/to/affected/file
Detail: Full explanation
Suggestion: Specific fix

Valid types: invalid-rule, dead-rule, rule-conflict, coverage-gap, promote-rule, hook-gap, server-issue
Valid severities: CRITICAL, HIGH, MEDIUM, LOW

Only report genuine issues. If a check surface is healthy, say "No issues found" for that section and move on.

End with a one-line summary: "N findings: X critical, Y high, Z medium, W low" (or "Rules look healthy — no issues found").
~~~

### Step 3: Present Findings

Parse the subagent's findings and present them to the user:

**If no findings:**
> Rules look healthy. No issues found across the audit.

**If findings exist, group by severity:**

> **Rule Review — N findings**
>
> **Critical** (if any)
> - [title] — [detail]
>   Suggested fix: [suggestion]
>
> **High** (if any)
> - [title] — [detail]
>   Suggested fix: [suggestion]
>
> **Medium / Low** (listed as recommendations)

### Step 4: Act on Findings

For each critical and high finding, offer to fix it. **Ask the user before each action.** Route to the appropriate remediation:

| Finding Type | Action |
|---|---|
| `invalid-rule` | "Want me to fix this rule?" Follow `/skill-engine:learn-rule update` with corrections |
| `dead-rule` | "This rule matches no files. Want me to remove it?" Use learn.js remove |
| `rule-conflict` | "These rules conflict — which should take precedence?" Present options |
| `coverage-gap` | "Want me to create a rule for this?" Follow `/skill-engine:learn-rule` |
| `promote-rule` | "Want me to promote this to permanent?" Follow `/skill-engine:learn-rule promote` |
| `hook-gap` | "Want me to create a [tool/output/stop] rule?" Follow `/skill-engine:learn-rule` with appropriate trigger type |
| `server-issue` | Suggest `/skill-engine:start` to restart, or `/skill-engine:perf-check` for performance issues |

After processing all actionable findings (or if the user declines all), summarize:

> **Review complete.** Fixed: N | Skipped: N | Remaining recommendations: [list medium/low if any]

## Notes

- This skill adds zero latency to the skill-engine hot path — it is purely on-demand.
- The subagent does the codebase analysis; this skill handles presentation and routing.
- Each fix requires user confirmation — nothing is auto-applied.
- Run `/skill-engine:status` first if you suspect the server is not running.
