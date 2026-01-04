/**
 * Linear webhook server for @Claude agent
 *
 * Receives webhook events when @Claude is mentioned or assigned,
 * runs Claude Code, and posts responses back to Linear.
 */

import { Hono } from "hono";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
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
  type ActivityContent,
} from "./lib";

const app = new Hono();

// Environment
const WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET!;
const ACCESS_TOKEN = process.env.LINEAR_ACCESS_TOKEN!;
const REPO_PATH = process.env.REPO_PATH || "/Users/ian/dev/linear-beads";

// Session deduplication to prevent infinite loops
// Tracks session IDs that have been processed (with timestamps for cleanup)
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

function markSessionProcessed(sessionId: string): void {
  // Cleanup old entries if we're at capacity
  if (processedSessions.size >= MAX_SESSIONS) {
    const now = Date.now();
    const entries = Array.from(processedSessions.entries());
    for (const [id, ts] of entries) {
      if (now - ts > SESSION_TTL_MS) {
        processedSessions.delete(id);
      }
    }
  }
  processedSessions.set(sessionId, Date.now());
}

// Sanitize @mentions to prevent self-triggering loops
// AIDEV-NOTE: Critical for preventing infinite webhook loops - if agent response
// contains @claude, Linear may interpret it as a new mention and create another session
function sanitizeMentions(text: string): string {
  // Replace @claude (case insensitive) with just "Claude"
  // Also handle any @mentions to be safe
  return text.replace(/@claude/gi, "Claude").replace(/@(\w+)/g, "$1");
}

