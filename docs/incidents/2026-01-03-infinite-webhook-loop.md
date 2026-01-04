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

---

## Further Investigation (2026-01-03 ~22:00 UTC)

### Webhook Payload Analysis

After rate limit recovered, we captured a real webhook payload to understand what data Linear provides:

**Key finding: Linear provides both creator ID and agent ID in the payload, enabling self-trigger detection:**

```json
{
  "appUserId": "125ac554-2838-4963-acbf-f1c42454fca3",  // Our agent's ID
  "agentSession": {
    "creatorId": "dc7f24a6-f24e-47dc-b865-e1b9e9afd69a",  // Who triggered
    "appUserId": "125ac554-2838-4963-acbf-f1c42454fca3",  // Our agent (redundant)
    "creator": {
      "id": "dc7f24a6-f24e-47dc-b865-e1b9e9afd69a",
      "name": "ian@iansinnott.com",
      "email": "ian@iansinnott.com"
      // Note: NO `app` field in webhook payload
    },
    "comment": {
      "userId": "dc7f24a6-f24e-47dc-b865-e1b9e9afd69a"  // Comment author
    }
  }
}
```

### Self-Trigger Detection

Added `isSelfTrigger()` helper to `lib.ts`:

```typescript
export function isSelfTrigger(payload: LinearWebhookPayload): boolean {
  const session = payload.agentSession;
  if (!session) return false;

  const creatorId = session.creatorId || session.creator?.id;
  const ourAgentId = payload.appUserId || session.appUserId;

  if (!creatorId || !ourAgentId) return false;
  return creatorId === ourAgentId;
}
```

**Usage in webhook handler:**
```typescript
if (isSelfTrigger(payload)) {
  log("warn", "Self-trigger detected", { sessionId: session.id });
  return c.json({ received: true, skipped: "self_trigger" });
}
```

### TypeScript Types Updated

Updated `lib.ts` types to match actual Linear webhook payload structure:

| Field | Type | Purpose |
|-------|------|---------|
| `payload.appUserId` | `string?` | Our agent's user ID |
| `session.creatorId` | `string?` | Who triggered the session |
| `session.appUserId` | `string?` | Our agent (redundant) |
| `comment.userId` | `string?` | Comment author ID |
| `creator.avatarUrl` | `string?` | Profile avatar |
| `issue.team` | `object?` | Full team info |

### Verified API Fields

Queried Linear GraphQL API to confirm agent identity fields:

```typescript
// Query: { viewer { id name app supportsAgentSessions } }
{
  "id": "125ac554-2838-4963-acbf-f1c42454fca3",
  "name": "Claude",
  "app": true,  // Confirms we're an app/bot user
  "supportsAgentSessions": true
}
```

Note: The `app` field is available via API but NOT included in webhook payloads.

---

## Proposed Hard Mitigations

For defense-in-depth, these additional mitigations are recommended:

### 1. Concurrent Instance Limit

Prevent runaway spawning by limiting concurrent agent runs:

```typescript
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_AGENTS || '3');
let activeCount = 0;

// In webhook handler:
if (activeCount >= MAX_CONCURRENT) {
  log("warn", "Max concurrent agents reached", { active: activeCount });
  return c.json({ received: true, skipped: "rate_limited" });
}

activeCount++;
runAgent(session, payload.promptContext)
  .finally(() => activeCount--);
```

### 2. Issue Cooldown

Prevent rapid re-triggers on the same issue:

```typescript
const issueCooldowns = new Map<string, number>();
const COOLDOWN_MS = 30_000; // 30 seconds

const issueId = session.issue?.id;
const lastResponse = issueCooldowns.get(issueId);
if (lastResponse && Date.now() - lastResponse < COOLDOWN_MS) {
  log("warn", "Issue cooldown active", { issueId });
  return c.json({ received: true, skipped: "cooldown" });
}

// After successful response:
issueCooldowns.set(issueId, Date.now());
```

### Defense Layers Summary

| Layer | What it catches | Status |
|-------|-----------------|--------|
| Session deduplication | Same webhook delivered twice | ✅ Implemented |
| @mention sanitization | Agent output containing `@claude` | ✅ Implemented |
| Self-trigger detection | Session created by our own agent | ✅ Implemented (helper added) |
| Concurrent limit | Runaway spawning (max N) | 🔲 Proposed |
| Issue cooldown | Rapid triggers on same issue | 🔲 Proposed |

### Remaining Items

1. [ ] Clean up test issues created by the loop (GENT-729 through GENT-769+)
2. [ ] Add self-trigger check to webhook handler
3. [ ] Implement concurrent limit (optional, for extra safety)
4. [ ] Implement issue cooldown (optional, for extra safety)

## Related Issues

- `LOCAL-001`: Fix infinite webhook spawn loop in claude-linear-agent

## Appendix

### Real Webhook Payload (captured 2026-01-03 22:00 UTC)

