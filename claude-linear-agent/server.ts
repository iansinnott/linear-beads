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
  data: Record<string, unknown>;
  createdAt: string;
  organizationId: string;
}

interface AgentSessionData {
  id: string;
  issueId: string;
  issue?: {
    id: string;
    identifier: string;
    title: string;
    description?: string;
  };
  triggerType: "mention" | "delegation";
  messageId?: string;
  message?: {
    body: string;
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

// Update agent session activity
async function updateSession(
  sessionId: string,
  status: "running" | "completed" | "failed",
  progress?: string
): Promise<void> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      query: `
        mutation UpdateAgentSession($id: String!, $status: AgentSessionStatus!, $progress: String) {
          agentSessionUpdate(id: $id, input: { status: $status, progress: $progress }) {
            success
          }
        }
      `,
      variables: { id: sessionId, status, progress },
    }),
  });

  const result = await response.json();
  if (!result.data?.agentSessionUpdate?.success) {
    console.error("Failed to update session:", result);
  }
}

// Run Claude Agent on an issue
async function runAgent(session: AgentSessionData): Promise<void> {
  const issue = session.issue;
  if (!issue) {
    console.error("No issue data in session");
    return;
  }

  // Build prompt from issue context
  const mentionText = session.message?.body || "";
  const prompt = `
You are helping with Linear issue ${issue.identifier}: "${issue.title}"

${issue.description ? `Issue description:\n${issue.description}\n` : ""}
${mentionText ? `The user mentioned you with:\n${mentionText}\n` : ""}

Please help with this issue. You have access to the codebase at ${REPO_PATH}.
After investigating, provide a clear response summarizing what you found or did.
`.trim();

  console.log(`\n🤖 Running agent for ${issue.identifier}...`);
  console.log(`📝 Prompt: ${prompt.slice(0, 200)}...`);

  try {
    // Update session to running
    await updateSession(session.id, "running", "Analyzing issue...");

    let responseText = "";
    let lastProgress = "";

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
            // Update progress periodically
            const progress = `Processing: ${responseText.slice(0, 100)}...`;
            if (progress !== lastProgress) {
              await updateSession(session.id, "running", progress);
              lastProgress = progress;
            }
          } else if (block.type === "tool_use") {
            await updateSession(session.id, "running", `Using tool: ${block.name}`);
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

    // Post final response as comment
    if (responseText) {
      await postComment(issue.id, responseText);
      await updateSession(session.id, "completed");
      console.log(`💬 Posted response to ${issue.identifier}`);
    } else {
      await postComment(issue.id, "I looked into this but couldn't formulate a response. Please try rephrasing your request.");
      await updateSession(session.id, "completed");
    }
  } catch (error) {
    console.error("Agent error:", error);
    await postComment(
      issue.id,
      `I encountered an error while processing this request: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    await updateSession(session.id, "failed");
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
  if (payload.type === "AgentSession" && payload.action === "create") {
    const session = payload.data as unknown as AgentSessionData;
    console.log(`🎯 Agent session created: ${session.triggerType} on issue ${session.issue?.identifier}`);

    // Run agent asynchronously (don't block webhook response)
    runAgent(session).catch(console.error);

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
