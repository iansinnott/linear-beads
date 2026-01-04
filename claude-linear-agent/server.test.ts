/**
 * Tests for the Linear webhook agent server
 *
 * Run with: bun test server.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createHmac } from "crypto";
import {
  verifySignature,
  buildPrompt,
  parseWebhookPayload,
  isAgentSessionCreated,
  isAgentSessionPrompted,
  getPromptedMessage,
  isStopSignal,
  isSelfTrigger,
  createCommentMutation,
  createActivityMutation,
  type LinearWebhookPayload,
  type AgentSessionData,
} from "./lib";

// Sample payload from actual Linear webhook (sanitized)
const SAMPLE_PAYLOAD: LinearWebhookPayload = {
  type: "AgentSessionEvent",
  action: "created",
  createdAt: "2026-01-03T20:46:17.935Z",
  organizationId: "77df41e4-76cd-4310-9d25-b59481c02a74",
  agentSession: {
    id: "1814a779-582a-4ef2-b506-dc220aff09a8",
    issueId: "f2c74f13-f98b-4298-84b3-62b1ad2cc08c",
    status: "pending",
    type: "commentThread",
    issue: {
      id: "f2c74f13-f98b-4298-84b3-62b1ad2cc08c",
      identifier: "GENT-45",
      title: "a quick test issue",
      description: "a secret number for claude: 42",
      url: "https://linear.app/iansinnott/issue/GENT-45/a-quick-test-issue",
    },
    comment: {
      id: "f064585f-447c-40cd-8ccc-75d97e63e193",
      body: "@claude can you help me with this?",
    },
    creator: {
      id: "dc7f24a6-f24e-47dc-b865-e1b9e9afd69a",
      name: "Test User",
      email: "test@example.com",
    },
  },
  promptContext:
    '<issue identifier="GENT-45"><title>a quick test issue</title></issue>',
};

const TEST_SECRET = "test-webhook-secret-12345";

describe("verifySignature", () => {
  test("returns true for valid signature", () => {
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const hmac = createHmac("sha256", TEST_SECRET);
    hmac.update(body);
    const signature = hmac.digest("hex");

    expect(verifySignature(body, signature, TEST_SECRET)).toBe(true);
  });

  test("returns false for invalid signature", () => {
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    expect(verifySignature(body, "invalid-signature", TEST_SECRET)).toBe(false);
  });

  test("returns false for null signature", () => {
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    expect(verifySignature(body, null, TEST_SECRET)).toBe(false);
  });

  test("returns false for undefined signature", () => {
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    expect(verifySignature(body, undefined, TEST_SECRET)).toBe(false);
  });

  test("returns false for empty signature", () => {
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    expect(verifySignature(body, "", TEST_SECRET)).toBe(false);
  });

  test("returns false when body is tampered", () => {
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const hmac = createHmac("sha256", TEST_SECRET);
    hmac.update(body);
    const signature = hmac.digest("hex");

    const tamperedBody = JSON.stringify({ ...SAMPLE_PAYLOAD, action: "hacked" });
    expect(verifySignature(tamperedBody, signature, TEST_SECRET)).toBe(false);
  });
});

describe("parseWebhookPayload", () => {
  test("parses valid JSON payload", () => {
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const parsed = parseWebhookPayload(body);

    expect(parsed.type).toBe("AgentSessionEvent");
    expect(parsed.action).toBe("created");
    expect(parsed.agentSession?.issue?.identifier).toBe("GENT-45");
  });

  test("throws on invalid JSON", () => {
    expect(() => parseWebhookPayload("not valid json")).toThrow();
  });
});

describe("isAgentSessionCreated", () => {
  test("returns true for created event", () => {
    expect(isAgentSessionCreated(SAMPLE_PAYLOAD)).toBe(true);
  });

  test("returns false for prompted event", () => {
    const promptedPayload = { ...SAMPLE_PAYLOAD, action: "prompted" };
    expect(isAgentSessionCreated(promptedPayload)).toBe(false);
  });

  test("returns false for other event types", () => {
    const otherPayload = { ...SAMPLE_PAYLOAD, type: "Issue" };
    expect(isAgentSessionCreated(otherPayload)).toBe(false);
  });
});

describe("buildPrompt", () => {
  const session: AgentSessionData = SAMPLE_PAYLOAD.agentSession!;

  test("uses promptContext when provided", () => {
    const prompt = buildPrompt(session, "<custom context>", "/repo");
    expect(prompt).toContain("<custom context>");
    expect(prompt).toContain("/repo");
  });

  test("builds context from session when no promptContext", () => {
    const prompt = buildPrompt(session, undefined, "/repo");
    expect(prompt).toContain("GENT-45");
    expect(prompt).toContain("a quick test issue");
    expect(prompt).toContain("a secret number for claude: 42");
  });

  test("includes comment body when present", () => {
    const prompt = buildPrompt(session, undefined, "/repo");
    expect(prompt).toContain("@claude can you help me with this?");
  });

  test("throws when no issue in session", () => {
    const noIssueSession = { ...session, issue: undefined };
    expect(() => buildPrompt(noIssueSession, undefined, "/repo")).toThrow(
      "No issue data in session"
    );
  });
});

describe("createCommentMutation", () => {
  test("creates valid mutation structure", () => {
    const mutation = createCommentMutation("issue-123", "Hello world");

    expect(mutation.query).toContain("commentCreate");
    expect(mutation.variables.issueId).toBe("issue-123");
    expect(mutation.variables.body).toBe("Hello world");
  });
});

describe("isAgentSessionPrompted", () => {
  test("returns true for prompted event", () => {
    const payload: LinearWebhookPayload = {
      type: "AgentSessionEvent",
      action: "prompted",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
    };
    expect(isAgentSessionPrompted(payload)).toBe(true);
  });

  test("returns false for created event", () => {
    expect(isAgentSessionPrompted(SAMPLE_PAYLOAD)).toBe(false);
  });

  test("returns false for other event types", () => {
    const payload: LinearWebhookPayload = {
      type: "Issue",
      action: "prompted",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
    };
    expect(isAgentSessionPrompted(payload)).toBe(false);
  });
});

describe("getPromptedMessage", () => {
  test("returns message from agentActivity.content.body", () => {
    const payload: LinearWebhookPayload = {
      type: "AgentSessionEvent",
      action: "prompted",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      agentActivity: {
        id: "activity-123",
        content: {
          type: "prompt",
          body: "Can you check the other file?",
        },
      },
    };
    expect(getPromptedMessage(payload)).toBe("Can you check the other file?");
  });

  test("returns null when no agentActivity", () => {
    const payload: LinearWebhookPayload = {
      type: "AgentSessionEvent",
      action: "prompted",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
    };
    expect(getPromptedMessage(payload)).toBeNull();
  });

  test("returns null when agentActivity has no content", () => {
    const payload: LinearWebhookPayload = {
      type: "AgentSessionEvent",
      action: "prompted",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      agentActivity: {
        id: "activity-123",
      },
    };
    expect(getPromptedMessage(payload)).toBeNull();
  });
});

describe("isStopSignal", () => {
  test("returns true when signal is stop", () => {
    const payload: LinearWebhookPayload = {
      type: "AgentSessionEvent",
      action: "prompted",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      agentActivity: {
        id: "activity-123",
        signal: "stop",
        content: { type: "prompt", body: "stop" },
      },
    };
    expect(isStopSignal(payload)).toBe(true);
  });

  test("returns false when no signal", () => {
    const payload: LinearWebhookPayload = {
      type: "AgentSessionEvent",
      action: "prompted",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      agentActivity: {
        id: "activity-123",
        content: { type: "prompt", body: "hello" },
      },
    };
    expect(isStopSignal(payload)).toBe(false);
  });

  test("returns false when no agentActivity", () => {
    const payload: LinearWebhookPayload = {
      type: "AgentSessionEvent",
      action: "prompted",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
    };
    expect(isStopSignal(payload)).toBe(false);
  });
});

describe("isSelfTrigger", () => {
  test("returns true when creatorId matches appUserId", () => {
    const payload: LinearWebhookPayload = {
      type: "AgentSessionEvent",
      action: "created",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      appUserId: "agent-user-123",
      agentSession: {
        id: "session-1",
        issueId: "issue-1",
        status: "pending",
        type: "commentThread",
        creatorId: "agent-user-123", // Same as appUserId
      },
    };
    expect(isSelfTrigger(payload)).toBe(true);
  });

  test("returns true when creator.id matches appUserId", () => {
    const payload: LinearWebhookPayload = {
      type: "AgentSessionEvent",
      action: "created",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      appUserId: "agent-user-123",
      agentSession: {
        id: "session-1",
        issueId: "issue-1",
        status: "pending",
        type: "commentThread",
        creator: {
          id: "agent-user-123", // Same as appUserId
          name: "Claude Agent",
          email: "agent@example.com",
        },
      },
    };
    expect(isSelfTrigger(payload)).toBe(true);
  });

  test("returns false when creator differs from appUserId", () => {
    const payload: LinearWebhookPayload = {
      type: "AgentSessionEvent",
      action: "created",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      appUserId: "agent-user-123",
      agentSession: {
        id: "session-1",
        issueId: "issue-1",
        status: "pending",
        type: "commentThread",
        creatorId: "human-user-456", // Different from appUserId
      },
    };
    expect(isSelfTrigger(payload)).toBe(false);
  });

  test("returns false when no agentSession", () => {
    const payload: LinearWebhookPayload = {
      type: "Issue",
      action: "update",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
    };
    expect(isSelfTrigger(payload)).toBe(false);
  });

  test("returns false when appUserId missing", () => {
    const payload: LinearWebhookPayload = {
      type: "AgentSessionEvent",
      action: "created",
      createdAt: new Date().toISOString(),
      organizationId: "org-123",
      agentSession: {
        id: "session-1",
        issueId: "issue-1",
        status: "pending",
        type: "commentThread",
        creatorId: "human-user-456",
      },
    };
    expect(isSelfTrigger(payload)).toBe(false);
  });
});

describe("createActivityMutation", () => {
  test("creates thought activity", () => {
    const mutation = createActivityMutation(
      "session-123",
      { type: "thought", body: "Thinking..." },
      true
    );

    expect(mutation.query).toContain("agentActivityCreate");
    expect(mutation.variables.input.agentSessionId).toBe("session-123");
    expect(mutation.variables.input.content.type).toBe("thought");
    expect(mutation.variables.input.ephemeral).toBe(true);
  });

  test("creates action activity", () => {
    const mutation = createActivityMutation("session-123", {
      type: "action",
      action: "Read",
      parameter: "file.ts",
    });

    expect(mutation.variables.input.content.action).toBe("Read");
    expect(mutation.variables.input.content.parameter).toBe("file.ts");
    expect(mutation.variables.input.ephemeral).toBe(false);
  });

  test("creates response activity", () => {
    const mutation = createActivityMutation("session-123", {
      type: "response",
      body: "Here's my answer",
    });

    expect(mutation.variables.input.content.type).toBe("response");
    expect(mutation.variables.input.content.body).toBe("Here's my answer");
  });
});

describe("Payload Structure", () => {
  test("sample payload has expected structure", () => {
    expect(SAMPLE_PAYLOAD.agentSession).toBeDefined();
    expect(SAMPLE_PAYLOAD.agentSession?.id).toBeDefined();
    expect(SAMPLE_PAYLOAD.agentSession?.issue?.id).toBeDefined();
    expect(SAMPLE_PAYLOAD.agentSession?.issue?.identifier).toBeDefined();
    expect(SAMPLE_PAYLOAD.agentSession?.comment?.body).toBeDefined();
    expect(SAMPLE_PAYLOAD.promptContext).toBeDefined();
  });

  test("session has creator info", () => {
    const creator = SAMPLE_PAYLOAD.agentSession?.creator;
    expect(creator?.id).toBeDefined();
    expect(creator?.name).toBeDefined();
    expect(creator?.email).toBeDefined();
  });
});
