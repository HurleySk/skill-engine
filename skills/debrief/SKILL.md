---
name: debrief
description: Use when a session surfaced lessons worth capturing — crashes, gotchas, code review findings, architectural discoveries, user corrections. Classifies each lesson and routes to the best fix level (code fix, rule, memory, skill, config, test).
---

# Session Debrief

Systematically capture session lessons and route each to the right persistence mechanism. Prefer code fixes over rules, rules over documentation.

**Invoke manually:** `/skill-engine:debrief`

## Finding the Plugin Directory

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Process

### Step 1: Session Scan

Review the conversation for notable events:
- Crashes, exceptions, or build failures
- Code review findings
- Workarounds or gotchas discovered
- Architectural constraints learned
- User corrections or preference signals
- Patterns that recurred (same mistake made twice)

List each event as a one-line summary. If nothing notable happened, tell the user and stop.

### Step 2: Lesson Framing

For each event, frame the lesson: "What went wrong, and what would prevent it in the future?"

### Step 3: Fix-Level Evaluation

For each lesson, evaluate these fix levels and recommend the best one:

| Fix Level | When to Recommend |
|---|---|
| **Code fix** | The fix is straightforward, mechanical, and fits existing code patterns. Makes the problem structurally impossible or detectable at runtime. |
| **Test** | Session revealed a test coverage gap — an assertion or test case would catch this in the future. |
| **Skill-engine rule** | Pattern is detectable in file content or tool input. A code fix would be disproportionate effort or fragile. |
| **Memory** | Contextual knowledge not expressible as code or rules (project state, user preferences, architectural decisions). |
| **CLAUDE.md / config** | New safety boundary or project-wide instruction (safety-rules.json, settings.json). |
| **New skill** | Reusable multi-step workflow pattern that applies across sessions. |

**You must recommend one with reasoning.** Evaluate:
- Engineering effort vs. value
- Fragility and edge cases of a code fix
- How well it fits existing patterns
- Whether the pattern is mechanical (rule-friendly) or judgment-dependent (memory-friendly)

**Example reasoning:**

> Null reference crash is a one-line guard in a method that already handles optional parameters. **Recommend: Code fix** — apply directly.

> Auto-converting between query formats would need to handle syntax differences, pagination semantics — high effort, fragile. A rule that warns on the risky pattern is 90% of the value for 5% of the effort. **Recommend: rule.**

> "User prefers bundled PRs over small ones for refactors" — not enforceable in code or rules, purely a collaboration preference. **Recommend: feedback memory.**

### Step 4: Present and Confirm

Present all lessons in a table:

| # | Lesson | Recommendation | Reasoning |
|---|---|---|---|
| 1 | ... | Code fix | ... |
| 2 | ... | Rule | ... |
| 3 | ... | Feedback memory | ... |

Ask the user to approve, edit, redirect, or skip each item.

### Step 5: Persist

For each approved item, route to the appropriate mechanism:

| Fix Level | Action |
|---|---|
| Code fix (small, < ~20 lines) | Apply the fix directly, run tests, commit |
| Code fix (large or design needed) | Save to project memory with file:line references and scope for a future session |
| Test | Write the test case, run it, commit |
| Skill-engine rule | Invoke `/skill-engine:learn-rule` with the lesson context |
| Memory | Write to memory system (project, feedback, or user type as appropriate) |
| CLAUDE.md | Propose the edit, apply after user approval |
| Config (safety-rules.json, settings) | Propose the edit, apply after user approval |
| New skill | Invoke `/skill-engine:learn-skill` with the workflow description |

After persisting all items, summarize what was captured and where.