```json
{
  "type": "AgentSessionEvent",
  "action": "created",
  "createdAt": "2026-01-03T22:00:25.752Z",
  "organizationId": "77df41e4-76cd-4310-9d25-b59481c02a74",
  "oauthClientId": "4d60803071bd7b18e5663f2832fcfd6e",
  "appUserId": "125ac554-2838-4963-acbf-f1c42454fca3",
  "agentSession": {
    "id": "c710e27a-7833-40d9-8cad-62f58cb35bf2",
    "createdAt": "2026-01-03T22:00:25.181Z",
    "updatedAt": "2026-01-03T22:00:25.181Z",
    "archivedAt": null,
    "creatorId": "dc7f24a6-f24e-47dc-b865-e1b9e9afd69a",
    "appUserId": "125ac554-2838-4963-acbf-f1c42454fca3",
    "commentId": "566f68c1-1d17-46ec-9bde-b8eeeb22af55",
    "sourceCommentId": null,
    "issueId": "28b8ecd1-008e-4aa3-8f5c-6cc6f4de3a18",
    "status": "pending",
    "type": "commentThread",
    "externalUrls": [],
    "sourceMetadata": {
      "type": "comment",
      "agentSessionMetadata": {
        "sourceCommentId": "566f68c1-1d17-46ec-9bde-b8eeeb22af55"
      }
    },
    "creator": {
      "id": "dc7f24a6-f24e-47dc-b865-e1b9e9afd69a",
      "name": "ian@iansinnott.com",
      "email": "ian@iansinnott.com",
      "avatarUrl": "https://public.linear.app/...",
      "url": "https://linear.app/iansinnott/profiles/ian"
    },
    "comment": {
      "id": "566f68c1-1d17-46ec-9bde-b8eeeb22af55",
      "body": "@claude ping. no detailed response needed, maybe just a pong",
      "userId": "dc7f24a6-f24e-47dc-b865-e1b9e9afd69a",
      "issueId": "28b8ecd1-008e-4aa3-8f5c-6cc6f4de3a18"
    },
    "issue": {
      "id": "28b8ecd1-008e-4aa3-8f5c-6cc6f4de3a18",
      "title": "a test issue",
      "teamId": "84b3f91a-133a-4b09-872d-8c0d430713a1",
      "team": {
        "id": "84b3f91a-133a-4b09-872d-8c0d430713a1",
        "key": "GENT",
        "name": "GENT"
      },
      "identifier": "GENT-774",
      "url": "https://linear.app/iansinnott/issue/GENT-774/a-test-issue",
      "description": "generally ignore this issue for any purpose other than responding..."
    }
  },
  "previousComments": [
    {
      "id": "566f68c1-1d17-46ec-9bde-b8eeeb22af55",
      "body": "@claude ping. no detailed response needed, maybe just a pong",
      "userId": "dc7f24a6-f24e-47dc-b865-e1b9e9afd69a",
      "issueId": "28b8ecd1-008e-4aa3-8f5c-6cc6f4de3a18"
    }
  ],
  "guidance": null,
  "promptContext": "<issue identifier=\"GENT-774\">...",
  "webhookTimestamp": 1767477625781,
  "webhookId": "7ed324e1-06db-4432-9417-4de1dccb3603"
}
```

### Key Fields for Self-Trigger Detection

- `payload.appUserId` = our agent's ID (`125ac554-...`)
- `session.creatorId` = who triggered (`dc7f24a6-...`)
- If `creatorId === appUserId`, it's a self-trigger

---

## Second Occurrence: Prompted Event Loop (2026-01-04)

### Symptoms

- User sent follow-up message in existing thread (prompted event)
- System became unresponsive: "dropping frames, fans go crazy"
- Activity Monitor showed "tons of bun rows" (many bun processes)
- Required killing all terminals to stop

### Technical Details

A bug in `getPromptedMessage()` looked for message in wrong location:
```typescript
// BUG: looked here
payload.agentActivity?.body  // undefined

// CORRECT: should look here
payload.agentActivity?.content?.body  // "thanks!"
```

This caused all prompted events to return 400 "No user message".

### Mystery: Why Did 400 Cause Many Bun Processes?

The 400 response was returned **before** calling `runAgent()`, so no Claude Agent SDK processes should have been spawned.

**Possible explanations (unconfirmed):**
1. **Linear webhook retries** - Rapid retries on 4xx errors flooding the server
2. **Multiple server instances** - Port conflict causing crash-restart loops
3. **Unrelated concurrent activity** - Previous agent run still executing

### Fix Applied

```typescript
// lib.ts - AgentActivityData type now enforces correct structure
export interface AgentActivityContent {
  type: "prompt" | "thought" | "action" | "response" | "error" | "elicitation";
  body?: string;
}

export interface AgentActivityData {
  id: string;
  signal?: "stop" | null;
  content: AgentActivityContent;  // Required, not optional
}
```

TypeScript will now catch if someone tries to access `agentActivity.body` directly.

### Lesson Learned

When adding new webhook event types, always:
1. Capture a real payload first (`/tmp/linear-webhook-*.json`)
2. Update types to match actual structure
3. Run `tsc` to verify type safety
