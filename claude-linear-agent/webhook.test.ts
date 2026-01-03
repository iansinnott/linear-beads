/**
 * Integration tests for the webhook endpoint
 *
 * Tests the full HTTP request/response cycle with mocked external dependencies.
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

describe("Self-trigger Prevention", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
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
