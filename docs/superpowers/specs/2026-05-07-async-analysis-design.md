# Async Analysis for Skill Engine

## Problem

Skill-engine rules currently run synchronously on the hook hot path with a 25ms latency budget. This makes complex validation impractical — cross-file consistency checks, schema validation against large structures, and dependency impact analysis all exceed that budget. There's no way to run expensive analysis without degrading the user experience.

## Solution

Add an async analysis system that runs CPU-bound validation in a dedicated worker thread. Results are advisory — they arrive on the next `UserPromptSubmit` as context, not as blocking decisions. Rules opt in by declaring an `async` field that points to a user-authored JavaScript analyzer script.

## Design Decisions

- **Advisory only.** Async rules cannot block or ask — results arrive after the tool call has already happened. The model sees findings on its next turn and can self-correct.
- **Worker threads, not setImmediate.** A dedicated worker thread guarantees zero latency impact on the sync path. No risk of a long-running scan spiking a hook response.
- **Scripts, not built-ins.** Every async rule must reference a JS analyzer script. No async without a script — there's nothing to do asynchronously without custom logic. Scripts live in the project at `.claude/skills/analyzers/`.
- **Delivery via UserPromptSubmit.** Findings accumulate in a per-session queue and drain when `/activate` fires. Natural batch point, clean separation from sync output.

## Worker Lifecycle & Singleton Guarantee

One worker thread. Ever. Enforced at the module level.

- `server/async-manager.js` owns a module-scoped `let worker = null`
- `getWorker()` spawns if `worker === null`, returns existing otherwise
- No other code path can construct a `Worker` — the worker file path and spawn logic are private to this module
- Worker spawns once (at server start or lazily on first async rule match) and stays alive for the server's lifetime

**Death handling:**

- Worker `exit` event sets `worker = null` and logs the reason
- A `respawnCount` counter tracks crashes. If it exceeds 3 within 5 minutes, async analysis is marked as degraded — async rules become no-ops until the server restarts
- Prevents crash loops from burning CPU

**Shutdown:**

- `SIGTERM`/`SIGINT` handlers call `worker.terminate()` before closing the HTTP server

**Health visibility:**

```json
{
  "asyncWorker": {
    "alive": true,
    "respawnCount": 0,
    "jobsProcessed": 42,
    "degraded": false
  }
}
```

## Rule Schema

Rules opt into async analysis with an `async` field:

```json
{
  "cross-file-consistency": {
    "type": "guardrail",
    "description": "Validates that edits don't break assumptions in dependent files",
    "async": {
      "analyzer": "cross-file",
      "config": {
        "scanPatterns": ["src/**/*.js"],
        "maxFiles": 50
      }
    },
    "triggers": {
      "file": {
        "pathPatterns": ["src/**/*.js"]
      }
    },
    "guidance": "This edit may break assumptions in dependent files."
  }
}
```

- **`async` field presence** makes a rule async. No `async` = synchronous, backward compatible.
- **`analyzer`** resolves to `{rulesDir}/analyzers/{name}.js`. The worker `require()`s the module and calls its exported `analyze()` function.
- **`config`** is an opaque object passed to the analyzer. Each analyzer defines what it expects.
- **Triggers still apply** — they determine *when* the rule matches. The `async` block controls *how* validation runs once matched.
- **No `async` without `analyzer`.** If declared without one, the compiler warns and treats the rule as sync.
- **Cannot use `enforcement: "block"` or `"ask"`.** Compiler warns and ignores — async results are advisory only.

## Analyzer Script Contract

Analyzer scripts are plain JavaScript modules in `.claude/skills/analyzers/`:

```js
// .claude/skills/analyzers/cross-file.js
module.exports.analyze = async function(context, config) {
  // context: { filePath, content, projectRoot, toolName }
  // config: from the rule's async.config object
  // return: [{ severity: 'warning'|'info', message: '...', relatedFiles: [] }]
  return [];
};
```

