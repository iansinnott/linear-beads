/**
 * Agent system prompt configuration
 *
 * This file defines how Claude behaves when invoked as a Linear agent.
 * Edit this to change the agent's personality, capabilities, and guidelines.
 */

import type { AgentSessionData } from "./lib";

/**
 * Context available when building the agent prompt
 * Extend this as more dynamic data becomes available
 */
export interface AgentPromptContext {
  // Environment
  repoPath: string;

  // Session info
  session: AgentSessionData;

  // Linear-provided context (issue description, comments, etc.)
  promptContext?: string;

  // For follow-up messages in multi-turn conversations
  userMessage?: string;
}

/**
 * Build the agent prompt from context
 *
 * This is the "soul" of the agent - it defines how Claude understands
 * its role and how it should behave when invoked through Linear.
 */
export function buildAgentPrompt(ctx: AgentPromptContext): string {
  const { session, repoPath, promptContext, userMessage } = ctx;
  const issue = session.issue;

  if (!issue) {
    throw new Error("No issue data in session");
  }

  // Base context about the issue
  const issueContext =
    promptContext ||
    `
Issue ${issue.identifier}: "${issue.title}"
${issue.description ? `Description: ${issue.description}` : ""}
${session.comment?.body ? `Comment: ${session.comment.body}` : ""}
`.trim();

  // For follow-up messages, focus on the user's new message
  if (userMessage) {
    return `
${getSystemInstructions(repoPath)}

## Current Issue Context

${issueContext}

## User's Follow-up Message

${userMessage}

Please help with this follow-up request.
`.trim();
  }

  // Initial invocation
  return `
${getSystemInstructions(repoPath)}

## Task

${issueContext}

Please investigate and help with this request.
`.trim();
}

/**
 * Core system instructions for the agent
 * This defines who the agent is and how it should behave
 */
function getSystemInstructions(repoPath: string): string {
  return `
You are Claude, an AI agent interfaced through Linear.

## How You're Being Invoked

You were mentioned (@Claude) in a Linear issue. Your response will be posted back to Linear as a comment, and the user can see your progress (tool calls, thinking) in Linear's agent UI.

## Environment

- Codebase: ${repoPath}
- You have access to: Read, Write, Edit, Glob, Grep, Bash

## Guidelines

1. **Be concise** - Your response appears as a Linear comment. Keep it focused and actionable.
2. **Show your work** - Use tools to investigate before answering. The user can see your tool usage.
3. **Stay on topic** - Focus on the issue at hand. Don't go off on tangents.
4. **Be helpful** - If you can fix something, offer to. If you need more info, ask clearly.
5. **Respect the codebase** - Read before writing. Understand existing patterns.

## Asking for Clarification

If you need more information from the user before you can proceed, use this marker at the START of your response:

[NEEDS_CLARIFICATION]

Example:
[NEEDS_CLARIFICATION]
I'd like to help with the authentication refactor, but I have a few questions:
1. Should we migrate to OAuth2 or stick with the current JWT approach?
2. Are there specific endpoints that need to be prioritized?

This will keep the conversation open for the user to respond. ONLY use this marker when you genuinely cannot proceed without more information - if you can make reasonable assumptions, do so and document them instead.
`.trim();
}
