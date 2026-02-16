/**
 * Core types and webhook helpers for the Linear webhook agent
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

// --- Project Update Types and Helpers ---

/**
 * Project update payload shape (from ProjectUpdate webhook)
 * See issue description for example payload
 */
export interface ProjectUpdateData {
  id: string;
  body: string;
  bodyData?: string;
  projectId: string;
  health?: string;
  userId: string;
  project?: {
    id: string;
    name: string;
    url?: string;
  };
  user?: {
    id: string;
    name: string;
    email?: string;
  };
}

/**
 * Check if this is a project update mentioning @claude
 */
export function isProjectUpdateMention(payload: LinearWebhookPayload): boolean {
  return (
    payload.type === "ProjectUpdate" &&
    payload.action === "create" &&
    /@claude/i.test((payload.data?.body as string) || "")
  );
}

/**
 * Check if this project update was created by our agent (self-trigger)
 */
export function isProjectUpdateSelfTrigger(payload: LinearWebhookPayload): boolean {
  const data = payload.data as ProjectUpdateData | undefined;
  if (!data) return false;
  // Compare update author with our app user ID
  return data.userId === payload.appUserId;
}

// AIDEV-NOTE: Marker used by agent to signal it needs user clarification
// When present, we emit "elicitation" instead of "response", keeping session in awaitingInput state
export const CLARIFICATION_MARKER = "[NEEDS_CLARIFICATION]";

/**
 * Check if agent response is asking for clarification
 * Searches for the marker anywhere in the response - the agent might add
 * preamble text before it (e.g., "Here's what I found:\n\n[NEEDS_CLARIFICATION]")
 *
 * Returns { needsClarification: boolean, cleanedText: string }
 * - cleanedText includes any preamble before the marker, then the rest after it
 */
export function parseForClarification(text: string): {
  needsClarification: boolean;
  cleanedText: string;
} {
  const markerIndex = text.indexOf(CLARIFICATION_MARKER);

  if (markerIndex !== -1) {
    // Found the marker - include preamble (if any) and content after marker
    const preamble = text.slice(0, markerIndex).trim();
    const afterMarker = text.slice(markerIndex + CLARIFICATION_MARKER.length).trim();

    // Combine preamble and content, separated by newline if both exist
    const cleanedText = preamble
      ? `${preamble}\n\n${afterMarker}`
      : afterMarker;

    return {
      needsClarification: true,
      cleanedText,
    };
  }

  return { needsClarification: false, cleanedText: text };
}
