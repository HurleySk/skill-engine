# Learn Skill — Design Spec

**Date:** 2026-04-21
**Status:** Approved
**Repo:** skill-engine

## Overview

A new `/skill-engine:learn` skill that lets users capture lessons learned during agent sessions and persist them as enforcement rules. The existing engine hooks (`activate.sh`, `enforce.sh`) then automatically enforce those rules in future edits.

## Problem

Users discover best practices, project conventions, and pitfalls during agent sessions. Today, these lessons exist only in conversation context or user memory — they don't translate into automated enforcement. Users must manually author rules via `/skill-engine:rules`, which requires understanding the rule schema.

## Solution

A skill + helper script combination:

- **SKILL.md** handles the conversational UX — capturing the lesson in natural language, inferring triggers from context, presenting a proposed rule for confirmation
- **learn.js** handles the mechanical parts — schema validation, path normalization, merge/dedup, atomic file writes

Learned rules are stored in a **separate file** (`learned-rules.json`) alongside the hand-authored `skill-rules.json`. The engine loads both files and merges them for matching.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Rule output format | Rules only (no SKILL.md) | Rule `description` and `blockMessage` carry enough context. Full skills are heavyweight for most lessons. |
| Storage | Separate `learned-rules.json` | Keeps auto-generated rules distinct from curated ones. Easier to review, prune, reset. |
| Trigger mechanism | Explicit skill invocation | Keyword detection in natural language is fragile. Deliberate invocation avoids false positives. |
| Default enforcement | `warn` | Non-disruptive. Users can escalate to `block` manually. |
| Trigger inference | Propose from context, user confirms | Pure inference gets it wrong sometimes. Pure manual is tedious. Confirmation loop balances both. |
| Architecture | Skill + helper script (Approach 2) | SKILL.md handles UX, script handles validation. Clean separation, easy to test. |

## Components

### 1. Learn Skill (`skills/learn/SKILL.md`)

Invoked as `/skill-engine:learn`. Guides the agent through:

1. **Capture** — Ask "What should be enforced?" if not provided as an argument. Accept natural language.

2. **Infer** — Derive triggers from current context:
   - Current file being edited -> `pathPatterns` (e.g., `**/*.sql`)
   - Lesson text -> `contentPatterns` if relevant
   - Generate a slugified rule name from the lesson

3. **Present** — Show the complete proposed rule for confirmation:
   ```
   Proposed rule: parameterized-queries-sql
   Type: guardrail | Enforcement: warn
   Triggers: **/*.sql files
   Message: "Use parameterized queries — avoid string concatenation in SQL"

   [JSON preview]

   Want to adjust anything, or should I save this?
   ```

4. **Confirm or tweak** — Revise and re-present on feedback. On confirmation, call `learn.js add`.

5. **Confirm written** — "Rule saved to `learned-rules.json`. It will fire as a warning next time you edit a matching file."

**Subcommands:**

- `/skill-engine:learn` — Create a new learned rule (default)
- `/skill-engine:learn list` — Show all learned rules
- `/skill-engine:learn remove <rule-name>` — Remove a specific learned rule

### 2. Helper Script (`hooks/lib/learn.js`)

Node.js script called by the agent via bash. Located at `hooks/lib/learn.js` within the plugin directory. The SKILL.md provides the agent with the correct invocation path relative to the skill file (e.g., `node "$(dirname "$0")/../../hooks/lib/learn.js"` or equivalent). Three commands:

**`node learn.js add '<rule-json>'`**
- Validates rule JSON against expected schema (required: `type`, `description`, `triggers`)
- Normalizes paths (backslash -> forward slash) via existing `normalizePath()`
- Loads existing `learned-rules.json` or creates it with `{ "version": "1.0", "rules": {} }`
- Rejects duplicate rule names (user must remove first)
- Writes merged result
- Prints confirmation to stdout, errors to stderr

**`node learn.js list`**
- Prints each rule: name, enforcement, description, trigger summary
- Prints "No learned rules yet." if empty

**`node learn.js remove <rule-name>`**
- Removes rule by name
- Errors if rule doesn't exist
- Writes updated file

**File location:** `learned-rules.json` lives in `.claude/skills/` alongside `skill-rules.json`. `learn.js` imports `findRulesFile()` from `engine.js` to locate the `.claude/skills/` directory, then targets `learned-rules.json` in that same directory. If no `skill-rules.json` exists yet (no rules configured), `learn.js` falls back to `<cwd>/.claude/skills/` and creates the directory if needed.

**Schema:** Identical to `skill-rules.json` — same `version`, `defaults`, `rules` structure. Loaded with the same `loadRules()` function.

### 3. Engine Changes (`hooks/lib/engine.js`)

Minimal, backward-compatible changes:

**New function: `findLearnedRulesFile(startDir)`**
- Same directory-walking logic as `findRulesFile()`, targeting `learned-rules.json`

**Modified: `activate()` and `enforce()`**
- After loading `skill-rules.json`, also attempt to load `learned-rules.json`
- Merge both rule sets into a single object for matching
- On name collision, `skill-rules.json` wins (hand-authored takes precedence)
- Missing or empty `learned-rules.json` is a no-op — fully backward compatible

No changes to matching logic, skip conditions, hook entry scripts, or output formatting.

## Windows Path Handling

This is critical — the engine runs on Windows (Git Bash) where file paths use backslashes.

- `learn.js` normalizes all `pathPatterns` and `pathExclusions` through `normalizePath()` before writing
- The SKILL.md instructs the agent to derive **relative** patterns from absolute paths (e.g., `**/*.sql` not `C:/Users/shurley/source/repos/project/**/*.sql`)
- Test cases specifically cover Windows-style paths being normalized on write

## Testing

### Unit Tests — `tests/learn.test.js` (new)

- **add**: valid rule writes successfully
- **add**: missing required fields rejected with error
- **add**: duplicate rule name rejected
- **add**: backslash paths normalized to forward slashes
- **add**: creates `learned-rules.json` if missing
- **add**: merges into existing file without clobbering
- **list**: shows rules with summary
- **list**: shows "no rules" when empty
- **remove**: existing rule removed, confirmed
- **remove**: nonexistent rule errors

### Unit Tests — `tests/engine.test.js` (additions)

- activate with both files — rules from both matched
- enforce with both files — block/warn from both work
- `skill-rules.json` wins on name collision
- `learned-rules.json` missing — graceful fallback
- `learned-rules.json` malformed — graceful fallback

### Integration Tests — `tests/test-hooks.sh` (additions)

- End-to-end: write a learned rule via `learn.js add`, then verify `enforce.sh` fires on it

## Future Enhancements (Not in Scope)

- **Correction detection (source A):** Agent detects mid-session corrections and proposes rules automatically. Requires a PostToolUse or conversation-analysis hook.
- **Post-mortem analysis (source B):** End-of-session review that proposes rules from mistakes.
- **SKILL.md generation:** For complex lessons that need more than a rule description.
- **Rule graduation:** Promote a learned rule to `skill-rules.json` after it proves valuable.

## File Map

| File | Action |
|------|--------|
| `skills/learn/SKILL.md` | Create |
| `hooks/lib/learn.js` | Create |
| `hooks/lib/engine.js` | Modify (add learned-rules loading + merge) |
| `tests/learn.test.js` | Create |
| `tests/engine.test.js` | Modify (add learned-rules test cases) |
| `tests/test-hooks.sh` | Modify (add integration test) |