// Structured logging helper
function log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else if (level === "warn") {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
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

  const result = (await response.json()) as {
    data?: { commentCreate?: { success: boolean } };
  };
  if (!result.data?.commentCreate?.success) {
    log("error", "Failed to post comment", { issueId, result });
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

  const result = (await response.json()) as {
    data?: { agentActivityCreate?: { success: boolean } };
  };
  if (!result.data?.agentActivityCreate?.success) {
    log("error", "Failed to emit activity", { sessionId, contentType: content.type, result });
  }
}

// Run Claude Agent on an issue
// For prompted events (follow-ups), userMessage contains the user's new message
async function runAgent(session: AgentSessionData, promptContext?: string, userMessage?: string): Promise<void> {
  const issue = session.issue;
  if (!issue) {
    log("error", "No issue data in session", { sessionId: session.id });
    return;
  }

  // Build prompt differently for initial vs follow-up messages
  let prompt: string;
  if (userMessage) {
    // Prompted event: user sent a follow-up message
    // Include issue context but make the user's message the focus
    prompt = `
You are Claude, an AI assistant helping with Linear issues. You have access to a codebase.

Issue context:
${promptContext || `Issue ${issue.identifier}: "${issue.title}"`}

The user sent a follow-up message:
${userMessage}

Please help with this request. You have access to the codebase at ${REPO_PATH}.
`.trim();
  } else {
    // Created event: initial mention
    prompt = buildPrompt(session, promptContext, REPO_PATH);
  }

  log("info", "Starting agent run", {
    sessionId: session.id,
    issueIdentifier: issue.identifier,
    promptLength: prompt.length,
    isFollowUp: !!userMessage,
  });

  // CRITICAL: Emit activity immediately to avoid "unresponsive" status (must be within 10s)
  const activityMessage = userMessage
    ? `Processing follow-up message...`
    : `Analyzing issue ${issue.identifier}...`;
  await emitActivity(session.id, {
    type: "thought",
    body: activityMessage,
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
            log("info", "Tool use", {
              sessionId: session.id,
              tool: block.name,
            });
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
        log("info", "Agent run completed", {
          sessionId: session.id,
          subtype: message.subtype,
          turns: message.subtype === "success" ? message.num_turns : undefined,
        });
      }
    }

    // Emit final response activity
    // AIDEV-NOTE: Linear auto-creates a comment from response activities, so we don't need postComment()
    // Removed postComment() to avoid duplicate comments and reduce self-trigger risk
    if (responseText) {
      const sanitized = sanitizeMentions(responseText.slice(0, 2000));
      await emitActivity(session.id, {
        type: "response",
        body: sanitized,
      });
      log("info", "Agent completed successfully", {
        sessionId: session.id,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        responseLength: sanitized.length,
      });
    } else {
      const fallback = "I looked into this but couldn't formulate a response. Please try rephrasing your request.";
      await emitActivity(session.id, { type: "response", body: fallback });
      log("warn", "Agent completed with fallback response", {
        sessionId: session.id,
        issueId: issue.id,
      });
    }
  } catch (error) {
    const errorMsg = `I encountered an error: ${error instanceof Error ? error.message : "Unknown error"}`;
    await emitActivity(session.id, { type: "error", body: sanitizeMentions(errorMsg) });
    log("error", "Agent failed with error", {
      sessionId: session.id,
      issueId: issue.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Health check
app.get("/", (c) => c.json({ status: "ok", agent: "Claude" }));

// Webhook endpoint
app.post("/webhook", async (c) => {
  const signature = c.req.header("linear-signature");
  const body = await c.req.text();

  // Verify signature
  if (!verifySignature(body, signature, WEBHOOK_SECRET)) {
    log("warn", "Invalid webhook signature received");
    return c.json({ error: "Invalid signature" }, 401);
  }

  const payload = parseWebhookPayload(body);
  log("info", "Webhook received", {
    type: payload.type,
    action: payload.action,
    sessionId: payload.agentSession?.id,
    issueIdentifier: payload.agentSession?.issue?.identifier,
  });

  // Handle agent session events
  if (isAgentSessionCreated(payload)) {
    const session = payload.agentSession;
    if (!session) {
      log("error", "No agentSession in payload");
      return c.json({ error: "No session data" }, 400);
    }

    // AIDEV-NOTE: Critical deduplication check to prevent infinite loops
    // If we've already processed this session, skip it
    if (isSessionProcessed(session.id)) {
      log("warn", "Duplicate session detected, skipping", {
        sessionId: session.id,
        issueIdentifier: session.issue?.identifier,
      });
      return c.json({ received: true, skipped: "duplicate" });
    }

    // AIDEV-NOTE: Self-trigger detection - if our agent triggered this session, skip it
    // This is a secondary defense beyond session dedup (catches @mention in response text)
    if (isSelfTrigger(payload)) {
      log("warn", "Self-trigger detected, skipping", {
        sessionId: session.id,
        issueIdentifier: session.issue?.identifier,
        creatorId: session.creatorId || session.creator?.id,
        appUserId: payload.appUserId || session.appUserId,
      });
      return c.json({ received: true, skipped: "self-trigger" });
    }

    // Mark session as processed BEFORE starting work
    markSessionProcessed(session.id);

    log("info", "Processing new agent session", {
      sessionId: session.id,
      issueId: session.issue?.id,
      issueIdentifier: session.issue?.identifier,
      commentBody: session.comment?.body?.slice(0, 100),
      activeSessionCount: processedSessions.size,
    });

    // Save payload for debugging (in dev only)
    if (process.env.NODE_ENV !== "production") {
      const fs = require("fs");
      fs.writeFileSync("/tmp/linear-webhook-payload.json", JSON.stringify(payload, null, 2));
    }

    // Run agent asynchronously (don't block webhook response)
    runAgent(session, payload.promptContext).catch((error) => {
      log("error", "Unhandled error in runAgent", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return c.json({ received: true });
  }

  // Handle prompted events (multi-turn follow-ups)
  if (isAgentSessionPrompted(payload)) {
    const session = payload.agentSession;
    if (!session) {
      log("error", "No agentSession in prompted payload");
      return c.json({ error: "No session data" }, 400);
    }

    // Handle stop signal from user
    // AIDEV-TODO: Implement proper cancellation of running agent
    if (isStopSignal(payload)) {
      log("info", "Stop signal received", {
        sessionId: session.id,
        issueIdentifier: session.issue?.identifier,
      });
      // For now, just acknowledge - proper cancellation requires tracking running agents
      return c.json({ received: true, action: "stop-acknowledged" });
    }

    const userMessage = getPromptedMessage(payload);
    if (!userMessage) {
      log("error", "No user message in prompted payload", {
        sessionId: session.id,
        agentActivity: payload.agentActivity,
      });
      return c.json({ error: "No user message" }, 400);
    }

    // AIDEV-NOTE: For prompted events, we use a unique key combining session + activity ID
    // This allows multiple prompts in the same session while still preventing duplicates
    const dedupeKey = `${session.id}:${payload.agentActivity?.id || "unknown"}`;
    if (isSessionProcessed(dedupeKey)) {
      log("warn", "Duplicate prompted event detected, skipping", {
        sessionId: session.id,
        activityId: payload.agentActivity?.id,
      });
      return c.json({ received: true, skipped: "duplicate" });
    }
    markSessionProcessed(dedupeKey);

    log("info", "Processing prompted event (multi-turn)", {
      sessionId: session.id,
      issueIdentifier: session.issue?.identifier,
      userMessage: userMessage.slice(0, 100),
      activityId: payload.agentActivity?.id,
    });

    // Save payload for debugging (in dev only)
    if (process.env.NODE_ENV !== "production") {
      const fs = require("fs");
      fs.writeFileSync("/tmp/linear-webhook-prompted.json", JSON.stringify(payload, null, 2));
    }

    // Run agent with the follow-up message
    // Include promptContext for issue context, but the primary input is the user's new message
    runAgent(session, payload.promptContext, userMessage).catch((error) => {
      log("error", "Unhandled error in runAgent (prompted)", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return c.json({ received: true });
  }

  // Log other events for debugging
  log("info", "Ignoring non-session event", { type: payload.type, action: payload.action });
  return c.json({ received: true });
});

// Start server
const port = parseInt(process.env.PORT || "3000");
log("info", "Claude agent server starting", {
  port,
  repoPath: REPO_PATH,
  nodeEnv: process.env.NODE_ENV || "development",
});

export default {
  port,
  fetch: app.fetch,
};
