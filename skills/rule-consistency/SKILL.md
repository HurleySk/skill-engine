---
name: rule-consistency
description: Detect semantically contradictory, mismatched, or redundant rules and optionally auto-correct them.
argument-hint: "[--fix]"
---

# Skill Engine — Rule Consistency

Semantic analysis of skill-engine rules to detect contradictions, enforcement mismatches, and redundant rules. Complements `/skill-engine:rule-review` (which checks structural validity) by analyzing the *meaning* of rules.

## When to Use

- After accumulating many rules over time — contradictions creep in
- When agent behavior seems confused by conflicting guidance
- After merging rules from multiple projects or team members
- Periodically as a hygiene check alongside `/skill-engine:rule-review`

## Arguments

- **No arguments (default):** Interactive mode — present findings and ask before each fix
- **`--fix`:** Auto-correct mode — apply all fixes without per-finding prompts

## Finding the Plugin Directory

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Steps

### Step 1: Gather State

Read these files in parallel (skip any that don't exist):

- `.claude/skills/skill-rules.json`
- `.claude/skills/learned-rules.json`

Count the total number of rules across both files.

### Step 2: Early Exit

If fewer than 2 total rules exist, tell the user:

> "Need at least 2 rules to check for consistency. Use `/skill-engine:learn-rule` to add rules."

Stop here.

### Step 3: Dispatch Semantic Analyzer Subagent

Dispatch a single Agent subagent with `subagent_type: "general-purpose"`. Include all rule data from Step 1 in the prompt.

Use this subagent prompt (insert the gathered rule data where indicated):

~~~
You are a semantic rule analyzer for the skill-engine plugin. Your job is to compare rules against each other and detect contradictions, mismatches, and redundancy in their MEANING — not their structure.

## Rule Data

**skill-rules.json:**
[Insert full contents here]

**learned-rules.json:**
[Insert full contents here]

## Analysis Dimensions

Analyze ALL rule pairs across both files. For each pair, check these three dimensions:

### 1. Opposing Guidance (severity: CRITICAL)

Two rules whose descriptions, guidance, or blockMessages advise actions that cannot both be followed.

How to detect: Compare the natural language intent of each rule's description and guidance fields. Ask: "If an agent followed Rule A's advice, would it violate Rule B's advice?" If yes, this is opposing guidance.

Important: Rules that cover DIFFERENT scopes with different advice are NOT contradictions. A rule saying "use ORM for application code" and another saying "use raw SQL for migrations" are complementary, not contradictory — they have different scopes. Only flag genuine contradictions where the advice conflicts at the same scope.

### 2. Enforcement Mismatches (severity: HIGH)

Two rules whose triggers overlap in scope (same file types, same tools, or same keywords) but whose enforcement levels conflict in a way that makes one unreachable or contradictory.

How to detect:
- Compare triggers.file.pathPatterns for overlapping glob patterns
- Compare triggers.tool.toolNames for matching tools
- Compare triggers.prompt.keywords for matching keywords
- If two rules match the same scope, check if one has enforcement "block" while the other has "warn" or "suggest" — the weaker enforcement is unreachable because the block fires first

### 3. Semantic Duplicates (severity: MEDIUM)

Two rules that express the same intent in different words, adding noise without additional value.

How to detect: Compare descriptions and guidance text for semantic equivalence. Ask: "Do these two rules want the agent to do the same thing?" If yes, and their scopes overlap, they are duplicates.

Important: Two rules about the same TOPIC with meaningfully different scopes or enforcement levels are NOT duplicates. "Warn about SQL injection in application code" and "Block SQL injection in migration scripts" are distinct rules, not duplicates.

## Output Format

For each finding, output:

```
**[SEVERITY] Title** (type: finding-type)
Rules: rule-a-name, rule-b-name
Source: which file(s) contain the rules (skill-rules.json, learned-rules.json, or both)
Detail: Full explanation of the contradiction, mismatch, or redundancy
Suggestion: What should be done (merge, remove, update)
Fix: JSON object with the fix details (see below)
```

### Fix Object Format

For opposing guidance (merge):
```json
{
  "action": "merge",
  "remove": "rule-name-to-remove",
  "removeFrom": "skill-rules.json or learned-rules.json",
  "update": "rule-name-to-keep",
  "updateIn": "skill-rules.json or learned-rules.json",
  "updates": { "description": "merged description reconciling both intents", "guidance": "merged guidance if applicable" }
}
```

For enforcement mismatch (update):
```json
{
  "action": "update",
  "target": "rule-name-with-weaker-enforcement",
  "targetIn": "skill-rules.json or learned-rules.json",
  "updates": { "enforcement": "corrected-level", "description": "updated description if needed" }
}
```

For semantic duplicate (remove):
```json
{
  "action": "remove",
  "target": "rule-name-to-remove (the broader/less specific one)",
  "targetFrom": "skill-rules.json or learned-rules.json",
  "keep": "rule-name-to-keep (the more specific one)"
}
```

Valid finding types: opposing-guidance, enforcement-mismatch, semantic-duplicate
Valid severities: CRITICAL, HIGH, MEDIUM, LOW

Only report genuine semantic issues. If two rules seem superficially similar but have meaningfully different scopes or intent, do NOT flag them.

End with a summary line:
"N findings: X critical, Y high, Z medium, W low"
Or: "Rules are semantically consistent — no issues found."
~~~

### Step 4: Present Findings

Parse the subagent's findings and present them to the user.

**If no findings:**
> Rules are semantically consistent across both rule files. No contradictions, mismatches, or duplicates found.

**If findings exist, group by severity:**

> **Rule Consistency Check — N findings**
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

### Step 5: Remediate

Check whether `--fix` was passed as an argument to this skill invocation.

#### Interactive Mode (no `--fix` argument)

For each critical and high finding, present the finding and ask the user before applying. Use the fix object from the subagent to determine the action:

| Fix Action | Commands |
|---|---|
| `merge` | First: `node "$PLUGIN_DIR/hooks/lib/learn.js" remove "<remove-rule>" --file <removeFrom-path>` Then: `node "$PLUGIN_DIR/hooks/lib/learn.js" update "<update-rule>" '<updates-json>' --file <updateIn-path>` |
| `update` | `node "$PLUGIN_DIR/hooks/lib/learn.js" update "<target-rule>" '<updates-json>' --file <targetIn-path>` |
| `remove` | `node "$PLUGIN_DIR/hooks/lib/learn.js" remove "<target-rule>" --file <targetFrom-path>` |

Map file references to actual paths:
- `"skill-rules.json"` → `.claude/skills/skill-rules.json`
- `"learned-rules.json"` → `.claude/skills/learned-rules.json`

After processing all actionable findings (or if the user declines all), summarize:

> **Consistency check complete.** Fixed: N | Skipped: N | Remaining recommendations: [list medium/low if any]

#### Auto-Correct Mode (`--fix` argument present)

Apply ALL fixes from the subagent's findings without asking. Execute each fix action in sequence. After all fixes, show:

> **Auto-corrected N issues.** Removed M duplicates, merged K conflicts, updated J enforcement levels. Run `/skill-engine:rule-review` to verify structural integrity.

## Notes

- This skill adds zero latency to the skill-engine hot path — it is purely on-demand.
- The subagent does the semantic analysis; this skill handles presentation and routing.
- All mutations use the existing `learn.js` CLI — no new server endpoints or scripts needed.
- For structural validation, run `/skill-engine:rule-review` before or after this skill.
- When using `--fix`, always follow up with `/skill-engine:rule-review` to confirm structural integrity.
