# Incident: Infinite Webhook Loop (2026-01-03)

## Summary

The `claude-linear-agent` webhook server spawned 15+ Claude Code sessions in rapid succession (~7 seconds), exhausting Linear's API rate limit (5000 requests/hour).

## Symptoms

1. Many Claude Code sessions visible in `/resume` command, all with identical prompts:
   ```
   You are Claude, an AI assistant helping with Linear issues. You have access to a codebase. <issue>test</iss...
   ```
2. Sessions created within seconds of each other (39-46 seconds ago at time of observation)
3. Linear API rate limit exhausted (0/5000 requests remaining)
4. System grinding to a halt due to multiple Claude processes

## Timeline

- **~13:12 UTC** - Webhook server received AgentSessionEvent for test issue
- **~13:12-13:13 UTC** - Multiple Claude Code sessions spawned rapidly
- **~13:20 UTC** - Rate limit hit, API calls failing
- **~13:25 UTC** - User killed processes via Activity Monitor

## Technical Context

### Webhook Server Architecture (`claude-linear-agent/server.ts`)

```
Linear webhook (AgentSessionEvent/created)
    ↓
server.ts receives POST /webhook
    ↓
Validates signature, parses payload
    ↓
Spawns Claude Agent SDK query() [async, non-blocking]
    ↓
Returns 200 immediately to Linear
    ↓
Agent runs, calls emitActivity() multiple times
    ↓
Agent completes, calls postComment() with response
```

### Key Code Points

1. **Webhook handler** (server.ts:180-218) - Responds within 5s requirement
2. **runAgent()** (server.ts:97-174) - Spawns Claude Code via Agent SDK
3. **emitActivity()** (server.ts:59-94) - Sends progress to Linear
4. **postComment()** (server.ts:30-56) - Posts final response to issue

## Root Cause Analysis

### Confirmed Contributing Factors

1. **No idempotency** - Server processes every webhook without checking if session ID was already handled
2. **No rate limiting** - Nothing prevents rapid-fire processing
3. **Concurrent with integration tests** - `lb` integration tests were also running, creating `[test-*]` issues

### Hypotheses Under Investigation

| Hypothesis | Status | Probability |
|------------|--------|-------------|
| Linear sent duplicate webhooks | Unconfirmed | Low-Medium |
| **Agent self-triggered via @mention in response** | **Investigated** | **Medium-High** |
| Webhook retry storm (ngrok/tunnel) | Unconfirmed | Medium |
| Test automation triggered multiple mentions | Unconfirmed | Low |

---

## Investigation: Self-Triggering Loop Hypothesis

### Question

Can the agent trigger itself by including `@Claude` in its response, causing:
```
Linear -> webhook -> server -> Claude responds with @Claude -> Linear creates new session -> webhook -> ...
```

### Analysis

#### Code Path for Self-Triggering

**1. Prompt includes original @mention (lib.ts:91)**
```typescript
${session.comment?.body ? `Comment: ${session.comment.body}` : ""}
```

If triggered by `@claude help me`, the prompt contains:
```
Comment: @claude help me
```

**2. Claude generates response**

The prompt tells Claude "You are Claude, an AI assistant..." so Claude might:
- Echo the original comment
- Refer to itself as "Claude" or "@Claude"
- Quote conversation history

**3. Response posted as comment (server.ts:161)**
```typescript
await postComment(issue.id, responseText);
```

**4. Potential trigger**

If `responseText` contains `@claude` (even quoted), Linear might interpret this as a NEW mention and create a new `AgentSession`.

#### Additional Finding: Double Comment Creation

The code does BOTH:
```typescript
await emitActivity(session.id, { type: "response", body: responseText });  // Linear auto-creates comment
await postComment(issue.id, responseText);  // We ALSO create comment manually
```

Per Linear docs: "We will automatically create a comment under the comment thread as well" when emitting a `response` activity. So we're creating **two comments** per response.

#### Linear's Potential Protections

Linear documentation states:
> `AgentSessionEvent` webhooks only send events to your specific agent.

This could mean Linear tracks which comments came from which agent and doesn't trigger webhooks for self-mentions. However, this is **not explicitly documented**.

#### Assessment

