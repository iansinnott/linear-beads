/**
 * Linear webhook server for @Claude agent
 *
 * Receives webhook events when @Claude is mentioned or assigned,
 * dispatches to the agent runner, and manages session lifecycle.
 */

import { existsSync, mkdirSync } from "fs";
import { Hono } from "hono";
import { log } from "./logger";
import { emitActivity } from "./linear-api";
import { runAgent } from "./agent";
import { REPOS_BASE } from "./repo";
import {
  verifySignature,
  parseWebhookPayload,
  isAgentSessionCreated,
  isAgentSessionPrompted,
  getPromptedMessage,
  isStopSignal,
  isSelfTrigger,
  isProjectUpdateMention,
  isProjectUpdateSelfTrigger,
  isProjectUpdateCommentForClaude,
  isProjectUpdateCommentSelfTrigger,
  type LinearWebhookPayload,
  type ProjectUpdateData,
  type ProjectUpdateCommentData,
} from "./lib";
import { handleProjectUpdate, handleProjectUpdateComment } from "./project-update";

const app = new Hono();

// Environment
const WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET!;

// Session deduplication to prevent infinite loops
// Tracks session IDs that have been processed (with timestamps for cleanup)
const processedSessions = new Map<string, number>();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SESSIONS = 1000;

// AIDEV-NOTE: Track running agents for proper cancellation on stop signal
// Maps session ID to AbortController so we can cancel in-flight agents
const runningAgents = new Map<string, AbortController>();

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

  let payload: LinearWebhookPayload;
  try {
    payload = parseWebhookPayload(body);
  } catch (err) {
    log("error", "Failed to parse webhook payload", {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Invalid payload" }, 400);
  }

  log("info", "Webhook received", {
    type: payload.type,
    action: payload.action,
    sessionId: payload.agentSession?.id,
    issueIdentifier: payload.agentSession?.issue?.identifier,
  });

  // AIDEV-NOTE: Enhanced logging for ProjectUpdate events to debug emoji disappearing issue
  // Log ALL ProjectUpdate webhooks with details about reactions
  if (payload.type === "ProjectUpdate") {
    const data = payload.data as ProjectUpdateData | undefined;
    log("info", "ProjectUpdate webhook details", {
      action: payload.action,
      projectUpdateId: data?.id,
      projectName: data?.project?.name,
      bodyPreview: data?.body?.slice(0, 50),
      reactionData: (data as Record<string, unknown>)?.reactionData,
      hasClaude: /@claude/i.test(data?.body || ""),
    });

    // Save ALL project update webhooks (not just create) for debugging
    if (process.env.NODE_ENV !== "production") {
      const fs = require("fs");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.writeFileSync(
        `/tmp/pu-webhook-${payload.action}-${timestamp}.json`,
        JSON.stringify(payload, null, 2)
      );
    }
  }

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

    // Create AbortController for this agent run so we can cancel on stop signal
    const abortController = new AbortController();
    runningAgents.set(session.id, abortController);

    // Run agent asynchronously (don't block webhook response)
    runAgent(session, payload.promptContext, undefined, abortController)
      .catch((error) => {
        log("error", "Unhandled error in runAgent", {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        // Clean up the abort controller when done
        runningAgents.delete(session.id);
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

    // Handle stop signal from user - cancel any running agent for this session
    if (isStopSignal(payload)) {
      log("info", "Stop signal received", {
        sessionId: session.id,
        issueIdentifier: session.issue?.identifier,
      });

      // Cancel the running agent if one exists for this session
      const abortController = runningAgents.get(session.id);
      if (abortController) {
        abortController.abort();
        runningAgents.delete(session.id);
        log("info", "Agent cancelled", { sessionId: session.id });

        // Emit activity to Linear indicating the agent was stopped
        await emitActivity(session.id, {
          type: "response",
          body: "Agent stopped by user request.",
        });
      } else {
        log("info", "No running agent to cancel", { sessionId: session.id });
      }

      return c.json({ received: true, action: "stop-acknowledged", cancelled: !!abortController });
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

    // Create AbortController for this agent run so we can cancel on stop signal
    const abortController = new AbortController();
    runningAgents.set(session.id, abortController);

    // Run agent with the follow-up message
    // Include promptContext for issue context, but the primary input is the user's new message
    runAgent(session, payload.promptContext, userMessage, abortController)
      .catch((error) => {
        log("error", "Unhandled error in runAgent (prompted)", {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        // Clean up the abort controller when done
        runningAgents.delete(session.id);
      });

    return c.json({ received: true });
  }

  // Handle project update mentions
  if (isProjectUpdateMention(payload)) {
    const data = payload.data as ProjectUpdateData;

    // Deduplication on project update ID
    if (isSessionProcessed(data.id)) {
      log("warn", "Duplicate project update detected, skipping", {
        projectUpdateId: data.id,
        projectName: data.project?.name,
      });
      return c.json({ received: true, skipped: "duplicate" });
    }

    // Self-trigger detection
    if (isProjectUpdateSelfTrigger(payload)) {
      log("warn", "Project update self-trigger detected, skipping", {
        projectUpdateId: data.id,
        userId: data.userId,
        appUserId: payload.appUserId,
      });
      return c.json({ received: true, skipped: "self-trigger" });
    }

    // Mark as processed before starting work
    markSessionProcessed(data.id);

    log("info", "Processing project update mention", {
      projectUpdateId: data.id,
      projectId: data.projectId,
      projectName: data.project?.name,
      userName: data.user?.name,
      bodyPreview: data.body?.slice(0, 100),
    });

    // Save payload for debugging (in dev only)
    if (process.env.NODE_ENV !== "production") {
      const fs = require("fs");
      fs.writeFileSync("/tmp/linear-webhook-project-update.json", JSON.stringify(payload, null, 2));
    }

    // Run handler asynchronously (don't block webhook response)
    handleProjectUpdate(data).catch((error) => {
      log("error", "Unhandled error in handleProjectUpdate", {
        projectUpdateId: data.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return c.json({ received: true });
  }

  // Handle comments on project updates where Claude is in the thread
  if (isProjectUpdateCommentForClaude(payload)) {
    const data = payload.data as unknown as ProjectUpdateCommentData;

    // Deduplication on comment ID
    if (isSessionProcessed(data.id)) {
      log("warn", "Duplicate project update comment detected, skipping", {
        commentId: data.id,
        projectUpdateId: data.projectUpdateId,
      });
      return c.json({ received: true, skipped: "duplicate" });
    }

    // Self-trigger detection
    if (isProjectUpdateCommentSelfTrigger(payload)) {
      log("warn", "Project update comment self-trigger detected, skipping", {
        commentId: data.id,
        userId: data.userId,
        appUserId: payload.appUserId,
      });
      return c.json({ received: true, skipped: "self-trigger" });
    }

    // Mark as processed before starting work
    markSessionProcessed(data.id);

    log("info", "Processing project update comment", {
      commentId: data.id,
      projectUpdateId: data.projectUpdateId,
      projectName: data.projectUpdate?.project?.name,
      userName: data.user?.name,
      bodyPreview: data.body?.slice(0, 100),
    });

    // Save payload for debugging (in dev only)
    if (process.env.NODE_ENV !== "production") {
      const fs = require("fs");
      fs.writeFileSync("/tmp/linear-webhook-project-update-comment.json", JSON.stringify(payload, null, 2));
    }

    // Run handler asynchronously (don't block webhook response)
    handleProjectUpdateComment(data).catch((error) => {
      log("error", "Unhandled error in handleProjectUpdateComment", {
        commentId: data.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return c.json({ received: true });
  }

  // Log other events for debugging
  log("info", "Ignoring non-session event", { type: payload.type, action: payload.action });
  return c.json({ received: true });
});

// Ensure REPOS_BASE exists
if (!existsSync(REPOS_BASE)) {
  mkdirSync(REPOS_BASE, { recursive: true });
}

// Start server
const port = parseInt(process.env.PORT || "3000");
log("info", "Claude agent server starting", {
  port,
  reposBase: REPOS_BASE,
  nodeEnv: process.env.NODE_ENV || "development",
  hasWebhookSecret: !!WEBHOOK_SECRET,
  hasAccessToken: !!process.env.LINEAR_ACCESS_TOKEN,
});

export default {
  port,
  fetch: app.fetch,
};
