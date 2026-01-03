/**
 * Linear webhook server for @Claude agent
 *
 * Receives webhook events when @Claude is mentioned or assigned,
 * runs Claude Code, and posts responses back to Linear.
 */

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const app = new Hono();

// Environment
const WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET!;
const ACCESS_TOKEN = process.env.LINEAR_ACCESS_TOKEN!;
const REPO_PATH = process.env.REPO_PATH || "/Users/ian/dev/linear-beads";

if (!WEBHOOK_SECRET || !ACCESS_TOKEN) {
  console.error("Missing required env vars: LINEAR_WEBHOOK_SECRET, LINEAR_ACCESS_TOKEN");
  process.exit(1);
}

// Types for Linear webhook payloads
interface LinearWebhookPayload {
  action: string;
  type: string;
  data?: Record<string, unknown>;
  agentSession?: AgentSessionData;
  promptContext?: string;
  previousComments?: Array<{ id: string; body: string }>;
  createdAt: string;
  organizationId: string;
}

interface AgentSessionData {
  id: string;
  issueId: string;
  status: string;
  type: string;
  issue?: {
    id: string;
    identifier: string;
    title: string;
    description?: string;
    url?: string;
  };
  comment?: {
    id: string;
    body: string;
  };
  creator?: {
    id: string;
    name: string;
    email: string;
  };
}

// Verify webhook signature
function verifySignature(body: string, signature: string | null): boolean {
  if (!signature) return false;

  const hmac = createHmac("sha256", WEBHOOK_SECRET);
  hmac.update(body);
  const expected = hmac.digest("hex");

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Post a comment to Linear
async function postComment(issueId: string, body: string): Promise<void> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      query: `
        mutation CreateComment($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            success
            comment { id }
          }
        }
      `,
      variables: { issueId, body },
    }),
  });

  const result = await response.json();
  if (!result.data?.commentCreate?.success) {
    console.error("Failed to post comment:", result);
  }
}

// Emit agent activity to Linear (keeps session alive and shows progress)
async function emitActivity(
  sessionId: string,
  content: { type: string; body?: string; action?: string; parameter?: string; result?: string },
  ephemeral: boolean = false
): Promise<void> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      query: `
        mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
          agentActivityCreate(input: $input) {
            success
          }
        }
      `,
      variables: {
        input: {
          agentSessionId: sessionId,
          content,
          ephemeral,
        },
      },
    }),
  });

  const result = await response.json();
  if (!result.data?.agentActivityCreate?.success) {
    console.error("Failed to emit activity:", result);
  }
}

// Run Claude Agent on an issue
async function runAgent(session: AgentSessionData, promptContext?: string): Promise<void> {
  const issue = session.issue;
  if (!issue) {
    console.error("No issue data in session");
    return;
  }

  // Use Linear's provided context or build our own
  const context = promptContext || `
Issue ${issue.identifier}: "${issue.title}"
${issue.description ? `Description: ${issue.description}` : ""}
${session.comment?.body ? `Comment: ${session.comment.body}` : ""}
`.trim();

  const prompt = `
You are Claude, an AI assistant helping with Linear issues. You have access to a codebase.

${context}

Please help with this request. You have access to the codebase at ${REPO_PATH}.
Investigate the issue and provide a clear, helpful response.
`.trim();

  console.log(`\n🤖 Running agent for ${issue.identifier}...`);
  console.log(`📝 Prompt: ${prompt.slice(0, 200)}...`);

  // CRITICAL: Emit activity immediately to avoid "unresponsive" status (must be within 10s)
  await emitActivity(session.id, {
    type: "thought",
    body: `Analyzing issue ${issue.identifier}...`,
  }, true); // ephemeral - will be replaced

  try {
    let responseText = "";

    const iterator = query({
      prompt,
      options: {
        cwd: REPO_PATH,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        tools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit"],
        includePartialMessages: false,
      },
    });

    for await (const message of iterator) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            responseText = block.text;
          } else if (block.type === "tool_use") {
            console.log(`  🔧 Using tool: ${block.name}`);
            // Emit action activity for tool use (persistent, like Claude Code UI)
            await emitActivity(session.id, {
              type: "action",
              action: block.name,
              parameter: typeof block.input === "string"
                ? block.input.slice(0, 100)
                : JSON.stringify(block.input).slice(0, 100),
            });
          }
        }
      } else if (message.type === "result") {
        if (message.subtype === "success") {
          console.log(`✅ Agent completed in ${message.num_turns} turns`);
        } else {
          console.log(`❌ Agent failed: ${message.subtype}`);
        }
      }
    }

    // Emit final response activity and post comment
    if (responseText) {
      await emitActivity(session.id, {
        type: "response",
        body: responseText.slice(0, 2000), // Linear may have limits
      });
      await postComment(issue.id, responseText);
      console.log(`💬 Posted response to ${issue.identifier}`);
    } else {
      const fallback = "I looked into this but couldn't formulate a response. Please try rephrasing your request.";
      await emitActivity(session.id, { type: "response", body: fallback });
      await postComment(issue.id, fallback);
    }
  } catch (error) {
    console.error("Agent error:", error);
    const errorMsg = `I encountered an error: ${error instanceof Error ? error.message : "Unknown error"}`;
    await emitActivity(session.id, { type: "error", body: errorMsg });
    await postComment(issue.id, errorMsg);
  }
}

// Health check
app.get("/", (c) => c.json({ status: "ok", agent: "Claude" }));

// Webhook endpoint
app.post("/webhook", async (c) => {
  const signature = c.req.header("linear-signature");
  const body = await c.req.text();

  // Verify signature
  if (!verifySignature(body, signature)) {
    console.warn("Invalid webhook signature");
    return c.json({ error: "Invalid signature" }, 401);
  }

  const payload: LinearWebhookPayload = JSON.parse(body);
  console.log(`\n📥 Webhook: ${payload.type} / ${payload.action}`);

  // Handle agent session events
  if (payload.type === "AgentSessionEvent" && payload.action === "created") {
    // Save payload for debugging
    const fs = require("fs");
    fs.writeFileSync("/tmp/linear-webhook-payload.json", JSON.stringify(payload, null, 2));
    console.log(`📝 Payload saved to /tmp/linear-webhook-payload.json`);

    const session = payload.agentSession;
    if (!session) {
      console.error("No agentSession in payload");
      return c.json({ error: "No session data" }, 400);
    }

    console.log(`🎯 Agent session created on issue ${session.issue?.identifier || 'unknown'}`);
    console.log(`   Comment: ${session.comment?.body?.slice(0, 100) || 'none'}`);

    // Run agent asynchronously (don't block webhook response)
    runAgent(session, payload.promptContext).catch(console.error);

    return c.json({ received: true });
  }

  // Log other events for debugging
  console.log(`  (ignoring ${payload.type}/${payload.action})`);
  return c.json({ received: true });
});

// Start server
const port = parseInt(process.env.PORT || "3000");
console.log(`🚀 Claude agent server starting on port ${port}`);
console.log(`📁 Working directory: ${REPO_PATH}`);

export default {
  port,
  fetch: app.fetch,
};