| Factor | Evidence |
|--------|----------|
| Code path exists | ✅ Yes - prompt includes @mention, response posted as comment |
| No sanitization | ✅ Yes - responseText posted verbatim |
| Claude might echo @mention | ✅ Likely - prompt contains "Comment: @claude..." |
| Linear has protections | ❓ Unknown - not documented |

### Verdict: **MEDIUM-HIGH PROBABILITY**

The self-triggering loop is a plausible root cause:

1. **The code path exists** - `@claude` in prompt → Claude response → `postComment()` → new mention
2. **No defensive measures** - Response text is not sanitized for @mentions
3. **Claude naturally echoes** - When given context like "Comment: @claude help me", Claude often references or quotes this

**However**, Linear *might* have server-side protections against agents triggering themselves. This is common in mention systems but isn't documented.

### Recommended Fix (Regardless of Root Cause)

**Sanitize @mentions in agent responses:**
```typescript
// Before posting comment
const sanitizedResponse = responseText.replace(/@claude/gi, 'Claude');
await postComment(issue.id, sanitizedResponse);
```

**Or use emitActivity() only (remove manual postComment):**
Since Linear auto-creates comments from `response` activities, we may not need `postComment()` at all.

---

## Fixes Implemented

### Immediate Fixes (Completed 2026-01-03)

All fixes in `claude-linear-agent/server.ts`:

#### 1. Session ID Deduplication

Prevents processing the same webhook twice:

```typescript
const processedSessions = new Map<string, number>();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SESSIONS = 1000;

function isSessionProcessed(sessionId: string): boolean {
  const timestamp = processedSessions.get(sessionId);
  if (timestamp && Date.now() - timestamp < SESSION_TTL_MS) {
    return true;
  }
  return false;
}

// In webhook handler:
if (isSessionProcessed(session.id)) {
  log("warn", "Duplicate session detected, skipping", { sessionId: session.id });
  return c.json({ received: true, skipped: "duplicate" });
}
markSessionProcessed(session.id);
```

#### 2. @Mention Sanitization

Strips @mentions from responses to prevent self-triggering:

```typescript
function sanitizeMentions(text: string): string {
  return text.replace(/@claude/gi, "Claude").replace(/@(\w+)/g, "$1");
}

// Applied to all response text before emitting:
const sanitized = sanitizeMentions(responseText.slice(0, 2000));
await emitActivity(session.id, { type: "response", body: sanitized });
```

#### 3. Removed Redundant postComment()

Linear auto-creates comments from `response` activities, so manual `postComment()` was removed:

```typescript
// BEFORE (dangerous - created 2 comments, doubled self-trigger risk):
await emitActivity(session.id, { type: "response", body: responseText });
await postComment(issue.id, responseText);  // REMOVED

// AFTER (safe - single comment via activity system):
await emitActivity(session.id, { type: "response", body: sanitized });
```

#### 4. Structured JSON Logging

All logs now use structured JSON format for easier debugging:

```typescript
function log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
  const entry = { timestamp: new Date().toISOString(), level, message, ...data };
  console.log(JSON.stringify(entry));
}

// Example output:
// {"timestamp":"2026-01-03T21:41:26.528Z","level":"info","message":"Webhook received","sessionId":"..."}
```

### Remaining Items

1. [ ] Clean up test issues created by the loop (GENT-729 through GENT-769+)
2. [ ] Add circuit breaker pattern (if needed after testing)
3. [ ] Confirm Linear behavior re: agent self-mentions

## Related Issues

- `LOCAL-001`: Fix infinite webhook spawn loop in claude-linear-agent

## Appendix

### Saved Webhook Payload (`/tmp/linear-webhook-payload.json`)

```json
{
  "type": "AgentSessionEvent",
  "action": "created",
  "createdAt": "2026-01-03T21:12:08.922Z",
  "organizationId": "org-123",
  "agentSession": {
    "id": "session-123",
    "issueId": "issue-456",
    "status": "pending",
    "type": "commentThread",
    "issue": {
      "id": "issue-456",
      "identifier": "TEST-1",
      "title": "Test Issue",
      "description": "This is a test"
    },
    "comment": {
      "id": "comment-789",
      "body": "@claude help me"
    }
  },
  "promptContext": "<issue>test</issue>"
}
```
