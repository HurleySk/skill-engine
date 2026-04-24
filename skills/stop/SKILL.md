---
name: stop
description: Stop the skill-engine HTTP server. Hooks will silently no-op until it is restarted.
---

# Skill Engine — Stop

Stop the rule enforcement server. After stopping, HTTP hooks will silently no-op — Claude Code is unaffected.

## Steps

1. Check if the server is running:

```bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
```

2. **If not running**, tell the user:

> Skill Engine server is not running. Nothing to stop.

3. **If running**, find and kill the process:

On macOS/Linux:
```bash
kill $(lsof -ti:${SKILL_ENGINE_PORT:-19750}) 2>/dev/null
```

On Windows (Git Bash):
```bash
netstat -ano | grep ":${SKILL_ENGINE_PORT:-19750} " | head -1 | awk '{print $5}' | xargs -r taskkill //F //PID
```

4. Verify it stopped:

```bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
```

If the health check fails (connection refused), confirm: "Skill Engine server stopped."
