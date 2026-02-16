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
  createReactionMutation,
} from "./linear-api";
import { resolveProjectRepoCwd } from "./repo";
import { buildProjectUpdatePrompt } from "./agent-prompt";
import type { ProjectUpdateData } from "./lib";

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
