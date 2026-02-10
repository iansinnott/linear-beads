/**
 * Linear API client and mutations
 *
 * All communication with the Linear GraphQL API goes through this module.
 * Uses the app actor token from LINEAR_ACCESS_TOKEN env var.
 */

import { log } from "./logger";
import type { ActivityContent } from "./lib";

const ACCESS_TOKEN = process.env.LINEAR_ACCESS_TOKEN!;

// --- GraphQL mutation builders ---

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

/**
 * Create GraphQL mutation for adding a link attachment to an issue.
 * Idempotent on URL+issueId — calling again with the same URL updates the existing attachment.
 */
export function createAttachmentMutation(
  issueId: string,
  url: string,
  title: string,
  subtitle?: string
) {
  return {
    query: `
      mutation AttachmentCreate($input: AttachmentCreateInput!) {
        attachmentCreate(input: $input) {
          success
          attachment { id url title }
        }
      }
    `,
    variables: {
      input: { issueId, url, title, ...(subtitle && { subtitle }) },
    },
  };
}

/**
 * Create GraphQL mutation for adding a resource link to a project.
 */
export function createProjectLinkMutation(
  projectId: string,
  url: string,
  label: string
) {
  return {
    query: `
      mutation ProjectLinkCreate($input: ProjectLinkCreateInput!) {
        projectLinkCreate(input: $input) {
          success
          projectLink { id url label }
        }
      }
    `,
    variables: {
      input: { projectId, url, label },
    },
  };
}

// --- API client ---

/**
 * Generic Linear GraphQL API request helper
 * New code should use this instead of duplicating fetch() calls
 */
export async function linearApiRequest(
  body: { query: string; variables: Record<string, unknown> }
): Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Linear API HTTP ${response.status}`);
  }

  return response.json() as Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }>;
}

// --- High-level API operations ---

/**
 * Emit agent activity to Linear (keeps session alive and shows progress)
 * Returns true if the activity was successfully created
 */
export async function emitActivity(
  sessionId: string,
  content: { type: string; body?: string; action?: string; parameter?: string; result?: string },
  ephemeral: boolean = false
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify(
        createActivityMutation(sessionId, content, ephemeral)
      ),
    });
  } catch (err) {
    log("error", "Failed to emit activity", {
      sessionId,
      contentType: content.type,
      errorType: "network",
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  if (!response.ok) {
    log("error", "Failed to emit activity", {
      sessionId,
      contentType: content.type,
      httpStatus: response.status,
    });
    return false;
  }

  const result = (await response.json()) as {
    data?: { agentActivityCreate?: { success: boolean } };
    errors?: Array<{ message: string }>;
  };

  const success = result.data?.agentActivityCreate?.success === true;

  if (!success) {
    log("error", "Failed to emit activity", {
      sessionId,
      contentType: content.type,
      result,
      errors: result.errors,
    });
  }

  return success;
}
