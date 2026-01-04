# Root Cause Analysis: Prompted Event Loop (2026-01-04)

## Incident Summary

When testing multi-turn conversations, sending a follow-up message caused the system to become unresponsive with "many bun processes" visible in Activity Monitor.

## Timeline

```
T0: User sends @claude mention (created event)
    → Agent runs successfully, responds with emoji
    → Single-turn test PASSES

T1: User sends follow-up message (prompted event)
    → Server returns 400 "No user message" (BUG: wrong path in getPromptedMessage)
    → Linear UI spins indefinitely

T2: System overload
    → Dropping frames, fans spinning
    → Activity Monitor shows many bun processes
    → User kills all terminals to stop
```

## The Bug

```typescript
// BUG in lib.ts
export function getPromptedMessage(payload: LinearWebhookPayload): string | null {
  return payload.agentActivity?.body || null;  // WRONG - body doesn't exist here
}

// CORRECT
export function getPromptedMessage(payload: LinearWebhookPayload): string | null {
  return payload.agentActivity?.content?.body || null;  // content.body is correct
}
```

## Code Path Analysis

For the failing prompted event:

```typescript
// server.ts webhook handler
if (isAgentSessionPrompted(payload)) {
  const session = payload.agentSession;      // ✓ exists

  if (isStopSignal(payload)) { ... }         // ✗ not a stop signal, skipped

  const userMessage = getPromptedMessage(payload);  // ← RETURNS NULL
  if (!userMessage) {
    log("error", "No user message...");
    return c.json({ error: "No user message" }, 400);  // ← RETURNED HERE
  }

  // NEVER REACHED - runAgent() was NOT called
  runAgent(session, payload.promptContext, userMessage);
}
```

**Key finding:** We returned 400 **before** calling `runAgent()`. The Claude Agent SDK was NOT invoked for the prompted event.

## Root Cause Hypotheses

### Hypothesis 1: Linear Webhook Retries (UNLIKELY)

Linear retries failed webhooks, but with exponential backoff: 1 minute, 1 hour, 6 hours.

**Verdict:** This would not cause immediate rapid-fire requests.

### Hypothesis 2: Initial Agent Still Running (LIKELY)

The first request (created event at T0) successfully called `runAgent()`:

```typescript
// This Promise is NOT awaited - runs in background
runAgent(session, payload.promptContext).catch((error) => {
  log("error", "Unhandled error in runAgent", ...);
});

return c.json({ received: true });  // Return immediately
```

The Claude Agent SDK's `query()` function spawns Claude Code as a subprocess. If this agent was:
1. Still running when prompted event arrived
2. Executing Bash commands that spawned child processes
3. Or had some SDK behavior that forked processes

This could explain "many bun processes" even though the prompted event returned 400 early.

**Verdict:** MOST LIKELY explanation for the bun processes.

### Hypothesis 3: Multiple Server Instances (POSSIBLE)

If multiple terminals were running `bun --watch run server.ts`:
- Port 3000 conflict
- Crash-restart loops
- Each restart spawns new process

**Verdict:** Possible if user had multiple terminals, but doesn't explain the correlation with the prompted event.

### Hypothesis 4: Hot Reload Loop (UNLIKELY)

The `--watch` flag triggers reloads on file changes. We write debug payloads to `/tmp/`:

```typescript
if (process.env.NODE_ENV !== "production") {
  fs.writeFileSync("/tmp/linear-webhook-payload.json", JSON.stringify(payload, null, 2));
}
```

But `/tmp/` is not in the watched directory, so this shouldn't trigger reloads.

**Verdict:** Unlikely to be the cause.

### Hypothesis 5: SDK Internal Behavior (UNKNOWN)

The `@anthropic-ai/claude-agent-sdk` might have internal behavior we're not aware of:
- Process pooling
- Parallel execution
- Resource management issues

**Verdict:** Would need to inspect SDK source or logs to confirm.

## Most Likely Root Cause

**The initial agent run (from T0) was still executing and spawning processes when the prompted event arrived (T1).**

Evidence:
1. The 400 response at T1 did NOT trigger any new agent
2. But "many bun processes" appeared after T1
3. The only agent invocation was at T0 (created event)
4. That agent was running async with `runAgent().catch()` (not awaited)

The correlation with the prompted event may be coincidental timing - the T0 agent may have been mid-execution when T1 occurred, and whatever it was doing (Bash commands? SDK internals?) caused the resource explosion.

## What We Don't Know

1. **What was the T0 agent doing?** We don't have logs showing what tools it used or commands it ran
2. **How many processes exactly?** "Tons of bun rows" is qualitative
3. **Process parent-child relationships** - Were they Claude Code subprocesses? Server restarts? Something else?
4. **SDK internal behavior** - Does `query()` spawn multiple processes? Does it have cleanup issues?

## Preventive Measures Implemented

### 1. Type Safety (Immediate)

```typescript
// lib.ts - content is now required
export interface AgentActivityData {
  content: AgentActivityContent;  // Required, not optional
}
```

TypeScript now catches wrong path access at compile time.

### 2. Stop Signal Handling (Partial)

```typescript
if (isStopSignal(payload)) {
  return c.json({ received: true, action: "stop-acknowledged" });
}
```

Stop signals are acknowledged, though agent cancellation is not yet implemented.

## Recommended Follow-ups

### High Priority

1. **Add agent process tracking** - Track running agents by session ID, implement cancellation on stop signal (GENT-XXX created)

2. **Add concurrent agent limit** - Prevent runaway spawning:
   ```typescript
   const MAX_CONCURRENT = 3;
   if (activeAgents.size >= MAX_CONCURRENT) {
     return c.json({ received: true, skipped: "rate_limited" });
   }
   ```

3. **Improve logging** - Log which tools/commands the agent executes to understand resource usage

### Medium Priority

4. **Investigate Claude Agent SDK** - Understand process model, cleanup behavior

5. **Add health monitoring** - Track bun process count, memory usage

## Conclusion

**Root cause:** Most likely the initial agent (from created event) was still running and consuming resources when the prompted event arrived. The 400 error for the prompted event was a symptom of a bug, but the resource exhaustion was probably caused by the async agent from the earlier successful request.

**Key lesson:** When running agents asynchronously, we need visibility into what they're doing and the ability to cancel them.

## Sources

- [Linear Webhooks Documentation](https://linear.app/developers/webhooks) - Retry policy: 3 attempts with backoff
- [Linear API Docs](https://linear.app/docs/api-and-webhooks) - General webhook behavior
