---
name: debrief
description: End-of-session lesson capture with holistic review, skill improvement routing, and skill health reporting. Use when a session surfaced lessons worth capturing — crashes, gotchas, code review findings, architectural discoveries, user corrections.
---

# Session Debrief

Systematically capture session lessons, assess overall skill effectiveness, and route each lesson to the right persistence mechanism. Prefer code fixes over rules, rules over documentation.

**Invoke manually:** `/skill-engine:debrief`

## Finding the Plugin Directory

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Process

### Step 0.5: Automated Deviation Check

Before the freeform session scan, run structured checkpoint evaluation against skills that were activated this session.

**1. Query activated skills:**

```bash
curl -s "http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-feedback/signals?sessionId=${CLAUDE_SESSION_ID}&type=activation"
```

This returns an array of activation signals. Extract the unique `skillName` values — these are the skills to check.

**Early exit:** If no skills were activated this session, skip to Step 1.

**2. For each activated skill, read its checkpoints:**

Find the SKILL.md file (check both plugin cache and project-local `.claude/skills/`):

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/*/superpowers/*/ 2>/dev/null | sort -V | tail -1)
# Check: $PLUGIN_DIR/skills/<skill-name>/SKILL.md
# Also check: .claude/skills/<skill-name>/SKILL.md
```

Parse the YAML frontmatter for a `checkpoints` key. If no checkpoints defined, skip this skill.

**3. Evaluate each checkpoint against conversation history:**

| Check type | How to evaluate |
|---|---|
| `tool_used` | Scan your conversation for tool calls matching the `value` (e.g., `TaskCreate`, `Bash`) |
| `file_pattern` | Scan Write/Edit tool calls for file paths matching the glob pattern in `value`. Pipe-delimited patterns mean match ANY. |
| `keyword` | Scan user messages for text matching the regex pattern in `value`. Pipe-delimited alternatives. |

Mark each checkpoint as **met** or **unmet**.

**4. Filter auto-suppressed checkpoints:**

For each unmet checkpoint, query for prior dismissals:

```bash
curl -s "http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-feedback/signals?skillName=<skill-name>"
```

Count signals where `type` is `"dismissal"` and `checkpointId` matches this checkpoint's `id`. If 3 or more dismissals, auto-suppress:

> *Auto-suppressed: "\<label\>" has been dismissed N times previously.*

**5. Present unmet checkpoints as questions:**

For each unmet, non-suppressed checkpoint, ask:

> **[skill-name]** was activated but: *\<label\>* — was this intentional?
> - **Yes, intentional** (user override / not applicable) → record dismissal
> - **No, that was a deviation** → record correction

**6. Post signals for each response:**

Confirmed deviation:
```bash
curl -s -X POST http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName":"<skill-name>","type":"correction","summary":"<label>","checkpointId":"<id>","sessionId":"<session-id>"}'
```

Dismissed:
```bash
curl -s -X POST http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName":"<skill-name>","type":"dismissal","summary":"User override — <label>","checkpointId":"<id>","sessionId":"<session-id>"}'
```

**7. Continue to Step 1.** The automated check surfaces mechanical deviations; the freeform session scan in Step 1 catches judgment-based issues.

### Step 1: Session Scan

Review the conversation for notable events:
- Crashes, exceptions, or build failures
- Code review findings
- Workarounds or gotchas discovered
- Architectural constraints learned
- User corrections or preference signals
- Patterns that recurred (same mistake made twice)
- **Skills that misfired, were too rigid, or had gaps**
- **Moments where the agent deviated from a skill's instructions**

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
| **Skill improvement** | The lesson points to a gap, rigidity, or failure in an existing skill's instructions — not a new skill, but an improvement to one that exists. |

**Project extensions:** If `.claude/skills/debrief-extensions.md` exists in the project, read it. Merge any additional fix levels into the table above and use its routing rules in Step 5.

**You must recommend one with reasoning.** Evaluate:
- Engineering effort vs. value
- Fragility and edge cases of a code fix
- How well it fits existing patterns
- Whether the pattern is mechanical (rule-friendly) or judgment-dependent (memory-friendly)
- **Whether an existing skill was involved and could be improved to prevent recurrence**

**Example reasoning:**

> Null reference crash is a one-line guard in a method that already handles optional parameters. **Recommend: Code fix** — apply directly.

> Auto-converting between query formats would need to handle syntax differences, pagination semantics — high effort, fragile. A rule that warns on the risky pattern is 90% of the value for 5% of the effort. **Recommend: rule.**

> "User prefers bundled PRs over small ones for refactors" — not enforceable in code or rules, purely a collaboration preference. **Recommend: feedback memory.**

> The brainstorming skill asked a visual companion question for a CLI-only project. This is a gap in the skill's conditional logic, not a new skill. **Recommend: Skill improvement** — the skill needs a gate on visual companion offers.

### Step 4: Present and Confirm

Present all lessons in a table:

| # | Lesson | Recommendation | Reasoning |
|---|---|---|---|
| 1 | ... | Code fix | ... |
| 2 | ... | Rule | ... |
| 3 | ... | Skill improvement | ... |

Ask the user to approve, edit, redirect, or skip each item.

### Step 4.5: Holistic Session Assessment

Step back from individual lessons. Consider the session as a whole:

- Did the overall workflow feel right, or was there friction between skills?
- Were skills invoked in the right order? Did one skill's output feed cleanly into the next?
- Were there moments where no skill applied but should have?
- Did the agent struggle with something that a skill-engine infrastructure improvement would fix?

Present holistic observations as a separate section. These are strategic observations — not routed to fix levels, but shared for the user to consider.

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
| Skill improvement | Post feedback to the server, then ask: route to `/skill-engine:skill-improve` now, or batch for later? |

**For skill improvement items**, post the signal:

```bash
curl -s -X POST http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName":"<skill-name>","type":"correction","summary":"<lesson summary>"}'
```

After persisting all items, summarize:

> **Debrief complete.** Fixed: N | Skipped: N | Skill feedback recorded: N | Remaining recommendations: [list if any]

### Step 6: Skill Health Check

After persisting all items, check the current skill health:

```bash
curl -s http://localhost:${SKILL_ENGINE_PORT:-19750}/skill-health
```

If any skills are flagged, present:

```
Skill Health:
- [skill-name] — N corrections (needs review)
- [skill-name] — N corrections (monitoring)
- All other skills healthy

Run /skill-engine:skill-improve to address flagged skills.
```

If no skills are flagged:

```
Skill Health: All skills healthy.
```
