---
name: status
description: Show skill-engine server diagnostics — port, uptime, rules loaded, events processed, active sessions, paused state.
---

# Skill Engine — Status

Show the current state of the rule enforcement server.

## Steps

1. Check server health:

```bash
curl -s --max-time 2 http://localhost:${SKILL_ENGINE_PORT:-19750}/health
```

2. **If running**, display:

> **Skill Engine Server**
> - Status: Running (or "Paused" if `paused: true`)
> - Port: {port}
> - Uptime: {uptime}s
> - Rules loaded: {rulesLoaded}
> - Events processed: {eventsProcessed}
> - Last event: {lastEvent}
> - Active sessions: {activeSessions}
> - Tool trigger rules: {hasToolTriggerRules}
> - Output trigger rules: {hasOutputTriggerRules}
> - Stop rules: {hasStopRules}

3. **If not running**, display:

> **Skill Engine Server**
> - Status: Not running
> - HTTP hooks are silently no-op until the server is started.
> - Run `/skill-engine:start` to start.
