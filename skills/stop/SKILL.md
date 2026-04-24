---
name: stop
description: Pause the skill-engine HTTP server. Hooks will silently no-op until it is resumed.
---

# Skill Engine — Stop (Pause)

Pause the rule enforcement server. After pausing, all HTTP hooks return empty responses — Claude Code is unaffected.

## Steps

1. Check if the server is running:

```bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
```

2. **If not running** (connection refused), tell the user:

> Skill Engine server is not running. Nothing to pause.

3. **If running**, pause it:

```bash
curl -s -X POST http://localhost:${SKILL_ENGINE_PORT:-19750}/pause
```

4. Verify with health check:

```bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
```

Confirm the `paused` field is `true`. Tell the user:

> Skill Engine paused. Hooks will silently no-op until resumed with `/skill-engine:start`.
