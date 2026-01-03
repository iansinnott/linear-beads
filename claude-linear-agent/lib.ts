/**
 * Core functions for the Linear webhook agent
 * Extracted for testability
 */

import { createHmac, timingSafeEqual } from "crypto";

// Types for Linear webhook payloads
export interface LinearWebhookPayload {
  action: string;
  type: string;
  data?: Record<string, unknown>;
  agentSession?: AgentSessionData;
  promptContext?: string;
  previousComments?: Array<{ id: string; body: string }>;
  createdAt: string;
  organizationId: string;
}

export interface AgentSessionData {
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
