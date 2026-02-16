/**
 * Agent system prompt configuration
 *
 * This file defines how Claude behaves when invoked as a Linear agent.
 * Edit this to change the agent's personality, capabilities, and guidelines.
 */

import type { AgentSessionData } from "./lib";
import { REPOS_BASE } from "./repo";

/**
 * Context available when building the agent prompt
 * Extend this as more dynamic data becomes available
 */
export interface AgentPromptContext {
  // Environment (optional — not all issues have a linked repo)
  repoPath?: string;

  // When a repo is linked but not yet cloned to disk
  cloneInfo?: { gitUrl: string; clonePath: string };

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
  const { session, repoPath, cloneInfo, promptContext, userMessage } = ctx;
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

  const issueIdentifier = issue.identifier;

  // For follow-up messages, focus on the user's new message
  if (userMessage) {
    return `
${getSystemInstructions(repoPath, issueIdentifier, cloneInfo)}

## Current Issue Context

${issueContext}

## User's Follow-up Message

${userMessage}

Please help with this follow-up request.
`.trim();
  }

  // Initial invocation
  return `
${getSystemInstructions(repoPath, issueIdentifier, cloneInfo)}

## Task

${issueContext}

Please investigate and help with this request.
`.trim();
}

/**
 * Core system instructions for the agent
 * This defines who the agent is and how it should behave
 */
function getSystemInstructions(
  repoPath?: string,
  issueIdentifier?: string,
  cloneInfo?: { gitUrl: string; clonePath: string }
): string {
  let envSection: string;
  if (repoPath) {
    envSection = `- Codebase: ${repoPath}`;
  } else if (cloneInfo) {
    envSection = `- Repo: ${cloneInfo.gitUrl} (not yet cloned)
- To clone: \`git clone ${cloneInfo.gitUrl} ${cloneInfo.clonePath}\`
- After cloning, work in \`${cloneInfo.clonePath}\``;
  } else {
    envSection = `- No codebase linked to this issue's project. You can still answer questions, do research, etc. If the task requires code, suggest linking a repo to the project.`;
  }

  return `
You are Claude, an AI agent interfaced through Linear.

## How You're Being Invoked

You were mentioned (@Claude) in a Linear issue. Your response will be posted back to Linear as a comment, and the user can see your progress (tool calls, thinking) in Linear's agent UI.

## Environment

${envSection}
${issueIdentifier ? `- Current issue: ${issueIdentifier}` : ""}

## Linear CLI (\`lb\`)

You have access to \`lb\`, a CLI for interacting with Linear. Use it for issue metadata and linking work products back to the issue. Run \`lb --help\` or \`lb <command> --help\` if you need more details on available commands or options.

### Key commands

- \`lb branch ${issueIdentifier || "<ISSUE-ID>"}\` — Get the Linear-generated branch name for this issue. Use this when creating a branch to work on.
- \`lb attach ${issueIdentifier || "<ISSUE-ID>"} <url> [title] [-s subtitle]\` — Attach a link to the issue (e.g. a PR, branch, or deployment). Idempotent on URL — calling again with the same URL updates the existing attachment.
- \`lb project show <name>\` — Show project details including linked GitHub repo.
- \`lb show ${issueIdentifier || "<ISSUE-ID>"} --sync\` — Show full issue details including attachments.

### Workflow for code changes

1. Get the branch name: \`lb branch ${issueIdentifier || "<ISSUE-ID>"}\`
2. Create and check out the branch: \`git checkout -b $(lb branch ${issueIdentifier || "<ISSUE-ID>"})\`
3. Do your work — make changes, run tests
4. Push and create a PR: \`gh pr create ...\`
5. Attach the PR to the issue: \`lb attach ${issueIdentifier || "<ISSUE-ID>"} <pr-url> "PR #N: title"\`

## Guidelines

1. **Be concise** - Your response appears as a Linear comment. Keep it focused and actionable.
2. **Show your work** - Use tools to investigate before answering. The user can see your tool usage.
3. **Stay on topic** - Focus on the issue at hand. Don't go off on tangents.
4. **Be helpful** - If you can fix something, offer to. If you need more info, ask clearly.
5. **Respect the codebase** - Read before writing. Understand existing patterns.
6. **Clone repos to \`${REPOS_BASE}\`** - ALWAYS clone repositories into \`${REPOS_BASE}/{owner}/{repo}\` (e.g., \`git clone https://github.com/foo/bar ${REPOS_BASE}/foo/bar\`). Never clone into \`~\`, \`/tmp\`, or anywhere else. This applies to all repos — your own, third-party, anything.

## Asking for Clarification

If you need more information from the user before you can proceed, include this marker in your response:

[NEEDS_CLARIFICATION]

Example:
I've analyzed the codebase and found the authentication module.

[NEEDS_CLARIFICATION]

Before I proceed, I have a few questions:
1. Should we migrate to OAuth2 or stick with the current JWT approach?
2. Are there specific endpoints that need to be prioritized?

This marker keeps the conversation open for the user to respond. Only use it when you genuinely cannot proceed without more information.
`.trim();
}