- Must export an `analyze` function (sync or async)
- Receives `context` (what triggered the rule) and `config` (from the rule definition)
- Returns an array of findings, possibly empty
- If the file doesn't exist or the export is missing, the rule is skipped and logged

**Safety bounds enforced by the worker:**

- Timeout per invocation: 10 seconds. If the analyzer hangs, the job is killed and logged.
- Hard ceiling: max 200 files per analyzer invocation regardless of `config` values. The worker tracks `fs.readFileSync` calls via the context object and stops the analyzer if the cap is hit.

## Message Protocol

**Main thread → Worker:**

```js
{
  id: "job-uuid",
  sessionId: "abc123",
  projectRoot: "/users/sam/project",
  analyzer: "cross-file",
  config: { scanPatterns: ["src/**/*.js"], maxFiles: 50 },
  context: {
    filePath: "/users/sam/project/src/foo.js",
    content: "...",
    toolName: "Edit",
    ruleName: "cross-file-consistency"
  }
}
```

**Worker → Main thread:**

```js
{
  id: "job-uuid",
  sessionId: "abc123",
  ruleName: "cross-file-consistency",
  status: "completed",   // or "error"
  findings: [
    {
      severity: "warning",
      message: "Edit to src/foo.js breaks import assumption in src/bar.js:14",
      relatedFiles: ["src/bar.js"]
    }
  ],
  durationMs: 187
}
```

- **Job ID** correlates requests to responses and detects orphaned jobs
- **`status: "error"`** means the analyzer failed — logged server-side, not surfaced to the model
- **`findings`** is always an array. Empty = nothing found, not delivered.
- **Fire and forget** from the main thread. No acknowledgment protocol. Node's message channel handles buffering natively.

## Session Queue

- `Map<sessionId, Finding[]>` on the main thread
- Findings accumulate as the worker posts results back
- Cap: 20 findings per session. Oldest evicted on overflow with a summary message.
- Drained on read — once `/activate` consumes findings, they're gone
- Stale session cleanup (existing 5-minute interval) also clears findings for dead sessions

## Delivery via UserPromptSubmit

The existing `/activate` handler appends async findings after normal sync output:

```
⚡ Skill Engine — 1 relevant skill detected:

[HIGH] some-skill-rule
  Description here

───────────────────────────────
⚠️ Async Analysis Results (2 findings):

[cross-file-consistency] warning
  Edit to src/foo.js breaks import assumption in src/bar.js:14
  Related: src/bar.js

[schema-validate] warning
  Field "status" in config.json does not match expected enum values
  Related: schemas/config-schema.json
```

- Visually separated from sync activation output
- If no sync matches but findings exist, findings still delivered
- If nothing at all, return `{}` as today
- Findings ordered by completion time (chronological)

## File Changes

**New files:**

- `server/async-worker.js` — worker script: message listener, analyzer loader, timeout enforcement
- `server/async-manager.js` — main-thread module: singleton worker reference, `getWorker()`, `postJob()`, `drainFindings(sessionId)`, death/respawn handling

**Modified files:**

- `server/server.js`:
  - `handlePreTool()` — after sync checks, post jobs for matched async rules
  - `handleActivate()` — drain findings queue and append to response
  - `/health` — add `asyncWorker` status
  - `shutdown()` — terminate worker
- Rule compiler (`compileRules()`) — validate async rules: must have `analyzer`, cannot have blocking enforcement

**Unchanged:**

- `hooks/lib/rules-io.js`
- `hooks/lib/glob-match.js`
- `server/pre-write-safety.js`
- `.claude-plugin/plugin.json` — no new hooks, async rides on existing PreToolUse and UserPromptSubmit
- `hooks/start-server.sh`

## Performance Impact

Zero on the sync path. The only new work in the hot path is checking whether a matched rule has an `async` property — a property lookup, not a computation. All heavy work runs in the worker thread's V8 isolate.
