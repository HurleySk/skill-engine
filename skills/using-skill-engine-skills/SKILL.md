---
name: using-skill-engine-skills
description: Session-start orientation on the skill-engine ecosystem — skill inventory, decision tree, feedback loop awareness. Use when starting a session in a project with skill-engine installed.
---

# Using Skill Engine Skills

This skill orients you on the skill-engine ecosystem so you know what tools are available and when to use them.

## Skill Inventory

| Skill | Slug | Purpose |
|---|---|---|
| **learn** | `skill-engine:learn` | Capture a lesson as a rule or skill — classifies and routes |
| **learn-rule** | `skill-engine:learn-rule` | Create or update enforcement rules |
| **learn-skill** | `skill-engine:learn-skill` | Scaffold a reusable SKILL.md |
| **learn-analyzer** | `skill-engine:learn-analyzer` | Create async analyzer scripts + wire async rules |
| **review** | `skill-engine:review` | Holistic audit of Claude config (CLAUDE.md, skills, rules, hooks, MCP) |
| **skill-improve** | `skill-engine:skill-improve` | Review accumulated feedback and propose targeted skill edits |
| **debrief** | `skill-engine:debrief` | End-of-session lesson capture + holistic review + skill health |
| **rule-review** | `skill-engine:rule-review` | Audit rules for validity, conflicts, dead patterns |
| **rule-consistency** | `skill-engine:rule-consistency` | Detect semantically contradictory or redundant rules |
| **perf-check** | `skill-engine:perf-check` | Performance audit of hooks, MCP servers, plugin config |
| **start** | `skill-engine:start` | Start or resume the skill-engine server |
| **stop** | `skill-engine:stop` | Pause the skill-engine server |
| **status** | `skill-engine:status` | Server diagnostics — port, uptime, rules, sessions |

## Decision Tree

Use this to decide which skill to invoke:

- **Session start + nudge received** → `/skill-engine:skill-improve` (address flagged skills)
- **Mid-session, learned something** → `/skill-engine:learn` (capture as rule or skill)
- **A skill led you astray** → note it for debrief, or post feedback directly via curl to `/skill-feedback`
- **Session end** → `/skill-engine:debrief` (capture lessons, review skill health)
- **Skills or config feel stale** → `/skill-engine:review` (full audit)
- **Specific skill needs improvement** → `/skill-engine:skill-improve <name>`
- **Rules seem contradictory** → `/skill-engine:rule-consistency`
- **Need cross-file validation or expensive checks** → `/skill-engine:learn-analyzer` (async analyzer)
- **Performance concern** → `/skill-engine:perf-check`
- **Server not running** → `/skill-engine:start`

## Feedback Loop Awareness

The skill-engine accumulates feedback about skill performance over time. When you notice a skill misfiring, being too rigid, or having gaps:

1. **During a session:** Note it mentally for the debrief
2. **During debrief:** Classify it as "Skill improvement" — this posts a signal to the server
3. **When thresholds are crossed:** The server nudges at session start
4. **When nudged:** Run `/skill-engine:skill-improve` to review and apply fixes

The key habit: **if a skill led you astray, that's a signal worth recording, not just something to work around and forget.**

## Skill-Engine vs. Superpowers Boundary

- **Superpowers skills** (brainstorming, TDD, writing-plans, debugging, etc.) are *consumed* by projects but *maintained* in the superpowers-marketplace repo
- **Skill-engine skills** (this inventory) are the *meta-layer* — they improve, audit, and manage everything else
- When `skill-improve` proposes edits to a superpowers skill, those edits need to go to the superpowers source repo, not just the local plugin cache
