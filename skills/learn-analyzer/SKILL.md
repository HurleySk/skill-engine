---
name: learn-analyzer
description: Create an async analyzer — a project-local JS script that runs off-thread to validate files, check cross-file consistency, or guard against bad patterns. Findings are advisory, delivered on the next prompt.
argument-hint: "[list]"
---

# Skill Engine — Learn Analyzer

You help users create async analyzers — project-local JavaScript scripts that run off the main thread to validate files, check cross-file consistency, or guard against bad patterns.

## Commands

- **(default)**: Create a new analyzer
- **list**: Show existing analyzers in the current project

## Finding the Plugin Directory

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
```

## Listing Existing Analyzers

```bash
node "$PLUGIN_DIR/hooks/lib/analyzer-scaffold.js" list
```

Show the output to the user.

## What Are Async Analyzers?

Async analyzers are JS scripts that live in `.claude/skills/analyzers/{name}.js`. They run off the main thread in a worker when a matching rule triggers. Findings are advisory — they cannot block tool calls or prompt the user. Instead, findings are delivered as context at the top of the next `UserPromptSubmit` event. Analyzers can read files, parse JSON, cross-check references across the project, and even auto-fix files by writing corrected content back to disk.

## Creating a New Analyzer

### Step 1: Design the Analyzer

Ask the user what they want to detect, when it should trigger, and how severe the findings should be. If the user provided context from the triage router or as an argument, use that instead of asking.

Based on the description, classify the complexity tier:

| Tier | Lines | Example |
|------|-------|---------|
| Simple guard | <40 | Detect forbidden patterns in a file |
| Reference checker | <80 | Validate references exist across files |
| Dual-mode | <100 | Different checks per file type |
| Auto-fixer | 100+ | Read config, compare, auto-fix mismatches |

Tell the user which tier their analyzer falls into. This sets expectations for how much code you'll generate.

### Step 2: Choose Trigger + Rule Shape

The analyzer needs a rule that fires it. Show the user this template and fill it in based on their design:

```json
{
  "my-check": {
    "type": "guardrail",
    "enforcement": "warn",
    "priority": "medium",
    "description": "...",
    "async": {
      "handler": "analyzer",
      "name": "my-check",
      "config": {}
    },
    "triggers": {
      "file": {
        "pathPatterns": ["**/*.json"]
      }
    }
  }
}
```

**IMPORTANT:** The `enforcement` field on async rules is advisory regardless of its value. The sync evaluation path skips async rules entirely — they only run in the background worker. Setting `enforcement: "block"` will NOT actually block the tool call. Use `warn` to set the right expectation.

**Trigger options:**

- **`triggers.file`** — fires when a file is edited. Use `pathPatterns` for glob matching and `contentPatterns` for regex matching against file content.
- **`triggers.tool`** — fires on any tool call. Use `toolNames` to filter which tools match and `inputPatterns` for regex against stringified tool input.
- **`triggers.output`** — fires after a tool completes. Use `toolNames` to filter and `outputPatterns` for regex against tool output.

The `async.config` object is passed directly to the analyzer's `config` parameter — use it for thresholds, file paths, or any static configuration the analyzer needs.

Present the proposed rule for confirmation before proceeding.

### Step 3: Scaffold the Analyzer Script

Present the full analyzer contract to the user, then write the implementation based on their Step 1 design:

```js
'use strict';
var fs = require('fs');
var path = require('path');

exports.analyze = function(context, config) {
  // context.projectRoot — absolute path to project root
  // context.filePath    — relative path of the triggering file
  // context.content     — file content or tool input
  // context.toolName    — the tool that triggered (Edit, Bash, etc.)
  // context.toolInput   — raw tool input (for tool triggers)
  // context.ruleName    — name of the matched rule
  // config              — from the rule's async.config object
  //
  // Return: Array of findings
  // Each finding: { severity: 'warning'|'info', message: '...', relatedFiles?: ['...'] }
  return [];
};
```

**Guidelines for writing the analyzer body:**

- Use `path.join(context.projectRoot, ...)` for all file reads — never hardcode absolute paths.
- Wrap file reads in try/catch — the file may not exist or may be unreadable.
- Return an empty array when everything is valid — no findings means no advisory.
- Keep `relatedFiles` paths relative to project root when included.
- Use `context.content` when checking the triggering file itself; read from disk when cross-checking against other files.

Based on the user's design from Step 1, write the full analyzer implementation and present it for review. Ask: "Want to adjust anything, or should I save this?"

### Step 4: Save

On confirmation, write the analyzer file to the project:

```bash
mkdir -p "$CLAUDE_PROJECT_DIR/.claude/skills/analyzers"
```

Then use the Write tool to create `.claude/skills/analyzers/{name}.js` with the analyzer code.

Alternatively, if the backing scaffold code is available:

```bash
node "$PLUGIN_DIR/hooks/lib/analyzer-scaffold.js" create "<name>" --dir "$CLAUDE_PROJECT_DIR"
```

(with the analyzer body piped via stdin)

### Step 5: Wire the Rule

Save the async rule to the project's skill-rules.json:

```bash
node "$PLUGIN_DIR/hooks/lib/learn.js" add "<rule-name>" '<rule-json>' --file .claude/skills/skill-rules.json
```

The `async.name` field in the rule must match the filename (without `.js`) of the analyzer saved in Step 4.

### Step 6: Verify

Tell the user:

- Analyzer saved to `.claude/skills/analyzers/{name}.js`
- Rule wired in `skill-rules.json`
- Next time the trigger matches, the analyzer runs off-thread in a worker
- Findings appear at the top of the next prompt as advisory context
- Run `/skill-engine:status` to confirm `hasAsyncRules: true`

## Complexity Reference

Condensed examples of real analyzers to illustrate each tier:

1. **Simple guard** — `task-deletion-guard`: Checks if a deleted task file has a corresponding result file in `tasks/results/`. If so, warns that the result will be orphaned. ~37 lines.

2. **Reference checker** — `validate-pipeline-refs`: Walks `adf-export/` pipeline JSON, extracts `referenceName` values from activities, and verifies that referenced pipelines, datasets, and linked services actually exist as files. ~63 lines.

3. **Dual-mode** — `sp-dv-query-guard`: Applies different checks based on file type. For `connections.json`, checks for forbidden production URLs. For task files, checks for forbidden environment targets. One analyzer, two code paths. ~86 lines.

4. **Auto-fixer** — `factory-config-validator`: Reads `config/factory-expected.json` for the canonical linked service configuration per factory, compares against live linked service files in `adf-export/`, and auto-fixes task files that reference mismatched configurations. ~315 lines.

## Notes

- All path patterns must use forward slashes, even on Windows
- Analyzer name must not contain `/`, `\`, or `..` (path traversal protection)
- The deprecated format `async: { analyzer: "name" }` still works but use the current `async: { handler: "analyzer", name: "..." }` format
- Worker timeout is 10s per invocation — keep analyzers focused and fast
- Max 20 findings queued per session (oldest evicted on overflow)
