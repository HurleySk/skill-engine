# Rule Consistency Skill — Design Spec

## Context

The skill-engine plugin has a robust rule system with two rule files (`skill-rules.json`, `learned-rules.json`) that grow over time as users learn rules via `/skill-engine:learn-rule`. The existing `/skill-engine:rule-review` skill audits rules for structural validity, dead patterns, and coverage gaps — but it does not detect **semantic contradictions** between rules.

As rule sets grow, rules authored at different times can contradict each other in meaning: one rule advises parameterized SQL while another's guidance suggests string concatenation, or two rules express the same intent in different words (noise). These inconsistencies confuse the agent and degrade the quality of enforcement.

This skill fills that gap with LLM-powered semantic analysis and optional auto-correction.

## Skill Identity

| Field | Value |
|-------|-------|
| Name | `rule-consistency` |
| Slug | `skill-engine:rule-consistency` |
| Location | `skills/rule-consistency/SKILL.md` |
| Description | Detect semantically contradictory, mismatched, or redundant rules and optionally auto-correct them |
| Argument hint | `[--fix]` |

## Workflow

### Step 1: Gather State

Read these files (skip any that don't exist):

- `.claude/skills/skill-rules.json`
- `.claude/skills/learned-rules.json`

Resolve the plugin directory:

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

### Step 2: Early Exit

If fewer than 2 total rules exist across both files, report: "Need at least 2 rules to check for consistency. Use `/skill-engine:learn-rule` to add rules." Stop.

### Step 3: Dispatch Semantic Analyzer Subagent

Dispatch a single `general-purpose` subagent with all rule data embedded in the prompt. The subagent analyzes three dimensions:

#### Dimension 1: Opposing Guidance

Two rules whose descriptions, guidance, or blockMessages advise actions that cannot both be followed.

**Example:** Rule A says "always use parameterized queries" while Rule B's guidance says "use string concatenation for dynamic SQL."

**Detection:** Compare the natural language intent of each rule pair. Flag only genuine contradictions — rules that cover different scopes with different advice are not contradictions.

#### Dimension 2: Enforcement Mismatches

Two rules whose triggers overlap in scope (same file types, same tools, or same keywords) but whose enforcement levels conflict in a way that makes one unreachable or contradictory.

**Example:** Rule A blocks all `*.sql` writes while Rule B only warns on `*.sql` writes — the warn is unreachable because block fires first at the same scope.

**Detection:** Identify overlapping trigger scopes, then compare enforcement levels. Stricter enforcement shadows weaker enforcement at the same scope.

#### Dimension 3: Semantic Duplicates

Two rules that express the same intent in different words, adding noise without additional value.

**Example:** "Ensure SQL uses parameterized queries" and "prevent SQL injection by using bind variables."

**Detection:** Compare descriptions and guidance text for semantic equivalence, not just textual similarity. Two rules about the same topic with meaningfully different scopes or enforcement are NOT duplicates.

### Step 4: Present Findings

Group findings by severity using the same format as `/skill-engine:rule-review`:

```
**[SEVERITY] Title** (type: finding-type)
Rules: rule-a-name, rule-b-name
Detail: Full explanation of the contradiction/redundancy
Suggestion: Specific fix
Fix: { action: "merge|remove|update", target: "rule-name", result: {<rule JSON>} }
```

Valid finding types: `opposing-guidance`, `enforcement-mismatch`, `semantic-duplicate`

Valid severities:
- **CRITICAL** — Opposing guidance that would cause the agent to receive contradictory instructions
- **HIGH** — Enforcement mismatch where one rule shadows another
- **MEDIUM** — Semantic duplicates (noise, not harmful)
- **LOW** — Borderline cases the user should review

### Step 5: Remediate

Two modes controlled by the `--fix` argument:

#### Interactive Mode (default)

For each critical and high finding, present the finding and ask the user before applying the fix. Route to `learn.js` for mutations:

| Finding Type | Default Fix |
|---|---|
| `opposing-guidance` | Merge into one rule: keep the higher-enforcement version, rewrite the description to reconcile both intents (the subagent proposes the merged text in its `fix` object) |
| `enforcement-mismatch` | Escalate to the stricter level, unify the description |
| `semantic-duplicate` | Keep the more specific rule, remove the broader one |

#### Auto-Correct Mode (`--fix`)

Apply all suggested fixes without per-finding prompts. After all fixes, show a summary:

> **Auto-corrected N issues.** Removed M duplicates, merged K conflicts. Run `/skill-engine:rule-review` to verify structural integrity.

### Fix Mechanics

All mutations use the existing `learn.js` CLI:

- **Remove:** `node "$PLUGIN_DIR/hooks/lib/learn.js" remove "<rule-name>"`
- **Add/Update:** `node "$PLUGIN_DIR/hooks/lib/learn.js" add "<rule-name>" '<rule-json>'`

No new server endpoints. No new Node.js scripts. No runtime overhead.

## Subagent Prompt Template

The subagent prompt includes:

1. All rules from both files as structured JSON
2. Clear definitions of each analysis dimension (as described above)
3. Instruction to only flag genuine semantic issues — not superficial word differences
4. Structured output format with a `fix` object for each finding containing the proposed correction
5. Summary line: "N findings: X critical, Y high, Z medium, W low" (or "Rules are semantically consistent — no issues found")

## Non-Goals

- **Structural validation** — Covered by `/skill-engine:rule-review`
- **Coverage gap analysis** — Covered by `/skill-engine:rule-review`
- **Runtime monitoring** — Out of scope
- **Cross-project rule comparison** — Single project scope only
- **New server endpoints** — Pure skill, no server changes

## Verification

1. **No rules:** Create a project with 0-1 rules, invoke the skill, confirm early exit message
2. **Clean rules:** Create 3+ non-contradictory rules, invoke the skill, confirm "no issues found"
3. **Opposing guidance:** Create two rules with contradictory descriptions targeting the same file type, invoke the skill, confirm it detects the opposition
4. **Enforcement mismatch:** Create two rules on `*.sql` — one block, one warn — invoke the skill, confirm it flags the shadowed warn
5. **Semantic duplicates:** Create two rules with different names but same intent, invoke the skill, confirm it flags them as duplicates
6. **Auto-correct:** Repeat cases 3-5 with `--fix`, confirm fixes are applied without prompts and summary is shown
7. **Interactive mode:** Repeat cases 3-5 without `--fix`, confirm user is prompted before each fix
8. **Integration:** After fixes, run `/skill-engine:rule-review` to confirm structural integrity is maintained

## Marketplace

After implementation, commit with `[release]` suffix. CI bumps version in `.claude-plugin/plugin.json`, tags, and dispatches update to `HurleySk/claude-plugins-marketplace`.
