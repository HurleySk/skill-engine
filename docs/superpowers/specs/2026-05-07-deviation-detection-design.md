# Deviation Detection — Design Spec

## Context

The skill feedback loop (Part 1) closed the gap between session lessons and skill improvement. But feedback only enters the system when someone manually debriefs and classifies a lesson as "skill improvement." The loop is human-powered — if the user forgets to debrief, or doesn't notice a deviation, the signal is lost.

Deviation detection makes the feedback loop **self-populating**. Skills declare checkpoints — simple structural expectations about what should happen when the skill is active. At debrief time, the agent automatically checks whether those expectations were met and surfaces unmet checkpoints as questions. Confirmed deviations become feedback signals; dismissed ones are tracked and auto-suppressed over time.

### Design Principles

- **Passive, not blocking** — deviations are recorded, never prevented. The agent's judgment and user overrides always take precedence.
- **Light touch** — simple presence/absence checks, no ordering or conditional logic. Sessions are too unpredictable for complex chain validation.
- **Zero hot-path impact** — all evaluation happens at debrief time in the agent's context. No PreToolUse/PostToolUse cost.
- **Self-tuning** — dismissal tracking auto-suppresses noisy checkpoints. The system learns which checks are too strict.

---

## Component 1: Checkpoint Format

Checkpoints live in SKILL.md frontmatter alongside existing fields (`name`, `description`, `argument-hint`). The plugin system ignores unknown frontmatter keys, so this is backward-compatible.

### Schema

```yaml
checkpoints:
  - id: <unique-within-skill>
    type: tool_used | file_pattern | keyword
    value: <type-specific value>
    label: <human-readable description shown at debrief>
```

### Check Types

| Type | Value Format | Evaluation |
|---|---|---|
| `tool_used` | Tool name (e.g., `TaskCreate`, `Bash`) | Was this tool called at least once after skill activation? |
| `file_pattern` | Glob pattern (e.g., `docs/**/*-design.md`) | Was a file matching this pattern written or edited? Pipe-delimited for multiple patterns. |
| `keyword` | Regex-compatible pattern (e.g., `approve\|looks good\|go ahead`) | Did a user message contain a match? Pipe-delimited alternatives. |

### Authoring Guidelines

- **One checkpoint per hard gate** — if the skill says "MUST" or "HARD-GATE", it gets a checkpoint
- **Skip soft guidance** — "prefer X" or "consider Y" are not checkpoint-worthy
- **3-5 checkpoints max per skill** — more than that suggests the skill is doing too much
- **Labels are user-facing** — they appear in debrief questions, so write them as plain English
- **IDs are stable** — dismissal history is keyed on `skillName + checkpointId`, so don't rename IDs after release

---

## Component 2: Debrief Integration

### New Step 0.5: Automated Deviation Check

Inserted before the existing Step 1 (Session Scan). Structured checkpoint evaluation runs first, then the LLM does its freeform scan. This ensures mechanical deviations are caught deterministically, while the existing scan catches judgment-based issues.

#### Process

1. **Query activated skills.** Call `GET /skill-feedback/signals?sessionId=<current-session>&type=activation` to get the list of skills activated this session.

2. **For each activated skill, read its checkpoints.** Parse the SKILL.md frontmatter. If no `checkpoints` key, skip.

3. **Evaluate each checkpoint against conversation history.**
   - `tool_used`: scan conversation for tool calls matching the value
   - `file_pattern`: scan Write/Edit tool calls for file paths matching the glob
   - `keyword`: scan user messages for pattern matches

4. **Filter auto-suppressed checkpoints.** Query `GET /skill-feedback/signals?skillName=<name>` and count `dismissal` signals where `checkpointId` matches. If 3+ dismissals, suppress with a note: *"Auto-suppressed: '<label>' has been dismissed N times previously."*

5. **Present unmet checkpoints as questions.** For each unmet, non-suppressed checkpoint:

   > **[skill-name]** was activated but: *<label>* — was this intentional?
   > - **Yes, intentional** (override/skip) → record dismissal
   > - **No, that was a deviation** → record correction

6. **Post signals.** For each response:
   - Confirmed deviation → `POST /skill-feedback` with `type: "correction"`, include `checkpointId`
   - Dismissed → `POST /skill-feedback` with `type: "dismissal"`, include `checkpointId`

7. **Continue to Step 1.** Existing session scan proceeds as normal. The automated check may surface things the freeform scan would have missed, and vice versa.

### Signal Format

Deviation signals include a `checkpointId` field to enable dismissal tracking:

```json
{
  "skillName": "superpowers:brainstorming",
  "type": "correction",
  "summary": "Design spec was never written",
  "checkpointId": "design-spec",
  "sessionId": "sess-abc123"
}
```

Dismissal signals:

```json
{
  "skillName": "superpowers:brainstorming",
  "type": "dismissal",
  "summary": "User override — skipped design process",
  "checkpointId": "task-checklist",
  "sessionId": "sess-abc123"
}
```

---

## Component 3: Server Changes

Minimal additions to support session-scoped queries.

### New Endpoint: `GET /skill-feedback/signals`

Query parameters:
- `sessionId` (optional) — filter signals by session
- `skillName` (optional) — filter signals by skill
- `type` (optional) — filter by signal type (e.g., `activation`, `dismissal`)

