/**
 * Core functions for the Linear webhook agent
 * Extracted for testability
 */

import { createHmac, timingSafeEqual } from "crypto";

// Types for Linear webhook payloads
// AIDEV-NOTE: These types are derived from actual webhook payloads (2026-01-03)
// See /tmp/linear-webhook-payload.json for a real example
// Agent activity content (nested inside AgentActivityData)
export interface AgentActivityContent {
  type: "prompt" | "thought" | "action" | "response" | "error" | "elicitation";
  body?: string; // The user's message (for type="prompt")
}

// Agent activity from user (for prompted events)
// AIDEV-NOTE: The user message is in content.body, NOT directly on agentActivity
// This caused a bug where we looked for agentActivity.body instead of agentActivity.content.body
export interface AgentActivityData {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  agentSessionId?: string;
  sourceCommentId?: string | null;
  userId?: string;
  sourceMetadata?: unknown | null;
  signal?: "stop" | null; // "stop" when user clicks stop button
  signalMetadata?: unknown | null;
  ephemeral?: boolean;
  contextualMetadata?: unknown | null;
  content: AgentActivityContent; // Required - always present in prompted events
}

export interface LinearWebhookPayload {
  action: string;
  type: string;
  createdAt: string;
  organizationId: string;
  // Agent-specific fields (present for AgentSessionEvent)
  oauthClientId?: string;
  appUserId?: string; // Our agent's user ID - use for self-trigger detection
  agentSession?: AgentSessionData;
  agentActivity?: AgentActivityData; // Present for "prompted" events
  promptContext?: string;
  previousComments?: Array<{
    id: string;
    body: string;
    userId?: string;
    issueId?: string;
  }>;
  guidance?: string | null;
  webhookTimestamp?: number;
  webhookId?: string;
  // Generic webhook fields
  data?: Record<string, unknown>;
}

export interface AgentSessionData {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  // User IDs
  creatorId?: string; // Who triggered the session (user ID)
  appUserId?: string; // Our agent's user ID
  // Related entity IDs
  issueId: string;
  commentId?: string;
  sourceCommentId?: string | null;
  organizationId?: string;
  // Status
  status: string;
  type: string;
  startedAt?: string | null;
  endedAt?: string | null;
  dismissedAt?: string | null;
  dismissedById?: string | null;
  // External links
  externalLink?: string | null;
  externalUrls?: string[];
  // Metadata
  summary?: string | null;
  sourceMetadata?: {
    type?: string;
    agentSessionMetadata?: {
      sourceCommentId?: string;
    };
  } | null;
  plan?: unknown | null;
  // Related objects (expanded)
  issue?: {
    id: string;
    identifier: string;
    title: string;
    description?: string;
    url?: string;
    teamId?: string;
    team?: {
      id: string;
      key: string;
      name: string;
    };
  };
  comment?: {
    id: string;
    body: string;
    userId?: string; // Who wrote the comment
    issueId?: string;
  };
  creator?: {
    id: string;
    name: string;
    email: string;
    avatarUrl?: string;
    url?: string;
  };
}

export interface ActivityContent {
  type: string;
  body?: string;
  action?: string;
  parameter?: string;
  result?: string;
}

/**
 * Verify Linear webhook signature
 */
export function verifySignature(
  body: string,
  signature: string | null | undefined,
  secret: string
): boolean {
  if (!signature) return false;

  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  const expected = hmac.digest("hex");

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Build prompt from session data
 */
export function buildPrompt(
  session: AgentSessionData,
  promptContext: string | undefined,
  repoPath: string
): string {
  const issue = session.issue;
  if (!issue) {
    throw new Error("No issue data in session");
  }

  // Use Linear's provided context or build our own
  const context =
    promptContext ||
    `
Issue ${issue.identifier}: "${issue.title}"
${issue.description ? `Description: ${issue.description}` : ""}
${session.comment?.body ? `Comment: ${session.comment.body}` : ""}
`.trim();

  return `
You are Claude, an AI assistant helping with Linear issues. You have access to a codebase.

${context}

Please help with this request. You have access to the codebase at ${repoPath}.
Investigate the issue and provide a clear, helpful response.
`.trim();
}

/**
 * Parse webhook payload
 */
export function parseWebhookPayload(body: string): LinearWebhookPayload {
  return JSON.parse(body) as LinearWebhookPayload;
}

/**
 * Check if this is an agent session created event
 */
export function isAgentSessionCreated(payload: LinearWebhookPayload): boolean {
  return payload.type === "AgentSessionEvent" && payload.action === "created";
}

/**
 * Check if this is an agent session prompted event (multi-turn follow-up)
 */
export function isAgentSessionPrompted(payload: LinearWebhookPayload): boolean {
  return payload.type === "AgentSessionEvent" && payload.action === "prompted";
}

/**
 * Extract user message from prompted event
 * The user's follow-up message is in agentActivity.content.body
 */
export function getPromptedMessage(payload: LinearWebhookPayload): string | null {
  return payload.agentActivity?.content?.body || null;
}

/**
 * Check if this is a stop signal from the user
 */
export function isStopSignal(payload: LinearWebhookPayload): boolean {
  return payload.agentActivity?.signal === "stop";
}

/**
 * Check if this webhook is a self-trigger (our agent triggered itself)
 * This happens when the agent's response contains an @mention that triggers a new session
 * AIDEV-NOTE: Key self-trigger detection - compare creatorId with appUserId
 */
export function isSelfTrigger(payload: LinearWebhookPayload): boolean {
  const session = payload.agentSession;
  if (!session) return false;

  // Compare who created the session with our agent's ID
  // Both are available in the payload - no need for external lookups
  const creatorId = session.creatorId || session.creator?.id;
  const ourAgentId = payload.appUserId || session.appUserId;

  if (!creatorId || !ourAgentId) return false;

  return creatorId === ourAgentId;
}

/**
 * Create GraphQL mutation for posting a comment
 */
export function createCommentMutation(issueId: string, body: string) {
  return {
    query: `
      mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { id }
        }
      }
    `,
    variables: { issueId, body },
  };
}

/**
 * Create GraphQL mutation for emitting agent activity
 */
export function createActivityMutation(
  sessionId: string,
  content: ActivityContent,
  ephemeral: boolean = false
) {
  return {
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
  };
}
