---
name: start
description: Start the skill-engine HTTP server or confirm it is already running. Shows server status.
---

# Skill Engine — Start

Start the rule enforcement server or check if it's already running.

## Steps

1. Check if the server is running:

```bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
```

2. **If the health check succeeds**, show the user the status:

> Skill Engine server is already running.
> - Port: {port}
> - Uptime: {uptime}s
> - Rules loaded: {rulesLoaded}
> - Events processed: {eventsProcessed}
> - Active sessions: {activeSessions}

3. **If the health check fails** (connection refused), start the server:

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/hurleysk-marketplace/skill-engine/*/ 2>/dev/null | sort -V | tail -1)
bash "$PLUGIN_DIR/hooks/start-server.sh"
```

Then re-check health and show status to confirm it started.

4. If the server still doesn't start after the script runs, tell the user:

> Server failed to start. Check that port ${SKILL_ENGINE_PORT:-19750} is free and Node.js is available.
