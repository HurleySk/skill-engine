# Stateless Per-Request Cache — Design Spec

**Date:** 2026-04-29
**Status:** Approved
**Problem:** Singleton HTTP server holds stale compiled rules and project state, causing recurring cross-repo contamination and caching bugs.

## Motivation

The skill-engine server is a persistent Node.js daemon that pre-compiles rules at startup and relies on file watchers + a `/reload` endpoint to stay in sync. This architecture has produced a steady stream of bugs:

- Cross-repo rule contamination (rules from ProjectA firing in ProjectB)
- Stale `RULES_DIR`/`PROJECT_ROOT` after multi-project switching
- File watcher race conditions and debounce edge cases
- Absolute vs. relative path mismatches in glob matching

All trace to the same root cause: a long-lived process holding mutable module-level state while the environment changes around it.

## Design

### 1. Mtime-gated rule cache

Replace file watchers and `/reload` with a `RuleCache` that checks freshness on every request via `fs.statSync`.

```
RuleCache {
  mainPath: string | null
  learnedPath: string | null
  mainMtime: number | null
  learnedMtime: number | null
  compiledRules: []
  rulesData: {}
  hasToolTriggerRules: bool
  hasOutputTriggerRules: bool
  hasStopRules: bool

  getRules(rulesDir) -> { compiledRules, rulesData, flags... }
    1. Derive file paths: rulesDir/skill-rules.json, rulesDir/learned-rules.json
    2. statSync() both files, compare mtime to cached values
    3. If same rulesDir and mtimes unchanged, return cached data
    4. If different rulesDir, or mtime changed, or first call: recompile, update cache (including stored rulesDir)
}
```

`fs.statSync` costs ~0.1ms. Recompilation only on actual file change. Well under 25ms budget.

### 2. Per-request project scoping

Each request derives its own project context instead of reading module-level globals.

```
function getRequestContext(input) {
  const projectDir = (input?.env?.CLAUDE_PROJECT_DIR)
                     || process.env.CLAUDE_PROJECT_DIR
                     || null;
  const rulesDir = projectDir ? normalizePath(projectDir) + '/.claude/skills' : null;
  const projectRoot = projectDir ? normalizePath(projectDir) : null;

  const cached = cache.getRules(rulesDir);

  return { projectRoot, rulesDir, ...cached };
}
```

Every handler calls `getRequestContext(input)` at the top. `ruleMatchesProject(entry, projectRoot)` takes the project root as a parameter instead of reading a global.

Fallback chain: hook input env > process.env > null (global rules only). No regression from current behavior.

### 3. Project-scoped session state

Session key changes from `sessionId` to `sessionId + '|' + projectRoot`.

```
function getSession(sessionId, projectRoot) {
  const key = sessionId + '|' + (projectRoot || '');
  ...
}
```

A `sessionOnce` rule that fired in ProjectA starts fresh when switching to ProjectB within the same session.

### 4. Request routing de-duplication

Replace 6 copy-pasted route blocks (~90 lines) with a route table and single dispatch loop:

```js
const routes = {
  '/activate':     { handler: handleActivate,    event: 'activate' },
  '/enforce':      { handler: handleEnforce,     event: 'enforce' },
  '/enforce-tool': { handler: handleEnforceTool, event: 'enforce-tool' },
  '/post-tool':    { handler: handlePostTool,    event: 'post-tool' },
  '/pre-write':    { handler: handlePreWrite,    event: 'pre-write' },
  '/stop':         { handler: handleStop,        event: 'stop' },
};
```

`/health`, `/pause`, `/resume`, and the POST fail-open catch-all stay as explicit blocks (unique logic).

### 5. Simplified start-server.sh

With per-request project derivation, `start-server.sh` no longer needs to send `/reload` on SessionStart:

- Same-version server already running: exit immediately (no `/reload`)
- Version mismatch: kill and restart (unchanged — preserves marketplace update flow)
- Not running: start without `--rules-dir` flag

The `echo "skill-engine: restarted (old → new)"` message is preserved.

## Removed

| Component | Replacement |
|-----------|-------------|
| `let RULES_DIR` (module-level) | Per-request from env |
| `let PROJECT_ROOT` (module-level) | Per-request from env |
| `deriveProjectRoot()` | `normalizePath(projectDir)` inline |
| `loadAndCompile()` as global side-effect | `RuleCache.getRules()` |
| `fs.watch` infrastructure | Mtime check in cache |
| `closeWatchers()` / `watchRuleFiles()` | Removed |
| `POST /reload` endpoint | Server is self-refreshing |
| `--rules-dir` CLI arg / `argVal()` | Server derives context per-request |
| `/reload` curl in start-server.sh | Not needed |
| 6 copy-pasted route blocks | Route table |

## Unchanged

- All handler logic (activate, enforce, enforce-tool, post-tool, pre-write, stop)
- `compileRules()` function (called from cache instead of global)
- `/health`, `/pause`, `/resume` endpoints
- Version mismatch restart in start-server.sh (marketplace flow)
- Session cleanup interval
- Fail-open POST catch-all
- Pre-write safety rules and validation
- All existing tests (updated to remove /reload dependency)

## Performance

- `fs.statSync` per request: ~0.1ms
- Recompilation only on file mtime change (same cost as today, just triggered differently)
- Route table lookup: O(1) hash, negligible
- Target remains <25ms per request
