# Skill Feedback Loop — Design Spec

## Context

The skill-engine has a robust system for capturing lessons (debrief), creating rules (learn-rule), and auditing configuration (review). But there's a critical gap: **no mechanism to systematically improve existing skills based on accumulated experience.**

Today, if a superpowers skill (brainstorming, TDD, writing-plans, etc.) misfires or has gaps, the user must manually identify which skill to update and direct the agent to edit it. Lessons from sessions evaporate unless someone explicitly connects them to the right skill file.

This design closes the feedback loop with five interconnected pieces:

1. **Server infrastructure** — `/skill-feedback` endpoint + threshold checker that accumulates signals and flags skills needing attention
2. **`skill-improve` skill** — reads accumulated feedback, identifies which skills need work, proposes targeted edits
3. **Enhanced debrief** — replaces the current debrief skill, adds "skill improvement" as a fix level, holistic session assessment, and a skill-health summary
4. **`using-skill-engine-skills` meta-skill** — session-start orientation on the skill-engine ecosystem (like `using-superpowers` for superpowers)
5. **Session-start nudge** — conditional rule that surfaces flagged skills when thresholds are crossed

## Removals

The existing `skills/debrief/SKILL.md` is **removed** and fully replaced by the enhanced debrief. All current debrief functionality is preserved and extended.

---

## Component 1: Server Infrastructure

### New Endpoint: `POST /skill-feedback`

Accepts feedback signals about skill performance and accumulates them in a persistent log.

**Request:**
```json
{
  "skillName": "superpowers:brainstorming",
  "type": "correction | lesson | deviation",
  "summary": "User said skip visual companion offer for non-UI tasks",
  "sessionId": "optional"
}
```

**Response:**
```json
{
  "recorded": true,
  "needsReview": ["superpowers:brainstorming"]
}
```

The response includes any skills that just crossed a threshold — so the caller (debrief) can surface it immediately.

### Feedback Signals

| Signal | Source | How Captured |
|---|---|---|
| Skill activated | `/activate` endpoint (already exists) | Log skill name, project, timestamp on each activation |
| User correction after skill | `/skill-feedback` | Debrief or agent posts structured feedback |
| Lesson routed to skill-improvement | Enhanced debrief | Debrief classifies lesson as skill-relevant, posts to `/skill-feedback` |
| Skill deviation (stretch goal, not v1) | `/post-tool` heuristic | Detect when skill was activated but agent didn't follow expected patterns |

### Storage: Two Files

Both live in `~/.claude/` (central, since boomerang skills span projects).

**`skill-feedback-log.jsonl`** — append-only JSONL, one signal per line:

```jsonl
{"skillName":"superpowers:brainstorming","skillSource":"superpowers-marketplace","type":"correction","summary":"User said skip visual companion offer for non-UI tasks","sessionId":"abc123","timestamp":"2026-05-07T14:30:00Z","project":"skill-engine"}
{"skillName":"superpowers:writing-plans","skillSource":"superpowers-marketplace","type":"activation","timestamp":"2026-05-07T14:32:00Z","project":"skill-engine"}
```

**`skill-feedback-thresholds.json`** — small read-modify-write file for threshold state:

```json
{
  "superpowers:brainstorming": {
    "corrections": 3,
    "lastFlagged": "2026-05-07T14:30:00Z",
    "needsReview": true
  }
}
```

### Threshold Logic

- **3+ corrections** for the same skill within a rolling 7-day window → `needsReview: true`
- Deviation detection (v2 stretch goal) will count the same as a correction once implemented — not included in v1 threshold counting
- Thresholds reset when `skill-improve` processes the feedback and user approves changes
- Oldest-first eviction at `maxSignals: 200` cap

### Performance

- `/skill-feedback` is **not on the hot path** — only called by debrief or explicitly, never on every tool call
- Activation logging uses JSONL format (`feedback-log.jsonl`) — one JSON object per line, `appendFileSync` per signal, no full-file parse on write. Read-and-parse happens only when `skill-improve` or `/skill-health` is invoked.
- Threshold state is maintained in a separate small file (`feedback-thresholds.json`) — read-modify-write on each `/skill-feedback` call, but this file stays tiny (one key per skill with corrections)
- The nudge rule's threshold check reads only `feedback-thresholds.json`, not the full signals log

### New Endpoint: `GET /skill-health`

Returns the current threshold state for use by the nudge rule and debrief.

