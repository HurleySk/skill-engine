# Boomerang Hook Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate 3 path-guard hooks from boomerang's pre-write.sh command hook to skill-engine v3's HTTP server, then measure performance.

**Architecture:** Add response timing to skill-engine's server, install skill-engine as a git submodule in boomerang, add 3 guardrail rules to the existing skill-rules.json, configure HTTP hooks alongside the slimmed command hook, and verify enforcement + performance.

**Tech Stack:** Node.js (skill-engine server), Bash (hooks), Git submodules

**Repos:**
- Skill-engine: `C:\Users\shurley\source\repos\HurleySk\skill-engine`
- Boomerang: `C:\Users\shurley\source\repos\HurleySk\boomerang-`

---

## File Map

| Action | Repo | File | Responsibility |
|--------|------|------|----------------|
| Modify | skill-engine | `server/server.js:262-307` | Add X-Response-Time header + timing stats |
| Modify | skill-engine | `tests/server.test.js` | Test timing header exists |
| Modify | boomerang | `.claude/skills/skill-rules.json` | Add 3 guardrail rules |
| Modify | boomerang | `.claude/hooks/pre-write.sh` | Remove 3 path checks, keep complex validators |
| Modify | boomerang | `.claude/settings.json` | Add SessionStart + HTTP hooks |
| Create | boomerang | `.claude/hooks/start-skill-engine.sh` | Boot skill-engine server from submodule |

---

### Task 1: Add response timing to skill-engine server

**Files:**
- Modify: `C:\Users\shurley\source\repos\HurleySk\skill-engine\server\server.js:262-307`
- Modify: `C:\Users\shurley\source\repos\HurleySk\skill-engine\tests\server.test.js`

- [ ] **Step 1: Add timing test**

Append to the `Server Health` describe block in `tests/server.test.js`:

```javascript
it('GET /health includes timing stats', async () => {
  const res = await request('GET', '/health');
  assert.equal(typeof res.body.avgResponseTimeMs, 'number');
});
```

And add to the `Server Activate` describe block:

```javascript
it('POST /activate returns X-Response-Time header', async () => {
  const res = await requestRaw('POST', '/activate', { prompt: 'test-keyword', session_id: 'timing-1' }, 19752);
  assert.ok(res.headers['x-response-time'], 'should have X-Response-Time header');
  assert.ok(res.headers['x-response-time'].endsWith('ms'), 'should end with ms');
});
```

The `requestRaw` helper returns the raw response including headers. Add it near the existing `request` helper:

```javascript
function requestRaw(method, urlPath, body, port) {
  port = port || TEST_PORT;
  return new Promise((resolve, reject) => {
    const options = { hostname: 'localhost', port, path: urlPath, method,
      headers: body ? { 'Content-Type': 'application/json' } : {} };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data, raw: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd C:/Users/shurley/source/repos/HurleySk/skill-engine && node --test tests/server.test.js`
Expected: 2 new tests FAIL (no `avgResponseTimeMs` in health, no `X-Response-Time` header).

- [ ] **Step 3: Add timing to server.js**

In `server/server.js`, add timing tracking. At the top of the file (after the PRIORITY_ORDER line ~22), add:

```javascript
// --- Response timing ---
let totalResponseTimeNs = BigInt(0);
let timedResponses = 0;
```

Replace the `handleRequest` function (lines 262-307) with:

