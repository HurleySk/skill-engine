---
name: start
description: Start or resume the skill-engine HTTP server. Detects version mismatches after plugin updates and restarts automatically.
---

# Skill Engine — Start

Start, resume, or restart the rule enforcement server.

## Steps

1. Check if the server is running:

```bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
```

2. **If running**, check for version mismatch:

Compare the `version` field from the health response against the current plugin.json version:

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.CLAUDE_PLUGIN_ROOT + '/.claude-plugin/plugin.json', 'utf8')).version)" 2>/dev/null
```

If `CLAUDE_PLUGIN_ROOT` is not set, find the latest cached version:

```bash
ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1
```

Then read `plugin.json` from that directory.

3. **If running + version mismatch**, restart:

Kill the old server by PID (from the `pid` field in the health response), then start fresh:

```bash
kill {pid}
sleep 1
bash "{plugin_dir}/hooks/start-server.sh"
```

Re-check health and show status. Tell the user:

> Skill Engine restarted ({old_version} → {new_version}).

4. **If running + paused** (`paused: true` in health response), resume it:

```bash
curl -s -X POST http://localhost:${SKILL_ENGINE_PORT:-19750}/resume
```

Re-check health and show status. Tell the user: "Skill Engine resumed."

5. **If running + same version + not paused**, show the user the status:

> Skill Engine server is already running.
> - Version: {version}
> - Port: {port}
> - Uptime: {uptime}s
> - Rules loaded: {rulesLoaded}
> - Events processed: {eventsProcessed}
> - Active sessions: {activeSessions}

6. **If not running** (connection refused), start the server:

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
bash "$PLUGIN_DIR/hooks/start-server.sh"
```

Then re-check health and show status to confirm it started.

7. If the server still doesn't start after the script runs, tell the user:

> Server failed to start. Check that port ${SKILL_ENGINE_PORT:-19750} is free and Node.js is available.

## After /reload-plugins

After running `/reload-plugins`, the server process from the previous version may still be running. Use `/skill-engine:start` to detect this and restart automatically.
