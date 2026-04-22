# Learn Expansion: Triage Router + Sub-Skills

**Date**: 2026-04-21  
**Status**: Approved  
**Scope**: skill-engine plugin

## Problem

`/skill-engine:learn` only produces guardrail rules in `learned-rules.json`. A lesson learned in a session could be better expressed as a hook (automation), a skill (multi-step workflow), or an update to an existing rule. The current design forces everything into a rule shape.

## Solution

Break `learn` into a triage router plus three focused sub-skills. One entry point, multiple output types. The user says what they learned; the agent classifies and routes.

```
/skill-engine:learn            triage router, classifies lesson
    ├─→ /skill-engine:learn-rule     create, update, promote rules
    ├─→ /skill-engine:learn-hook     create/update Claude Code hooks in settings.json
    └─→ /skill-engine:learn-skill    scaffold SKILL.md files from lessons
```

**Approach**: Hybrid — conversational triage and content generation in SKILL.md files, deterministic file I/O and validation in backing code. `learn-hook` leans heaviest on code since malformed hook entries break the entire Claude Code setup.

## Triage Router — `learn/SKILL.md`

Rewritten from current 125-line rule-specific logic to ~40-50 lines of classification logic.

**Input**: User describes a lesson.

**Classification heuristics**:

| Signal | Routes to |
|---|---|
| "warn/block/never/always when editing X files" | `learn-rule` |
| "run [tool] before/after [action]", automation, shell commands | `learn-hook` |
| "when doing X, follow these steps", multi-step workflow | `learn-skill` |
| "update that rule to also cover...", "promote that learned rule" | `learn-rule` (update mode) |

**Ambiguous cases**: The router asks one clarifying question to disambiguate, then routes.

**List and remove**: These subcommands stay in the router since they apply across all learned artifact types.

## learn-rule — Create, Update, Promote Rules

**SKILL.md** (~80-100 lines) guides three flows:

### Create

Same as today's learn flow, refined. Capture the lesson, infer rule fields (type, enforcement, priority, triggers), present for approval, save to `learned-rules.json` via `node learn.js add`.

### Update

User says "that SQL rule should also cover .psql files." The skill lists matching rules, shows current state, asks what to change, presents a before/after diff, saves on approval. Works on rules in either file.

### Promote

User says "make that learned rule permanent." Shows the learned rule, confirms, moves it from `learned-rules.json` to `skill-rules.json`.

### Backing code — `learn.js` additions

```
learn.update(name, updates, file)
  - Shallow merge on rule object
  - Merges into existing triggers rather than replacing
  - Returns { ok, error? }

learn.promote(name, fromPath, toPath)
  - Read both files, add to target, remove from source
  - Write target first — if target write fails, source is untouched
  - If source write fails after target succeeds, return { ok: false } with both states described
  - Returns { ok, error? }
```

Existing functions unchanged: `add`, `list`, `remove`.

## learn-hook — Create/Update Hook Entries in settings.json

The most code-driven sub-skill. SKILL.md collects intent, `hook-manager.js` does everything else.

### SKILL.md (~60-70 lines)

Collects three things:

1. **What event** — UserPromptSubmit, PreToolUse, PostToolUse, etc.
2. **What command** — the shell command to run
3. **What matcher** — which tools trigger it (PreToolUse/PostToolUse only, e.g. `["Edit", "Write"]`)

Presents the proposed hook for confirmation, then calls `node hook-manager.js add`.

### Backing code — `hook-manager.js` (new)

```
hookManager.add(hookType, entry, settingsPath)
  - Read settings.json safely
  - Check for duplicate/conflicting entries
  - Append entry to the right hook array
  - Write back atomically — don't clobber other settings
  - Return { ok, error? }

hookManager.list(settingsPath)
  - Read and display all hook entries, grouped by type

hookManager.remove(hookType, index|command, settingsPath)
  - Remove a hook entry by position or command match

hookManager.validate(hookType, entry)
  - Validate hook type is known
  - Validate command is non-empty
  - Validate matcher is array of strings if present
```