Returns an array of matching signals from the JSONL log.

```json
[
  { "skillName": "superpowers:brainstorming", "type": "activation", "timestamp": "...", "sessionId": "sess-abc123" },
  { "skillName": "superpowers:writing-plans", "type": "activation", "timestamp": "...", "sessionId": "sess-abc123" }
]
```

### New Function: `getSignalsForSession(sessionId, options)`

Added to `server/skill-feedback.js`. Filters `readAllSignals()` by sessionId, with optional type filter. Used by the new endpoint.

### Dismissal Handling

No server-side changes needed for dismissal type handling. The existing `recordSignal` function accepts any `type` string — `"dismissal"` signals are logged to the JSONL like any other signal. They don't increment the correction threshold (only `correction` and `lesson` types do).

One addition to `recordSignal`: persist `checkpointId` when present on the input signal. Currently only `sessionId`, `project`, and `skillSource` are passed through — add `checkpointId` to the same pattern.

---

## Component 4: Dismissal Suppression

### Mechanics

- Suppression threshold: **3 dismissals** for the same `skillName + checkpointId` combination
- Counted across all sessions (dismissals are a durable signal about the checkpoint itself, not one session)
- Resolved signals (from `clearSkill`) don't count — suppression tracks only unresolved dismissals
- Suppressed checkpoints are mentioned in debrief output but not presented as questions

### Self-Tuning Behavior

Over time, the system converges:
- Checkpoints that reflect real skill obligations stay active — deviations get confirmed as corrections
- Checkpoints that are too strict or context-dependent get dismissed and auto-suppress
- Skill authors can use suppression data to refine or remove bad checkpoints during `skill-improve`

### Reset

When `skill-improve` processes a skill and the user approves changes, `clearSkill` resolves all signals including dismissals. This resets suppression state — the improved checkpoints get a fresh start.

---

## Rollout: Initial Checkpoint Candidates

Three superpowers skills with the clearest hard gates:

### brainstorming

```yaml
checkpoints:
  - id: task-checklist
    type: tool_used
    value: TaskCreate
    label: "Create task checklist from brainstorming steps"
  - id: design-spec
    type: file_pattern
    value: "docs/superpowers/specs/*-design.md"
    label: "Write design spec document"
  - id: user-approval
    type: keyword
    value: "approve|looks good|go ahead|yes|lgtm"
    label: "Get user approval before proceeding to implementation"
```

### test-driven-development

```yaml
checkpoints:
  - id: test-first
    type: file_pattern
    value: "**/*.test.*|**/*.spec.*|**/test_*|**/tests/*"
    label: "Write test file"
  - id: tests-run
    type: tool_used
    value: Bash
    label: "Run test suite"
```

### writing-plans

```yaml
checkpoints:
  - id: plan-written
    type: file_pattern
    value: "docs/superpowers/plans/*|**/*-plan.md"
    label: "Write implementation plan document"
  - id: plan-committed
    type: tool_used
    value: Bash
    label: "Commit plan to git"
```

---

## Implementation Scope

### skill-engine repo

| File | Change |
|---|---|
| `server/skill-feedback.js` | Add `getSignalsForSession()`, persist `checkpointId` in `recordSignal` |
| `server/server.js` | Add `GET /skill-feedback/signals` endpoint |
| `tests/skill-feedback.test.js` | Tests for `getSignalsForSession`, checkpointId persistence |
| `tests/server.test.js` | Integration tests for the new endpoint |
| `skills/debrief/SKILL.md` | Add Step 0.5: Automated Deviation Check |
| `CLAUDE.md` | Document new endpoint |

### superpowers-marketplace repo

| File | Change |
|---|---|
| `skills/brainstorming/SKILL.md` | Add checkpoints to frontmatter |
| `skills/test-driven-development/SKILL.md` | Add checkpoints to frontmatter |
| `skills/writing-plans/SKILL.md` | Add checkpoints to frontmatter |

### Not in scope

- Ordering/sequencing checks between checkpoints
- Server-side checkpoint evaluation
- Blocking or real-time warnings
- Automatic debrief trigger
- Checkpoint inheritance or composition between skills
- Deviation detection via post-tool heuristics (original v2 idea from Part 1 spec — superseded by this checkpoint approach)

---

## Open Questions

1. **`tool_used: Bash` is broad.** The TDD `tests-run` and writing-plans `plan-committed` checkpoints both check for Bash usage, which will nearly always be true. Should `tool_used` support a `contains` sub-field to match tool input content (e.g., `value: "Bash" contains: "test"`)? Or is this over-engineering for v1?

2. **Checkpoint evaluation for plugin skills.** The debrief agent needs to read SKILL.md files from the plugin cache to parse checkpoints. The path pattern (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md`) is known but version-dependent. The existing `PLUGIN_DIR` bash snippet in skills handles this — should the debrief hardcode the same pattern, or should the server expose a skill-location endpoint?

3. **Cross-session checkpoint scope.** A skill could be activated in session A but the relevant work happens in session B (e.g., brainstorming in one session, spec writing in the next). Checkpoints currently scope to a single session. Is this a real problem, or an edge case we can defer?
