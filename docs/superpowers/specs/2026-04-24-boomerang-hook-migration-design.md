# Boomerang Hook Migration — Skill Engine v3 Integration Test

## Problem

Boomerang's `pre-write.sh` is a command hook (type: "command") on PreToolUse(Write|Edit) that runs 5 safety checks in a single bash script. Every Write/Edit spawns a bash process (~200-500ms on Windows) even when most checks don't apply to the file being edited. Three of these checks are simple path-pattern guards that map directly to skill-engine rules.

## Goal

Migrate the 3 simple path guards from `pre-write.sh` to skill-engine v3's HTTP server as a real-world performance test. Measure actual latency to validate the ~6-21ms per-event claim. Leave the 2 complex validators in a slimmed-down `pre-write.sh`.

## What Migrates

| Check | Path Pattern | Enforcement | Block Message |
|-------|-------------|-------------|---------------|
| work-repo/ read-only | `work-repo/**` | block | "work-repo/ is read-only. Use work-repo-staging/ instead." |
| adf-export/ read-only | `adf-export/**` | block | "adf-export/ is read-only. Use adf-pull task steps instead." |
| connections.json safety | `**/connections.json` | warn | "Verify no production environments are being added unintentionally." |

## What Stays in pre-write.sh

- **Task file production targeting** — 150+ lines of Node.js doing JSON parsing, connection resolution, prod identifier matching with DENY/ASK/OK decisions. Too complex for path+content pattern rules.
- **Security model config validation** — Tuple extraction, cross-referencing environment names against URIs. Also too complex for the rule schema.

These two checks remain as a command hook. The script gets slimmed down (3 path checks removed), making it faster even as a command hook.

## Implementation

### Step 1: Add response timing to skill-engine server

Add `X-Response-Time` header to `/enforce` and `/activate` responses in `server/server.js`. Three lines:

```javascript
const start = process.hrtime.bigint();
// ... handle request ...
res.setHeader('X-Response-Time', Number(process.hrtime.bigint() - start) / 1e6 + 'ms');
```

Also add `avgResponseTime` to `/health` endpoint for aggregated visibility.

Commit to skill-engine repo.

### Step 2: Install skill-engine in boomerang as git submodule

```bash
cd boomerang-/
git submodule add https://github.com/HurleySk/skill-engine.git .claude/skill-engine
```

This places the skill-engine repo at `.claude/skill-engine/` in boomerang. The server, hooks, and lib are all accessible. Updates are explicit via `git submodule update`.

### Step 3: Write skill-rules.json

Create `.claude/skills/skill-rules.json` in boomerang:

```json
{
  "version": "1.0",
  "defaults": {
    "enforcement": "warn",
    "priority": "medium"
  },
  "rules": {
    "work-repo-readonly": {
      "type": "guardrail",
      "enforcement": "block",
      "priority": "critical",
      "description": "work-repo/ is a read-only mirror. Use work-repo-staging/ instead.",
      "blockMessage": "work-repo/ is read-only. Use work-repo-staging/ instead.",
      "triggers": {
        "file": {
          "pathPatterns": ["work-repo/**"]
        }
      }
    },
    "adf-export-readonly": {
      "type": "guardrail",
      "enforcement": "block",
      "priority": "critical",
      "description": "adf-export/ contains read-only snapshots from live ADF. Use adf-pull task steps instead.",
      "blockMessage": "adf-export/ is read-only. Use adf-pull task steps to update these files.",
      "triggers": {
        "file": {
          "pathPatterns": ["adf-export/**"]
        }
      }
    },
    "connections-json-safety": {
      "type": "guardrail",
      "enforcement": "warn",
      "priority": "high",
      "description": "Verify no production environments are being added to connections.json unintentionally.",
      "triggers": {
        "file": {
          "pathPatterns": ["**/connections.json"]
        }
      }
    }
  }
}
```

### Step 4: Configure boomerang hooks

Update boomerang's `.claude/settings.json` to:

1. Add a SessionStart hook to boot the skill-engine server (pointing to the submodule)
2. Add an HTTP PreToolUse hook for `/enforce`
3. Keep the slimmed-down `pre-write.sh` as a command hook for the 2 complex validators

The PreToolUse section will have TWO hooks on Write|Edit:
- HTTP hook → skill-engine server (path guards, ~6-21ms)
- Command hook → slimmed pre-write.sh (complex validators, ~200-500ms but only for task files and security model config)

Hooks run in parallel per Claude Code's architecture, so the total time is max(HTTP, command), not sum.

### Step 5: Slim down pre-write.sh

Remove the 3 path-based checks (work-repo, adf-export, connections.json) from `pre-write.sh`. The script retains only:
- Task file production targeting validation (lines ~66-220)
- Security model config validation (lines ~225-267)

Add early-exit for files that don't match `tasks/*.json` or `*ADFCreateAndPopulateSecurityModelConfig*` — if neither pattern matches, exit 0 immediately. This makes the command hook much faster for the common case (editing a normal file).

### Step 6: Start server and test

Boot the skill-engine server:
```bash
node .claude/skill-engine/server/server.js --port 19750 --rules-dir .claude/skills
```

Test each rule:
1. Try to write to `work-repo/somefile.json` → expect block
2. Try to write to `adf-export/pipeline.json` → expect block
3. Try to write to `connections.json` → expect warn
4. Try to write to `tasks/some-task.json` → expect allow from skill-engine (pre-write.sh handles task validation separately)
5. Try to write to `src/normal-file.js` → expect allow from both

Check `X-Response-Time` header on each `/enforce` call to verify latency.

## Performance Expectations

**Before (all checks in pre-write.sh):**
- Every Write/Edit: ~200-500ms (bash spawn + all 5 checks)

**After (split between HTTP + slimmed command hook):**
- Path guard checks via HTTP: ~6-21ms
- Complex validator checks via command hook: ~200-500ms, BUT with early-exit for non-matching files (~50ms for the common case where file doesn't match task/security patterns)
- Both run in parallel: total = max(HTTP, command)
- Common case (editing normal files): ~50ms (command hook exits early, HTTP check is fast)
- Task file case: ~200-500ms (command hook does full validation)

**Net improvement:** For the majority of Write/Edit operations (non-task files), latency drops from ~200-500ms to ~50ms. Task file edits stay about the same.

## Success Criteria

1. All 3 path guards correctly block/warn via HTTP server
2. Complex validators still work in slimmed pre-write.sh
3. `X-Response-Time` on `/enforce` calls consistently under 25ms
4. No regressions in safety — prod targeting still blocked, read-only dirs still protected
