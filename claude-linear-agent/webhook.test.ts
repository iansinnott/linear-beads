/**
 * Integration tests for the webhook endpoint
 *
 * Tests the full HTTP request/response cycle with mocked external dependencies.
 * IMPORTANT: Mocks the Claude Agent SDK to verify agent invocation behavior.
 *
 * Run with: bun test webhook.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createHmac } from "crypto";

// Get the actual webhook secret from environment (loaded via .env symlink)
const WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET!;
if (!WEBHOOK_SECRET) {
  throw new Error("LINEAR_WEBHOOK_SECRET must be set to run tests");
}

// Track fetch calls
const fetchCalls: Array<{ url: string; options: RequestInit }> = [];
const originalFetch = globalThis.fetch;

// Track agent invocations - CRITICAL for testing infinite loop prevention
// AIDEV-NOTE: This is how we verify agents are NOT called for self-triggers, stop signals, etc.
const agentInvocations: Array<{ prompt: string; options: unknown }> = [];

// Mock the Claude Agent SDK BEFORE importing server
// This intercepts all query() calls and records them without spawning actual agents
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: string; options: unknown }) => {
    agentInvocations.push(args);
    // Return an async iterator that immediately completes with a result
    return (async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "Mocked agent response" }] },
      };
      yield { type: "result", subtype: "success", num_turns: 1 };
    })();
  },
}));

// Mock fetch to intercept Linear API calls
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  fetchCalls.push({ url, options: init || {} });

  // Return success for all Linear API calls
  if (url.includes("api.linear.app")) {
    return new Response(
      JSON.stringify({
        data: {
          commentCreate: { success: true, comment: { id: "comment-123" } },
          agentActivityCreate: { success: true },
        },
      }),
      { status: 200 }
    );
  }

  return originalFetch(input, init);
};

// Import server after mocking
import server from "./server";

// Helper to create signed request
function createSignedRequest(
  body: object,
  secret: string = WEBHOOK_SECRET
): Request {
  const bodyStr = JSON.stringify(body);
  const hmac = createHmac("sha256", secret);
  hmac.update(bodyStr);
  const signature = hmac.digest("hex");

  return new Request("http://localhost/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "linear-signature": signature,
    },
    body: bodyStr,
  });
}

// Helper to create unique session payloads (avoids deduplication between tests)
let sessionCounter = 0;
function createSessionPayload(overrides: Record<string, unknown> = {}) {
  const id = `session-${++sessionCounter}-${Date.now()}`;
  return {
    type: "AgentSessionEvent",
    action: "created",
    createdAt: new Date().toISOString(),
    organizationId: "org-123",
    agentSession: {
      id,
      issueId: "issue-456",
      status: "pending",
      type: "commentThread",
      issue: {
        id: "issue-456",
        identifier: "TEST-1",
        title: "Test Issue",
        description: "This is a test",
      },
      comment: {
        id: "comment-789",
        body: "@claude help me",
      },
      creator: {
        id: "user-123",
        name: "Test User",
        email: "test@example.com",
      },
      ...overrides,
    },
    promptContext: "<issue>test</issue>",
  };
}

describe("Webhook Endpoint", () => {
  beforeEach(() => {
    fetchCalls.length = 0; // Clear fetch calls
    agentInvocations.length = 0; // Clear agent invocations
  });

  test("GET / returns health check", async () => {
    const response = await server.fetch(new Request("http://localhost/"));
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.status).toBe("ok");
    expect(json.agent).toBe("Claude");
  });

  test("POST /webhook rejects missing signature", async () => {
    const response = await server.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body: JSON.stringify(createSessionPayload()),
      })
    );

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error).toBe("Invalid signature");
  });

  test("POST /webhook rejects invalid signature", async () => {
    const response = await server.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "linear-signature": "invalid" },
        body: JSON.stringify(createSessionPayload()),
      })
    );

    expect(response.status).toBe(401);
  });

  test("POST /webhook accepts valid signature", async () => {
    const request = createSignedRequest(createSessionPayload());
    const response = await server.fetch(request);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.received).toBe(true);
  });

  test("POST /webhook returns 400 for missing session", async () => {
    const payload = {
      type: "AgentSessionEvent",
      action: "created",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      // Missing agentSession
    };

    const request = createSignedRequest(payload);
    const response = await server.fetch(request);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("No session data");
  });

  test("POST /webhook ignores non-agent events", async () => {
    const payload = {
      type: "Issue",
      action: "update",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
    };

    const request = createSignedRequest(payload);
    const response = await server.fetch(request);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.received).toBe(true);
  });

  test("POST /webhook emits activity immediately on session created", async () => {
    const request = createSignedRequest(createSessionPayload());
    await server.fetch(request);

    // Give async operations time to start
    await new Promise((r) => setTimeout(r, 100));

    // Check that activity was emitted
    const activityCall = fetchCalls.find(
      (call) =>
        call.url.includes("api.linear.app") &&
        call.options.body?.toString().includes("agentActivityCreate")
    );

    expect(activityCall).toBeDefined();
  });
});

describe("Prompted Events (Multi-turn)", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    agentInvocations.length = 0;
  });

  test("POST /webhook handles prompted events", async () => {
    const payload = {
      type: "AgentSessionEvent",
      action: "prompted",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      agentSession: {
        id: `prompted-session-${Date.now()}`,
        issueId: "issue-456",
        status: "active",
        type: "commentThread",
        issue: {
          id: "issue-456",
          identifier: "TEST-1",
          title: "Test Issue",
          description: "This is a test",
        },
      },
      agentActivity: {
        id: `activity-${Date.now()}`,
        content: {
          type: "prompt",
          body: "Can you also check the other file?",
        },
      },
      promptContext: "<issue>test context</issue>",
    };

    const request = createSignedRequest(payload);
    const response = await server.fetch(request);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.received).toBe(true);
  });

  test("POST /webhook rejects prompted event without user message", async () => {
    const payload = {
      type: "AgentSessionEvent",
      action: "prompted",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      agentSession: {
        id: `prompted-no-msg-${Date.now()}`,
        issueId: "issue-456",
        status: "active",
        type: "commentThread",
        issue: {
          id: "issue-456",
          identifier: "TEST-1",
          title: "Test Issue",
        },
      },
      // Missing agentActivity
    };

    const request = createSignedRequest(payload);
    const response = await server.fetch(request);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("No user message");
  });

  test("POST /webhook deduplicates prompted events by activity ID", async () => {
    const sessionId = `prompted-dedup-${Date.now()}`;
    const activityId = `activity-dedup-${Date.now()}`;
    const payload = {
      type: "AgentSessionEvent",
      action: "prompted",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      agentSession: {
        id: sessionId,
        issueId: "issue-456",
        status: "active",
        type: "commentThread",
        issue: {
          id: "issue-456",
          identifier: "TEST-1",
          title: "Test Issue",
        },
      },
      agentActivity: {
        id: activityId,
        content: {
          type: "prompt",
          body: "Follow-up question",
        },
      },
    };

    // First request should be processed
    const request1 = createSignedRequest(payload);
    const response1 = await server.fetch(request1);
    expect(response1.status).toBe(200);
    const json1 = await response1.json();
    expect(json1.received).toBe(true);
    expect(json1.skipped).toBeUndefined();

    // Second request with same activity ID should be deduplicated
    const request2 = createSignedRequest(payload);
    const response2 = await server.fetch(request2);
    expect(response2.status).toBe(200);
    const json2 = await response2.json();
    expect(json2.skipped).toBe("duplicate");
  });

  test("POST /webhook handles stop signal", async () => {
    const payload = {
      type: "AgentSessionEvent",
      action: "prompted",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      agentSession: {
        id: `stop-session-${Date.now()}`,
        issueId: "issue-456",
        status: "active",
        type: "commentThread",
        issue: {
          id: "issue-456",
          identifier: "TEST-1",
          title: "Test Issue",
        },
      },
      agentActivity: {
        id: `stop-activity-${Date.now()}`,
        signal: "stop",
        content: {
          type: "prompt",
          body: "stop",
        },
      },
    };

    const request = createSignedRequest(payload);
    const response = await server.fetch(request);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.action).toBe("stop-acknowledged");
    // cancelled field indicates whether there was a running agent to cancel
    expect(typeof json.cancelled).toBe("boolean");
  });
});

describe("Self-trigger Prevention", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    agentInvocations.length = 0;
  });

  test("POST /webhook skips self-triggered sessions", async () => {
    // Simulate a session where the agent triggered itself (creatorId === appUserId)
    const agentUserId = "agent-user-abc";
    const payload = {
      type: "AgentSessionEvent",
      action: "created",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      appUserId: agentUserId, // Our agent's ID
      agentSession: {
        id: `self-trigger-${Date.now()}`,
        issueId: "issue-456",
        status: "pending",
        type: "commentThread",
        creatorId: agentUserId, // Same as appUserId = self-trigger
        issue: {
          id: "issue-456",
          identifier: "TEST-1",
          title: "Test Issue",
          description: "This is a test",
        },
        comment: {
          id: "comment-789",
          body: "@claude help me",
        },
      },
      promptContext: "<issue>test</issue>",
    };

    const request = createSignedRequest(payload);
    const response = await server.fetch(request);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.skipped).toBe("self-trigger");
  });
});

describe("Webhook Signature Verification", () => {
  test("rejects tampered body", async () => {
    const payload = createSessionPayload();
    const body = JSON.stringify(payload);
    const hmac = createHmac("sha256", WEBHOOK_SECRET);
    hmac.update(body);
    const signature = hmac.digest("hex");

    // Send different body with original signature
    const tamperedPayload = { ...payload, type: "Hacked" };

    const response = await server.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "linear-signature": signature,
        },
        body: JSON.stringify(tamperedPayload),
      })
    );

    expect(response.status).toBe(401);
  });

  test("rejects wrong secret", async () => {
    const request = createSignedRequest(createSessionPayload(), "wrong-secret");
    const response = await server.fetch(request);

    expect(response.status).toBe(401);
  });
});

// AIDEV-NOTE: These tests verify the Claude Agent SDK is/isn't called
// This is CRITICAL for preventing infinite loops - if agents spawn when they shouldn't,
// we get runaway process creation (see docs/incidents/2026-01-04-prompted-event-loop-rca.md)
describe("Agent Invocation Verification", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    agentInvocations.length = 0;
  });

  test("agent IS called for valid created event", async () => {
    const request = createSignedRequest(createSessionPayload());
    await server.fetch(request);

    // Give async runAgent time to execute
    await new Promise((r) => setTimeout(r, 50));

    expect(agentInvocations.length).toBe(1);
    // Prompt uses promptContext from payload when provided
    expect(agentInvocations[0].prompt).toContain("<issue>test</issue>");
  });

  test("agent IS called for valid prompted event", async () => {
    const payload = {
      type: "AgentSessionEvent",
      action: "prompted",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      agentSession: {
        id: `verify-prompted-${Date.now()}`,
        issueId: "issue-456",
        status: "active",
        type: "commentThread",
        issue: {
          id: "issue-456",
          identifier: "TEST-99",
          title: "Test Issue",
        },
      },
      agentActivity: {
        id: `verify-activity-${Date.now()}`,
        content: {
          type: "prompt",
          body: "Please help with this follow-up",
        },
      },
      promptContext: "<issue>context</issue>",
    };

    const request = createSignedRequest(payload);
    await server.fetch(request);

    await new Promise((r) => setTimeout(r, 50));

    expect(agentInvocations.length).toBe(1);
    expect(agentInvocations[0].prompt).toContain("Please help with this follow-up");
  });

  test("agent is NOT called for self-trigger", async () => {
    const agentUserId = "agent-user-self";
    const payload = {
      type: "AgentSessionEvent",
      action: "created",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      appUserId: agentUserId,
      agentSession: {
        id: `no-agent-self-${Date.now()}`,
        issueId: "issue-456",
        status: "pending",
        type: "commentThread",
        creatorId: agentUserId, // Same as appUserId = self-trigger
        issue: {
          id: "issue-456",
          identifier: "TEST-1",
          title: "Test Issue",
        },
        comment: { id: "c1", body: "@claude help" },
      },
    };

    const request = createSignedRequest(payload);
    const response = await server.fetch(request);
    const json = await response.json();

    await new Promise((r) => setTimeout(r, 50));

    expect(json.skipped).toBe("self-trigger");
    expect(agentInvocations.length).toBe(0); // CRITICAL: No agent spawned
  });

  test("agent is NOT called for stop signal", async () => {
    const payload = {
      type: "AgentSessionEvent",
      action: "prompted",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      agentSession: {
        id: `no-agent-stop-${Date.now()}`,
        issueId: "issue-456",
        status: "active",
        type: "commentThread",
        issue: { id: "issue-456", identifier: "TEST-1", title: "Test" },
      },
      agentActivity: {
        id: `stop-${Date.now()}`,
        signal: "stop",
        content: { type: "prompt", body: "stop" },
      },
    };

    const request = createSignedRequest(payload);
    const response = await server.fetch(request);
    const json = await response.json();

    await new Promise((r) => setTimeout(r, 50));

    expect(json.action).toBe("stop-acknowledged");
    // AIDEV-NOTE: cancelled=false because the mock agent completes synchronously,
    // so there's no running agent by the time we send the stop signal.
    // In production, a slow agent would result in cancelled=true.
    expect(json.cancelled).toBe(false);
    expect(agentInvocations.length).toBe(0); // CRITICAL: No agent spawned
  });

  test("agent is NOT called for duplicate created event", async () => {
    const payload = createSessionPayload();

    // First request - agent should be called
    const request1 = createSignedRequest(payload);
    await server.fetch(request1);
    await new Promise((r) => setTimeout(r, 50));
    expect(agentInvocations.length).toBe(1);

    // Second request with same session - agent should NOT be called again
    const request2 = createSignedRequest(payload);
    const response2 = await server.fetch(request2);
    const json2 = await response2.json();

    await new Promise((r) => setTimeout(r, 50));

    expect(json2.skipped).toBe("duplicate");
    expect(agentInvocations.length).toBe(1); // Still just 1, not 2
  });

  test("agent is NOT called for duplicate prompted event", async () => {
    const sessionId = `no-dup-prompted-${Date.now()}`;
    const activityId = `activity-dup-${Date.now()}`;
    const payload = {
      type: "AgentSessionEvent",
      action: "prompted",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      agentSession: {
        id: sessionId,
        issueId: "issue-456",
        status: "active",
        type: "commentThread",
        issue: { id: "issue-456", identifier: "TEST-1", title: "Test" },
      },
      agentActivity: {
        id: activityId,
        content: { type: "prompt", body: "Hello" },
      },
    };

    // First request - agent should be called
    const request1 = createSignedRequest(payload);
    await server.fetch(request1);
    await new Promise((r) => setTimeout(r, 50));
    expect(agentInvocations.length).toBe(1);

    // Second request with same activity ID - agent should NOT be called
    const request2 = createSignedRequest(payload);
    const response2 = await server.fetch(request2);
    const json2 = await response2.json();

    await new Promise((r) => setTimeout(r, 50));

    expect(json2.skipped).toBe("duplicate");
    expect(agentInvocations.length).toBe(1); // Still just 1
  });
});