```javascript
async function handleRequest(req, res) {
  const start = process.hrtime.bigint();
  const url = req.url;
  const method = req.method;

  if (method === 'GET' && url === '/health') {
    const avgMs = timedResponses > 0 ? Number(totalResponseTimeNs / BigInt(timedResponses)) / 1e6 : 0;
    return respond(res, 200, {
      uptime: process.uptime(),
      rulesLoaded: compiledRules.length,
      port: PORT,
      lastEvent,
      eventsProcessed,
      activeSessions: sessions.size,
      avgResponseTimeMs: Math.round(avgMs * 100) / 100,
    });
  }

  if (method === 'POST' && url === '/activate') {
    try {
      const body = await readBody(req);
      eventsProcessed++;
      lastEvent = 'activate';
      const result = handleActivate(body);
      const elapsed = process.hrtime.bigint() - start;
      totalResponseTimeNs += elapsed;
      timedResponses++;
      res.setHeader('X-Response-Time', (Number(elapsed) / 1e6).toFixed(2) + 'ms');
      return respond(res, 200, result);
    } catch {
      return respond(res, 400, { error: 'Invalid JSON' });
    }
  }

  if (method === 'POST' && url === '/enforce') {
    try {
      const body = await readBody(req);
      eventsProcessed++;
      lastEvent = 'enforce';
      const result = handleEnforce(body);
      const elapsed = process.hrtime.bigint() - start;
      totalResponseTimeNs += elapsed;
      timedResponses++;
      res.setHeader('X-Response-Time', (Number(elapsed) / 1e6).toFixed(2) + 'ms');
      return respond(res, 200, result);
    } catch {
      return respond(res, 400, { error: 'Invalid JSON' });
    }
  }

  if (method === 'POST' && url === '/reload') {
    const count = loadAndCompile();
    eventsProcessed++;
    lastEvent = 'reload';
    return respond(res, 200, { reloaded: true, rulesLoaded: count });
  }

  respond(res, 404, { error: 'Not found' });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:/Users/shurley/source/repos/HurleySk/skill-engine && node --test tests/server.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Commit and push**

```bash
cd C:/Users/shurley/source/repos/HurleySk/skill-engine
git add server/server.js tests/server.test.js
git commit -m "feat: add X-Response-Time header and timing stats to server"
git push origin master
```

---

### Task 2: Install skill-engine as git submodule in boomerang

**Files:**
- Modify: `C:\Users\shurley\source\repos\HurleySk\boomerang-` (git submodule add)

- [ ] **Step 1: Add the submodule**

```bash
cd C:/Users/shurley/source/repos/HurleySk/boomerang-
git submodule add https://github.com/HurleySk/skill-engine.git .claude/skill-engine
```

- [ ] **Step 2: Verify the submodule is set up**

```bash
ls .claude/skill-engine/server/server.js
cat .gitmodules
```

Expected: `server.js` exists, `.gitmodules` shows the submodule mapping.

- [ ] **Step 3: Commit**

```bash
git add .gitmodules .claude/skill-engine
git commit -m "chore: add skill-engine as git submodule for HTTP-based enforcement"
```

---

### Task 3: Add 3 guardrail rules to boomerang's skill-rules.json

**Files:**
- Modify: `C:\Users\shurley\source\repos\HurleySk\boomerang-\.claude\skills\skill-rules.json`

- [ ] **Step 1: Add the 3 guardrail rules**

Add these 3 rules to the `rules` object in `.claude/skills/skill-rules.json` (after the existing `staging-group-reminder` rule):

```json
"work-repo-readonly": {
  "type": "guardrail",
  "enforcement": "block",
  "priority": "critical",
  "description": "work-repo/ is a read-only mirror — edits get overwritten on import.",
  "blockMessage": "work-repo/ is read-only. Edit work-repo-staging/ instead.",
  "triggers": {
    "file": {
      "pathPatterns": ["work-repo/**"],
      "pathExclusions": ["work-repo-staging/**"]
    }
  }
},
"adf-export-readonly": {
  "type": "guardrail",
  "enforcement": "block",
  "priority": "critical",
  "description": "adf-export/ contains read-only snapshots from live ADF.",
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
```

**Important:** The `work-repo-readonly` rule needs `pathExclusions: ["work-repo-staging/**"]` because `work-repo-staging/` contains `work-repo` in its path and would otherwise match `work-repo/**`.

- [ ] **Step 2: Validate JSON**

```bash
node -e "const r=JSON.parse(require('fs').readFileSync('.claude/skills/skill-rules.json','utf8'));console.log(Object.keys(r.rules).length + ' rules')"
```

Expected: `12 rules` (9 existing + 3 new).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/skill-rules.json
git commit -m "feat: add work-repo, adf-export, and connections.json guardrail rules"
```

---

### Task 4: Create start script and configure hooks

**Files:**
- Create: `C:\Users\shurley\source\repos\HurleySk\boomerang-\.claude\hooks\start-skill-engine.sh`
- Modify: `C:\Users\shurley\source\repos\HurleySk\boomerang-\.claude\settings.json`

- [ ] **Step 1: Create the start script**

Create `.claude/hooks/start-skill-engine.sh`:

```bash
#!/bin/bash
# Boot skill-engine HTTP server from submodule if not already running.

if [ "$SKILL_ENGINE_OFF" = "1" ]; then
  exit 0
fi

PORT="${SKILL_ENGINE_PORT:-19750}"

# Already running?
if curl -s --max-time 1 "http://localhost:$PORT/health" > /dev/null 2>&1; then
  exit 0
fi

SERVER_JS="$CLAUDE_PROJECT_DIR/.claude/skill-engine/server/server.js"
RULES_DIR="$CLAUDE_PROJECT_DIR/.claude/skills"

if [ ! -f "$SERVER_JS" ]; then
  exit 0
fi

nohup node "$SERVER_JS" --port "$PORT" --rules-dir "$RULES_DIR" > /dev/null 2>&1 &
disown

for i in 1 2 3; do
  sleep 1
  if curl -s --max-time 1 "http://localhost:$PORT/health" > /dev/null 2>&1; then
    exit 0
  fi
done

exit 0
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x .claude/hooks/start-skill-engine.sh
```

- [ ] **Step 3: Update settings.json**

Replace `.claude/settings.json` with:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/start-skill-engine.sh\""
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:19750/enforce"
          },
          {
            "type": "command",
            "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/pre-write.sh\""
          }
        ]
      }
    ]
  }
}
```

This puts the HTTP hook FIRST (fast path check) and the command hook SECOND (complex validators). Both run in parallel per Claude Code's architecture.

- [ ] **Step 4: Commit**

```bash
git add .claude/hooks/start-skill-engine.sh .claude/settings.json
git commit -m "feat: add skill-engine HTTP hook alongside pre-write.sh"
```

---

### Task 5: Slim down pre-write.sh

**Files:**
- Modify: `C:\Users\shurley\source\repos\HurleySk\boomerang-\.claude\hooks\pre-write.sh`

- [ ] **Step 1: Remove the 3 path checks from pre-write.sh**

Replace the header comment and the `case` block + CHECKs 1-3 with a simplified version. The file should become:

```bash
#!/bin/bash
# pre-write.sh — Complex validators only (task prod targeting + security model config).
# Simple path guards (work-repo, adf-export, connections.json) migrated to skill-engine HTTP server.

INPUT=$(cat)

# --- Extract file path (one jq call) ---
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.file // empty' 2>/dev/null)

# Normalize to forward slashes and get relative path
FILE_PATH="${FILE_PATH//\\//}"
REL_PATH="${FILE_PATH##*boomerang-/}"
REL_PATH="${REL_PATH##*boomerang/}"

# --- Fast exit: only inspect task files and security model config ---
case "$REL_PATH" in
  tasks/*.json) CHECK="task" ;;
  work-repo-staging/*ADFCreateAndPopulateSecurityModelConfig*) CHECK="workrepo-staging" ;;
  *) exit 0 ;;
esac

deny() {
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"SAFETY: $1\"}}"
  exit 0
}

ask() {
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"SAFETY: $1\"}}"
  exit 0
}

# ============================================================
# CHECK 1: Task files — prod targeting (the critical check)
# ============================================================
if [[ "$CHECK" == "task" ]]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // empty' 2>/dev/null)

  RULES_FILE="$CLAUDE_PROJECT_DIR/.claude/safety-rules.json"

  # Load rules or use defaults
  if [ -f "$RULES_FILE" ]; then
    RULES_BLOCK=$(jq -r '[
      (.prodFactories // [] | join("|")),
      (.prodConnections // [] | join("|")),
      (.prodEnvironments // [] | join("|")),
      (.prodDeployStepTypes // [] | join("|")),
      (.prodMutationStepTypes // [] | join("|")),
      (.prodUriPatterns // [] | join("|")),
      (.devRevertAllowedFactories // [] | join("|")),
      (.blockedExportBranches // [] | join("|")),
      (.readOnlyStepTypes // [] | join("|")),
      (.prodUriRegex // ""),
      (.prodNameRegex // "")
    ] | .[]' "$RULES_FILE" 2>/dev/null)

    PROD_FACTORIES=$(echo "$RULES_BLOCK" | sed -n '1p')
    PROD_CONNECTIONS=$(echo "$RULES_BLOCK" | sed -n '2p')
    PROD_ENVIRONMENTS=$(echo "$RULES_BLOCK" | sed -n '3p')
    PROD_DEPLOY_TYPES=$(echo "$RULES_BLOCK" | sed -n '4p')
    PROD_MUTATION_TYPES=$(echo "$RULES_BLOCK" | sed -n '5p')
    PROD_URI_PATTERNS=$(echo "$RULES_BLOCK" | sed -n '6p')
    DEV_REVERT_ALLOWED=$(echo "$RULES_BLOCK" | sed -n '7p')
    BLOCKED_BRANCHES=$(echo "$RULES_BLOCK" | sed -n '8p')
    READONLY_TYPES=$(echo "$RULES_BLOCK" | sed -n '9p')
    PROD_URI_RE=$(echo "$RULES_BLOCK" | sed -n '10p')
    PROD_NAME_RE=$(echo "$RULES_BLOCK" | sed -n '11p')
  fi

  # Fallback defaults
  : "${PROD_FACTORIES:=prd}"
  : "${PROD_CONNECTIONS:=prd|ferconlineprod}"
  : "${PROD_ENVIRONMENTS:=ferc|spprod|PRODSPO|hotlineprod|doidms|galprod}"
  : "${PROD_DEPLOY_TYPES:=adf-deploy-pipeline|sql-deploy-sp|adf-run-pipeline|adf-run-and-wait|adf-sandbox-run-and-wait}"
  : "${PROD_MUTATION_TYPES:=sql-deploy-sp}"
  : "${PROD_URI_PATTERNS:=ferc.crm9.dynamics.com|almsptier3prod.crm9.dynamics.com|orgc37aa7be.crm9.dynamics.com|hotlineprod.crm9.dynamics.com|doidms.crm9.dynamics.com|galprod.crm9.dynamics.com|fercalmstagingprd.database.usgovcloudapi.net|FDC1S-FOLSQLP2}"
  : "${DEV_REVERT_ALLOWED:=dev1}"
  : "${BLOCKED_BRANCHES:=main|master}"
  : "${READONLY_TYPES:=sql-query|sql-file|dataverse-query|dataverse-file|schema-pull|schema-index|adf-pull|adf-pull-all|sql-schema-pull|sql-schema-pull-all|work-repo-diff|adf-query-runs|adf-activity-errors|adf-trigger-status|adf-export-errors|adf-trace-run}"
  : "${PROD_URI_RE:=ferc\.crm9|hotlineprod\.crm9|doidms\.crm9|galprod\.crm9|orgc37aa7be\.crm9|almsptier3prod\.crm9}"
  : "${PROD_NAME_RE:=\bprod\b|PRODSPO|spprod}"

  # Task validation — node is needed here for complex JSON step parsing
  TASK_RESULT=$(echo "$CONTENT" | node -e "
    const fs = require('fs');
    const prodFactories = '${PROD_FACTORIES}'.split('|').filter(Boolean);
    const prodConns = '${PROD_CONNECTIONS}'.split('|').filter(Boolean);
    const prodEnvs = '${PROD_ENVIRONMENTS}'.split('|').filter(Boolean);
    const prodDeployTypes = '${PROD_DEPLOY_TYPES}'.split('|').filter(Boolean);
    const prodMutationTypes = '${PROD_MUTATION_TYPES}'.split('|').filter(Boolean);
    const prodUriPatterns = '${PROD_URI_PATTERNS}'.split('|').filter(Boolean);
    const devRevertAllowed = '${DEV_REVERT_ALLOWED}'.split('|').filter(Boolean);
    const readOnly = '${READONLY_TYPES}'.split('|').filter(Boolean);
    const blockedBranches = '${BLOCKED_BRANCHES}'.split('|').filter(Boolean);
    const prodUriRe = new RegExp('${PROD_URI_RE}', 'i');

    let connData = {};
    try {
      const connPath = require('path').resolve('${CLAUDE_PROJECT_DIR}', 'connections.json');
      connData = JSON.parse(fs.readFileSync(connPath, 'utf8'));
    } catch(e) {}
    const dvEnvs = connData.dataverse || {};

    function envUriIsProd(envName) {
      const env = dvEnvs[envName];
      if (!env || !env.url) return false;
      return prodUriPatterns.some(p => env.url.toLowerCase().includes(p.toLowerCase()));
    }

    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      try {
        const t = JSON.parse(d);
        const steps = t.steps || [];
        for (const s of steps) {
          const ty = s.type || '';

          if (ty === 'sql-query' && s.connection && prodConns.includes(s.connection)) {
            if (s.sql && /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|EXEC)\b/i.test(s.sql)) {
              console.log('DENY:Step ' + ty + ' contains DML/DDL targeting production connection ' + s.connection);
              return;
            }
            console.log('ASK:Step ' + ty + ' targets production connection ' + s.connection);
            return;
          }

          if (readOnly.includes(ty)) continue;

          if (ty === 'dev-revert' && s.factory && !devRevertAllowed.includes(s.factory)) {
            console.log('DENY:dev-revert only allowed against factory ' + devRevertAllowed.join('/') + ' -- not ' + s.factory);
            return;
          }

          if (s.factory && prodFactories.includes(s.factory)) {
            if (prodDeployTypes.includes(ty)) {
              console.log('DENY:Step ' + ty + ' targets production factory ' + s.factory);
              return;
            }
            console.log('ASK:Step ' + ty + ' targets production factory ' + s.factory);
            return;
          }
          if (s.connection && prodConns.includes(s.connection)) {
            if (prodMutationTypes.includes(ty) || prodDeployTypes.includes(ty)) {
              console.log('DENY:Step ' + ty + ' targets production connection ' + s.connection);
              return;
            }
            console.log('ASK:Step ' + ty + ' targets production connection ' + s.connection);
            return;
          }

          if (s.environment && prodEnvs.includes(s.environment)) {
            console.log('DENY:Step ' + ty + ' targets production environment ' + s.environment);
            return;
          }

          if (s.environment && envUriIsProd(s.environment)) {
            console.log('DENY:Step ' + ty + ' targets environment ' + s.environment + ' (resolves to prod URI)');
            return;
          }

          if (ty === 'run-script' && s.file) {
            try {
              const scriptPath = require('path').resolve('${CLAUDE_PROJECT_DIR}', s.file);
              if (fs.existsSync(scriptPath)) {
                const content = fs.readFileSync(scriptPath, 'utf8');
                if (prodUriRe.test(content)) {
                  console.log('ASK:Script ' + s.file + ' contains production URI patterns');
                  return;
                }
              }
            } catch(e) {}
          }

          if (ty === 'work-repo-export' && s.branch && blockedBranches.includes(s.branch)) {
            console.log('DENY:work-repo-export targets blocked branch ' + s.branch + ' -- use a feature branch');
            return;
          }
        }
        console.log('OK');
      } catch { console.log('OK'); }
    });
  " 2>/dev/null)

  if [[ "$TASK_RESULT" == DENY:* ]]; then
    deny "${TASK_RESULT#DENY:}"
  elif [[ "$TASK_RESULT" == ASK:* ]]; then
    ask "${TASK_RESULT#ASK:}"
  fi

  exit 0
fi

# ============================================================
# CHECK 2: work-repo-staging — security model config validation
# ============================================================
if [[ "$CHECK" == "workrepo-staging" ]]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // empty' 2>/dev/null)

  : "${PROD_URI_RE:=ferc\.crm9|hotlineprod\.crm9|doidms\.crm9|galprod\.crm9|orgc37aa7be\.crm9|almsptier3prod\.crm9}"
  : "${PROD_NAME_RE:=\bprod\b|PRODSPO|spprod}"

  TUPLES=$(echo "$CONTENT" | node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      const re=/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'/g;
      let m;
      while((m=re.exec(d))!==null){
        console.log(m[1]+'\t'+m[2]+'\t'+m[4]);
      }
    });" 2>/dev/null)

  while IFS=$'\t' read -r ENV_NAME DV_NAME SVC_URI; do
    [ -z "$ENV_NAME" ] && continue

    IS_PROD_ORG=false
    echo "$DV_NAME" | grep -qEi "$PROD_NAME_RE" && IS_PROD_ORG=true
    echo "$SVC_URI" | grep -qEi "$PROD_URI_RE" && IS_PROD_ORG=true

    if [ "$IS_PROD_ORG" = true ]; then
      case "$ENV_NAME" in
        prod) ;;
        dataqa) ask "Prod org '$DV_NAME' under environment_name='dataqa' — confirm this is intentional." ;;
        *) deny "Prod org '$DV_NAME' (URI: $SVC_URI) under environment_name='$ENV_NAME' — must be under 'prod'" ;;
      esac
    fi

    if echo "$SVC_URI" | grep -qEi "dev\.crm9|almwave3|almappdev1|lms-dev"; then
      if [ "$ENV_NAME" = "prod" ]; then
        deny "Dev URI '$SVC_URI' under environment_name='prod' — wrong environment"
      fi
    fi
  done <<< "$TUPLES"

  exit 0
fi

# Default: allow
exit 0
```

Key changes:
- Header comment updated
- `case` block simplified: removed `work-repo/*`, `adf-export/*`, `connections.json` cases
- Removed CHECKs 1-3 entirely (work-repo-readonly, adf-readonly, connections)
- Renumbered remaining checks to 1 and 2
- `work-repo-staging/*` case now matches `*ADFCreateAndPopulateSecurityModelConfig*` directly in the case pattern instead of checking inside the if block

- [ ] **Step 2: Verify the file parses correctly**

```bash
bash -n .claude/hooks/pre-write.sh && echo "syntax OK"
```

Expected: `syntax OK`

- [ ] **Step 3: Commit**

```bash
git add .claude/hooks/pre-write.sh
git commit -m "refactor: remove path guards from pre-write.sh (migrated to skill-engine)"
```

---

### Task 6: Test enforcement and measure performance

**Files:** None — verification only.

- [ ] **Step 1: Start the skill-engine server**

```bash
cd C:/Users/shurley/source/repos/HurleySk/boomerang-
node .claude/skill-engine/server/server.js --port 19750 --rules-dir .claude/skills &
```

Wait for "skill-engine server listening on port 19750".

- [ ] **Step 2: Verify rules loaded**

```bash
curl -s http://localhost:19750/health | node -e "process.stdin.resume();process.stdin.on('data',d=>console.log(JSON.parse(d)))"
```

Expected: `rulesLoaded: 12` (9 existing + 3 new guardrails).

- [ ] **Step 3: Test work-repo block**

```bash
curl -s -D - http://localhost:19750/enforce -H 'Content-Type: application/json' -d '{"tool_name":"Write","tool_input":{"file_path":"work-repo/some-pipeline.json"},"session_id":"test-1"}'
```

Expected: `decision: "block"`, `reason` mentions work-repo read-only. Check `X-Response-Time` header — should be under 25ms.

- [ ] **Step 4: Test adf-export block**

```bash
curl -s -D - http://localhost:19750/enforce -H 'Content-Type: application/json' -d '{"tool_name":"Edit","tool_input":{"file_path":"adf-export/pipeline/MyPipeline.json"},"session_id":"test-2"}'
```

Expected: `decision: "block"`, `reason` mentions adf-export read-only. Check `X-Response-Time`.

- [ ] **Step 5: Test connections.json warn**

```bash
curl -s -D - http://localhost:19750/enforce -H 'Content-Type: application/json' -d '{"tool_name":"Edit","tool_input":{"file_path":"connections.json"},"session_id":"test-3"}'
```

Expected: `decision: "allow"`, `stderr` mentions connections.json safety. Check `X-Response-Time`.

- [ ] **Step 6: Test normal file allow**

```bash
curl -s -D - http://localhost:19750/enforce -H 'Content-Type: application/json' -d '{"tool_name":"Write","tool_input":{"file_path":"src/something.js"},"session_id":"test-4"}'
```

Expected: `decision: "allow"`, no stderr. Check `X-Response-Time`.

- [ ] **Step 7: Test work-repo-staging allow (not blocked by work-repo rule)**

```bash
curl -s -D - http://localhost:19750/enforce -H 'Content-Type: application/json' -d '{"tool_name":"Write","tool_input":{"file_path":"work-repo-staging/some-sp.sql"},"session_id":"test-5"}'
```

Expected: `decision: "allow"` (may have staging-group-reminder warn). Confirms the `pathExclusions` on the work-repo rule works.

- [ ] **Step 8: Check aggregate timing**

```bash
curl -s http://localhost:19750/health | node -e "process.stdin.resume();process.stdin.on('data',d=>{const h=JSON.parse(d);console.log('Avg response time: '+h.avgResponseTimeMs+'ms');console.log('Events processed: '+h.eventsProcessed)})"
```

Expected: `avgResponseTimeMs` under 10ms. This is the headline number.

- [ ] **Step 9: Kill the test server**

```bash
kill $(lsof -ti:19750) 2>/dev/null || taskkill //F //PID $(netstat -ano | grep ":19750 " | head -1 | awk '{print $5}') 2>/dev/null
```

- [ ] **Step 10: Report results**

Summarize: which rules blocked/warned correctly, what the average and per-call response times were, and whether this validates the v3 approach.

---

## Self-Review

**Spec coverage:**
- Response timing added to skill-engine server (Task 1)
- Submodule installation (Task 2)
- 3 guardrail rules in skill-rules.json (Task 3)
- Hook config with HTTP + command hooks (Task 4)
- pre-write.sh slimmed (Task 5)
- Correctness + performance testing (Task 6)

**Placeholder scan:** No TBDs. All code blocks are complete. All commands are exact.

**Type consistency:** `decision: "block"/"allow"`, `reason`, `stderr` match server.js response format throughout. Rule schema matches existing skill-rules.json structure. `pathExclusions` used correctly for work-repo-staging edge case.
