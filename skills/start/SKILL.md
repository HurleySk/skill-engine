---
name: start
description: Start or resume the skill-engine HTTP server. Shows server status.
---

# Skill Engine — Start

Start or resume the rule enforcement server.

## Steps

1. Check if the server is running:

```bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
```

2. **If running and paused** (`paused: true` in health response), resume it:

```bash
curl -s -X POST http://localhost:${SKILL_ENGINE_PORT:-19750}/resume
```

Re-check health and show status. Tell the user: "Skill Engine resumed."

3. **If running and not paused**, show the user the status:

> Skill Engine server is already running.
> - Port: {port}
> - Uptime: {uptime}s
> - Rules loaded: {rulesLoaded}
> - Events processed: {eventsProcessed}
> - Active sessions: {activeSessions}

4. **If not running** (connection refused), start the server:

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
bash "$PLUGIN_DIR/hooks/start-server.sh"
```

Then re-check health and show status to confirm it started.

5. If the server still doesn't start after the script runs, tell the user:

> Server failed to start. Check that port ${SKILL_ENGINE_PORT:-19750} is free and Node.js is available.