**Settings.json safety**: Read the full file, parse, modify only the `hooks` key, write back. If the file doesn't exist, create it with just the hooks section. If it exists but has no `hooks` key, add it without touching anything else.

## learn-skill — Scaffold SKILL.md Files From Lessons

The most conversational sub-skill. Claude does the creative work, code handles structure and placement.

### SKILL.md (~80-100 lines)

1. **Capture the workflow** — what did you learn, what are the steps, when does this apply?
2. **Shape into skill content** — Claude drafts the instructional body: when to use, step-by-step process, key principles, gotchas
3. **Present for review** — show the full SKILL.md draft, revise until approved
4. **Save** — call `node skill-scaffold.js create`

### Backing code — `skill-scaffold.js` (new)

```
scaffold.create(name, description, body, outputDir)
  - Slugify name to file-safe directory name
  - Build valid frontmatter (---, name, description, ---)
  - Write body after frontmatter
  - Create directory + SKILL.md at outputDir/<slug>/SKILL.md
  - Return { ok, path, error? }

scaffold.validate(name, description, body)
  - Name is non-empty
  - Description fits one line
  - Body is non-empty
  - No broken frontmatter characters

scaffold.list(outputDir)
  - Find all SKILL.md files, show name + description from frontmatter
```

**Output location**: Project-local — `.claude/skills/<slug>/SKILL.md`. Auto-discovered by Claude Code, no registration step needed.

## File Structure

```
skill-engine/
├── hooks/lib/
│   ├── engine.js              ← unchanged
│   ├── glob-match.js          ← unchanged
│   ├── learn.js               ← gains update() + promote()
│   ├── hook-manager.js        ← new
│   └── skill-scaffold.js      ← new
├── skills/
│   ├── learn/SKILL.md         ← rewritten as triage router
│   ├── learn-rule/SKILL.md    ← new
│   ├── learn-hook/SKILL.md    ← new
│   ├── learn-skill/SKILL.md   ← new
│   ├── rules/SKILL.md         ← unchanged
│   └── setup/SKILL.md         ← unchanged
├── tests/
│   ├── engine.test.js         ← unchanged
│   ├── glob-match.test.js     ← unchanged
│   ├── learn.test.js          ← gains update + promote tests
│   ├── hook-manager.test.js   ← new
│   ├── skill-scaffold.test.js ← new
│   └── fixtures/
│       ├── valid-rules.json        ← exists
│       ├── sample-settings.json    ← new
│       └── sample-skill.md         ← new
```

## Plugin Registration

New skills need entries in `.claude-plugin/plugin.json`:
- `/skill-engine:learn-rule`
- `/skill-engine:learn-hook`
- `/skill-engine:learn-skill`

Same pattern as the existing three skills.

## Testing Strategy

### Unit tests (full coverage on backing code)

**learn.test.js** adds:
- `update` merges correctly (partial triggers, enforcement changes)
- `promote` removes from source + adds to target atomically
- Promote fails cleanly if rule doesn't exist

**hook-manager.test.js**:
- Add to empty settings.json
- Add to existing hooks array
- Duplicate detection
- Remove by command match
- Validate rejects bad hook types
- Doesn't clobber non-hook settings keys

**skill-scaffold.test.js**:
- Creates directory + SKILL.md
- Valid frontmatter output
- Slugifies names correctly
- Validates inputs
- List finds all SKILL.md files

### Integration tests

End-to-end: add a hook via hook-manager, verify settings.json is correct. Create a skill via scaffold, verify SKILL.md is valid.

### No tests for SKILL.md triage logic

Conversational classification is tested by using it. Backing code is where correctness matters.

## Relationship to Existing Skills

- **`/skill-engine:rules`** — unchanged. Remains the deliberate authoring tool for `skill-rules.json`. `learn-rule` is reactive capture; `rules` is intentional craft. Promotion bridges the two.
- **`/skill-engine:setup`** — unchanged. Still handles initial hook installation. `learn-hook` adds individual hook entries after setup has established the base configuration.