```json
{
  "flagged": [
    { "skillName": "superpowers:brainstorming", "corrections": 3, "lastFlagged": "2026-05-07T14:30:00Z" }
  ],
  "totalSignals": 12
}
```

---

## Component 2: `skill-improve` Skill

### Identity

| Field | Value |
|-------|-------|
| Name | `skill-improve` |
| Slug | `skill-engine:skill-improve` |
| Location | `skills/skill-improve/SKILL.md` |
| Description | Review accumulated skill feedback, identify improvement targets, propose and apply targeted skill edits |
| Argument hint | `[skill-name \| --lessons]` |

### Invocation Modes

- `/skill-engine:skill-improve` — audit mode: reads feedback log, processes all flagged skills
- `/skill-engine:skill-improve brainstorming` — target a specific skill
- `/skill-engine:skill-improve --lessons` — interactive: asks what went wrong, then finds the relevant skill(s)

### Process

**Step 1: Gather context**

- Read `feedback-log.json` — filter to skills with `needsReview: true` or to the targeted skill
- Read each flagged skill's full SKILL.md content
- If invoked from debrief, receive the lesson context directly

**Step 2: Dispatch analysis subagent**

A `general-purpose` subagent receives the skill content + all accumulated feedback signals for that skill. It analyzes:

- What specific failure modes do the signals describe?
- Which sections of the skill are responsible? (quote lines)
- Are there structural issues beyond what the signals report? (too rigid, too vague, missing edge cases, contradictory steps)
- Proposed edits as **concrete diffs** — targeted changes, not rewrites

The subagent also considers:

- **Boomerang context** — these skills run across many projects. Flag any edit that seems project-specific vs. universally beneficial.
- **Skill-engine infrastructure gaps** — if the fix isn't a skill edit but rather "skill-engine should support X" (e.g., conditional steps, project-type detection), flag that separately as an infrastructure suggestion.

**Step 3: Present findings**

Per skill, grouped:

```
superpowers:brainstorming — 3 corrections, 12 activations last 7 days

Findings:
1. Visual companion offer fires for non-UI tasks (lines 142-148) — 2 corrections
   Proposed edit: Add a gate: "Skip the visual companion offer if the task has no UI/frontend component"

2. One-question-at-a-time rule too rigid for quick clarifications — 1 correction
   Proposed edit: Add exception: "For yes/no follow-ups on the same topic, you may combine with the next question"

Infrastructure suggestion:
- Skill-engine could support projectType conditions so skills can have variant behavior for frontend vs. backend projects
```

**Step 4: User approves per-finding**

Each finding gets approve / edit / skip. Approved edits are applied to the skill file.

**Step 5: Clear processed feedback**

- Processed signals marked as `resolved` in the feedback log
- `needsReview` flag resets
- Threshold counters restart from zero

**Step 6: Summary**

```
Skill improvement complete.
- brainstorming: 2 edits applied, 1 skipped
- writing-plans: 1 edit applied
- Infrastructure suggestions: 1 (saved to memory)
- Feedback log: 8 signals resolved, 3 remaining
```

### Edit Target Logic

- **Project-local skills** (`.claude/skills/`) → edit in place
- **Plugin skills** (in plugin cache) → if the source repo is available locally, apply edit there and commit. If not, save the proposed diff to `pending-skill-improvements.md` for later application.

---

## Component 3: Enhanced Debrief (replaces `skills/debrief/SKILL.md`)

### Identity

| Field | Value |
|-------|-------|
| Name | `debrief` |
| Slug | `skill-engine:debrief` |
| Location | `skills/debrief/SKILL.md` |
| Description | End-of-session lesson capture with holistic review, skill improvement routing, and skill health reporting |

### Changes from Current Debrief

All existing functionality (session scan, lesson framing, fix-level evaluation, present-and-confirm, persist) is preserved. Three additions:

#### Addition 1: New Fix Level — "Skill Improvement"

Added to the fix-level evaluation table:

| Fix Level | When to Recommend |
|---|---|
| **Skill improvement** | The lesson points to a gap, rigidity, or failure in an existing skill's instructions — not a new skill, but an improvement to one that exists. |

When selected, debrief posts to `/skill-feedback` with the lesson summary. Then asks the user: route to `skill-improve` now, or batch for later review?

#### Addition 2: Holistic Session Assessment (new Step 4.5)

After per-lesson routing, debrief steps back and assesses the session as a whole:

