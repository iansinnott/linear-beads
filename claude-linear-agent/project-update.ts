/**
 * Project Update Handler
 *
 * Handles @Claude mentions in Linear project updates.
 * This is a simpler, one-shot flow compared to the issue agent session:
 * - No agent session lifecycle
 * - No activity tracking or progress UI
 * - Emoji reaction for acknowledgment
 * - Single response as a comment on the project update
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { log } from "./logger";
import {
  linearApiRequest,
  createProjectUpdateCommentMutation,
  createProjectUpdateCommentReplyMutation,
  createReactionMutation,
  createCommentReactionMutation,
} from "./linear-api";
import { resolveProjectRepoCwd } from "./repo";
import { buildProjectUpdatePrompt, buildProjectUpdateCommentPrompt } from "./agent-prompt";
import type { ProjectUpdateData, ProjectUpdateCommentData } from "./lib";

// Sanitize @mentions to prevent self-triggering loops
function sanitizeMentions(text: string): string {
  return text.replace(/@claude/gi, "Claude").replace(/@(\w+)/g, "$1");
}

/**
 * Add an emoji reaction to acknowledge receipt (fast feedback)
 */
async function addReaction(projectUpdateId: string, emoji: string): Promise<boolean> {
  try {
    const result = await linearApiRequest(createReactionMutation(projectUpdateId, emoji));
    const reactionCreate = (result.data as Record<string, unknown>)?.reactionCreate as { success?: boolean } | undefined;
    const success = reactionCreate?.success === true;

    log(success ? "info" : "warn", "Reaction create result", {
      projectUpdateId,
      emoji,
      success,
      errors: result.errors,
    });

    return success;
  } catch (err) {
    log("warn", "Failed to add reaction to project update", {
      projectUpdateId,
      emoji,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Add an emoji reaction to a comment (fast feedback for comment replies)
 */
async function addCommentReaction(commentId: string, emoji: string): Promise<boolean> {
  try {
    const result = await linearApiRequest(createCommentReactionMutation(commentId, emoji));
    const reactionCreate = (result.data as Record<string, unknown>)?.reactionCreate as { success?: boolean } | undefined;
    const success = reactionCreate?.success === true;

    log(success ? "info" : "warn", "Comment reaction create result", {
      commentId,
      emoji,
      success,
      errors: result.errors,
    });

    return success;
  } catch (err) {
    log("warn", "Failed to add reaction to comment", {
      commentId,
      emoji,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Post a comment on a project update
 */
async function postComment(projectUpdateId: string, body: string): Promise<boolean> {
  try {
    const result = await linearApiRequest(createProjectUpdateCommentMutation(projectUpdateId, body));
    const commentCreate = (result.data as Record<string, unknown>)?.commentCreate as { success?: boolean } | undefined;
    return commentCreate?.success === true;
  } catch (err) {
    log("error", "Failed to post comment on project update", {
      projectUpdateId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Post a reply to a comment on a project update (threaded reply)
 */
async function postCommentReply(
  projectUpdateId: string,
  parentCommentId: string,
  body: string
): Promise<boolean> {
  try {
    const result = await linearApiRequest(
      createProjectUpdateCommentReplyMutation(projectUpdateId, parentCommentId, body)
    );
    const commentCreate = (result.data as Record<string, unknown>)?.commentCreate as { success?: boolean } | undefined;
    const success = commentCreate?.success === true;

    if (!success) {
      log("error", "Linear API rejected comment reply", {
        projectUpdateId,
        parentCommentId,
        errors: result.errors,
        data: result.data,
      });
    }

    return success;
  } catch (err) {
    log("error", "Failed to post reply to comment", {
      projectUpdateId,
      parentCommentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Handle a project update mention
 *
 * Flow:
 * 1. Wait for Linear's async initialization (~2.5s) then add 👀 reaction (ACK: "I saw this")
 * 2. Resolve repo from project external links
 * 3. Build project-level prompt
 * 4. Run agent via query() — lean loop, just collect final response
 * 5. Post response as comment on the project update
 * 6. Add :claude: reaction (signal: "I responded" — helps since comments don't auto-expand)
 *
 * AIDEV-NOTE: Linear has a bug where newly created project updates have an async
 * initialization process that clears reactions added within ~2s of creation.
 * Workaround: wait 2.5s before adding reactions.
 */
export async function handleProjectUpdate(data: ProjectUpdateData): Promise<void> {
  const startTime = Date.now();
  const projectUpdateId = data.id;
  const projectId = data.projectId;
  const projectName = data.project?.name || "Unknown Project";
  const userName = data.user?.name;

  // 1. Wait for Linear's async initialization, then add 👀 (ACK: "I saw this")
  // Linear clears reactions on newly created project updates ~2s after creation.
  // We wait 2.5s to ensure the initialization is complete before adding reactions.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await addReaction(projectUpdateId, "eyes");

  // 2. Resolve repo from project
  const { cwd, repoPath, cloneInfo } = await resolveProjectRepoCwd(projectId);

  // 3. Build project-level prompt
  const prompt = buildProjectUpdatePrompt({
    repoPath,
    cloneInfo,
    projectName,
    projectId,
    updateBody: data.body,
    userName,
  });

  log("info", "Starting project update agent run", {
    projectUpdateId,
    projectName,
    promptLength: prompt.length,
    cwd,
  });

  try {
    let responseText = "";

    // 4. Run agent — lean loop, just collect final response
    const iterator = query({
      prompt,
      options: {
        cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        tools: { type: "preset", preset: "claude_code" },
        includePartialMessages: false,
      },
    });

    for await (const message of iterator) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            responseText = block.text;
          }
        }
      } else if (message.type === "result") {
        log("info", "Project update agent run completed", {
          projectUpdateId,
          subtype: message.subtype,
          durationMs: Date.now() - startTime,
        });
      }
    }

    // 5. Post response as comment on the project update
    if (responseText) {
      const sanitized = sanitizeMentions(responseText);
      const success = await postComment(projectUpdateId, sanitized);
      log(success ? "info" : "error", "Posted project update response", {
        projectUpdateId,
        responseLength: sanitized.length,
        success,
      });
    } else {
      const fallback = "I looked into this but couldn't formulate a response. Please try rephrasing your request.";
      await postComment(projectUpdateId, fallback);
      log("warn", "Project update agent completed with fallback response", {
        projectUpdateId,
      });
    }

    // 6. Add :claude: reaction to signal "I responded" (comments don't auto-expand in UI)
    await addReaction(projectUpdateId, "claude");
  } catch (error) {
    const errorMsg = `I encountered an error: ${error instanceof Error ? error.message : "Unknown error"}`;
    await postComment(projectUpdateId, sanitizeMentions(errorMsg));
    // Still add :claude: on error so user knows we tried to respond
    await addReaction(projectUpdateId, "claude");
    log("error", "Project update agent failed", {
      projectUpdateId,
      durationMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Handle a comment on a project update where Claude is in the thread.
 *
 * Flow:
 * 1. Add 👀 reaction to the user's comment (ACK: "I saw this")
 * 2. Resolve repo from project external links
 * 3. Build prompt with conversation context
 * 4. Run agent via query()
 * 5. Post reply as a threaded response to the user's comment
 * 6. Add :claude: reaction to the user's comment (signal: "I responded")
 */
export async function handleProjectUpdateComment(data: ProjectUpdateCommentData): Promise<void> {
  const startTime = Date.now();
  const commentId = data.id;
  const projectUpdateId = data.projectUpdateId;
  const projectName = data.projectUpdate?.project?.name || "Unknown Project";
  const projectId = data.projectUpdate?.project?.id;
  const userName = data.user?.name;

  // AIDEV-NOTE: Linear requires parentId to be the ROOT comment of a thread.
  // If data.parentId exists, this comment is a reply, so use the existing root.
  // If data.parentId is undefined, this comment IS the root (top-level comment).
  const threadRootId = data.parentId || commentId;

  // 1. Add 👀 reaction to acknowledge the user's comment
  // Comments don't have the same initialization delay as project updates
  await addCommentReaction(commentId, "eyes");

  if (!projectId) {
    log("error", "No project ID in comment data", { commentId, projectUpdateId });
    await postCommentReply(
      projectUpdateId,
      threadRootId,
      "I couldn't find the project context for this conversation."
    );
    return;
  }

  // 2. Resolve repo from project
  const { cwd, repoPath, cloneInfo } = await resolveProjectRepoCwd(projectId);

  // 3. Build prompt with conversation context
  const prompt = buildProjectUpdateCommentPrompt({
    repoPath,
    cloneInfo,
    projectName,
    projectId,
    originalUpdateBody: data.projectUpdate?.body || "",
    commentBody: data.body,
    userName,
  });

  log("info", "Starting project update comment agent run", {
    commentId,
    projectUpdateId,
    projectName,
    promptLength: prompt.length,
    cwd,
  });

  try {
    let responseText = "";

    // 4. Run agent — lean loop, just collect final response
    const iterator = query({
      prompt,
      options: {
        cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        tools: { type: "preset", preset: "claude_code" },
        includePartialMessages: false,
      },
    });

    for await (const message of iterator) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            responseText = block.text;
          }
        }
      } else if (message.type === "result") {
        log("info", "Project update comment agent run completed", {
          commentId,
          projectUpdateId,
          subtype: message.subtype,
          durationMs: Date.now() - startTime,
        });
      }
    }

    // 5. Post reply as a threaded response (always use threadRootId for Linear API)
    if (responseText) {
      const sanitized = sanitizeMentions(responseText);
      const success = await postCommentReply(projectUpdateId, threadRootId, sanitized);
      log(success ? "info" : "error", "Posted project update comment response", {
        commentId,
        threadRootId,
        projectUpdateId,
        responseLength: sanitized.length,
        success,
      });
    } else {
      const fallback = "I looked into this but couldn't formulate a response. Please try rephrasing your request.";
      await postCommentReply(projectUpdateId, threadRootId, fallback);
      log("warn", "Project update comment agent completed with fallback response", {
        commentId,
        threadRootId,
        projectUpdateId,
      });
    }

    // 6. Add :claude: reaction to signal "I responded"
    await addCommentReaction(commentId, "claude");
  } catch (error) {
    const errorMsg = `I encountered an error: ${error instanceof Error ? error.message : "Unknown error"}`;
    await postCommentReply(projectUpdateId, threadRootId, sanitizeMentions(errorMsg));
    // Still add :claude: on error so user knows we tried to respond
    await addCommentReaction(commentId, "claude");
    log("error", "Project update comment agent failed", {
      commentId,
      threadRootId,
      projectUpdateId,
      durationMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