- Did the overall workflow feel right, or was there friction between skills?
- Were skills invoked in the right order? Did one skill's output feed cleanly into the next?
- Were there moments where no skill applied but should have?
- Did the agent struggle with something that a skill-engine infrastructure improvement would fix?

Holistic observations are presented as a separate section — strategic observations, not routed to fix levels.

#### Addition 3: Skill Health Check (new final step)

Debrief pulls current state from `/skill-health`:

```
Skill Health:
- superpowers:brainstorming — 3 corrections (needs review)
- superpowers:TDD — 1 correction (monitoring)
- All other skills healthy

Run /skill-engine:skill-improve to address flagged skills.
```

---

## Component 4: `using-skill-engine-skills` Meta-Skill

### Identity

| Field | Value |
|-------|-------|
| Name | `using-skill-engine-skills` |
| Slug | `skill-engine:using-skill-engine-skills` |
| Location | `skills/using-skill-engine-skills/SKILL.md` |
| Description | Session-start orientation on the skill-engine ecosystem — skill inventory, decision tree, feedback loop awareness |

### Content

**1. Skill inventory** — brief map of all skill-engine skills and when to use each:

| Skill | Purpose |
|---|---|
| `learn` / `learn-rule` / `learn-skill` | Capture lessons in-session |
| `review` | Infrastructure/config audit |
| `skill-improve` | Feedback-driven skill improvement |
| `debrief` | End-of-session lesson capture + holistic review |
| `rule-review` / `rule-consistency` | Rule-specific audits |
| `perf-check` | Performance audit |
| `start` / `stop` / `status` | Server lifecycle |

**2. Decision tree** — when to invoke what:

- Session start, nudge received → `skill-improve`
- Mid-session, learned something → `learn`
- Session end → `debrief`
- Skills feel stale → `skill-improve`
- Config feels wrong → `review`
- Performance concern → `perf-check`

**3. Feedback loop awareness** — establishes the habit: if a skill led the agent astray, that's a signal worth recording via `/skill-feedback`, not just a thing to work around and forget.

**4. Skill-engine vs. superpowers boundary** — superpowers skills are *consumed* but *maintained* in the superpowers repo. Skill-engine skills are the meta-layer that improves everything else.

### Activation

Loaded via SessionStart hook or CLAUDE.md reference for projects with skill-engine installed. Functions identically to `using-superpowers` — orientation only, no implementation actions.

---

## Component 5: Session-Start Nudge

A rule in `skill-rules.json` that fires on the first `UserPromptSubmit` of a session, but **only when skills are flagged**:

```json
"skill-health-nudge": {
  "type": "domain",
  "enforcement": "suggest",
  "priority": "medium",
  "description": "Skills have accumulated feedback and may need attention.",
  "triggers": {
    "prompt": {
      "intentPatterns": [".*"]
    }
  },
  "skipConditions": {
    "sessionOnce": true
  }
}
```

The server's `/enforce` logic has a special case for this rule: when evaluating `skill-health-nudge`, it reads `feedback-thresholds.json` and checks if any skill has `needsReview: true`. If none do, the rule is suppressed (returns no match). This keeps the check fast — `feedback-thresholds.json` is a small file with one key per skill.

**Nudge message:**

> **Skill health:** N skills have accumulated feedback — run `/skill-engine:skill-improve` to review.

Short, ignorable, actionable. Disappears once feedback is processed.

---

## Implementation Sequence

1. **Server: `/skill-feedback` + `/skill-health` endpoints + feedback-log.json** — foundation everything else depends on
2. **Activation logging in `/activate`** — tap existing endpoint to record signals
3. **`skill-improve` skill** — the core action skill
4. **Enhanced debrief** — replace existing, add three new sections
5. **`using-skill-engine-skills` meta-skill** — session orientation
6. **Session-start nudge rule** — wire up conditional rule
7. **Remove old `skills/debrief/SKILL.md`** — replaced by enhanced version
8. **Update CLAUDE.md** — document new skills and endpoints

## Open Questions

1. **Feedback log location** — `~/.claude/skill-feedback-log.json` (central, spans projects) vs. per-project in `.claude/skills/`? Central seems right since boomerang skills span projects, but per-project gives isolation.
2. **Deviation detection (v2)** — How sophisticated should the post-tool heuristic be for detecting that an agent deviated from a skill? Deferred to v2.
3. **Skill-improve for plugin skills** — When the source repo isn't local, `pending-skill-improvements.md` is a reasonable stopgap. Could we integrate with `gh` to auto-create PRs against the source repo?
