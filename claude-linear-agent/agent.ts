/**
 * Agent execution
 *
 * Runs Claude Code via the agent SDK and streams activities back to Linear.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { dirname, join } from "path";
import { log } from "./logger";
import { emitActivity } from "./linear-api";
import { resolveRepoCwd } from "./repo";
import { buildAgentPrompt } from "./agent-prompt";
import { parseForClarification, type AgentSessionData } from "./lib";

/**
 * Disk-persisted mapping of Linear session ID → Claude Code session ID.
 * Survives server restarts so multi-turn resumption works across deploys.
 */
export class SessionStore {
  private path: string;
  private cache: Record<string, string> | null = null;

  constructor(path: string) {
    this.path = path;
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = {};
      return this.cache;
    }
    try {
      this.cache = JSON.parse(readFileSync(this.path, "utf-8"));
      if (typeof this.cache !== "object" || this.cache === null || Array.isArray(this.cache)) {
        throw new Error("Invalid session map format");
      }
    } catch (err) {
      log("warn", "Corrupt or unreadable session map, starting empty", {
        path: this.path,
        error: err instanceof Error ? err.message : String(err),
      });
      this.cache = {};
    }
    return this.cache!;
  }

  get(linearSessionId: string): string | undefined {
    return this.load()[linearSessionId];
  }

  set(linearSessionId: string, claudeSessionId: string): void {
    const data = this.load();
    data[linearSessionId] = claudeSessionId;
    this.write(data);
  }

  delete(linearSessionId: string): void {
    const data = this.load();
    if (linearSessionId in data) {
      delete data[linearSessionId];
      this.write(data);
    }
  }

  private write(data: Record<string, string>): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = this.path + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.path);
  }
}

const defaultSessionStorePath = join(
  dirname(new URL(import.meta.url).pathname),
  "data",
  "session-map.json"
);
const sessionStore = new SessionStore(defaultSessionStorePath);

// Sanitize @mentions to prevent self-triggering loops
// AIDEV-NOTE: Critical for preventing infinite webhook loops - if agent response
// contains @claude, Linear may interpret it as a new mention and create another session
export function sanitizeMentions(text: string): string {
  // Replace @claude (case insensitive) with just "Claude"
  // Also handle any @mentions to be safe
  return text.replace(/@claude/gi, "Claude").replace(/@(\w+)/g, "$1");
}

/**
 * Run Claude Agent on an issue
 * For prompted events (follow-ups), userMessage contains the user's new message
 * AIDEV-NOTE: abortController is used to cancel the agent when user clicks stop in Linear
 */
export async function runAgent(
  session: AgentSessionData,
  promptContext?: string,
  userMessage?: string,
  abortController?: AbortController
): Promise<void> {
  const startTime = Date.now();
  const issue = session.issue;
  if (!issue) {
    log("error", "No issue data in session", { sessionId: session.id });
    return;
  }

  // CRITICAL: Emit activity immediately to avoid "unresponsive" status (must be within 10s)
  const activityMessage = userMessage
    ? `Processing follow-up message...`
    : `Analyzing issue ${issue.identifier}...`;
  await emitActivity(session.id, {
    type: "thought",
    body: activityMessage,
  }); // persistent - keeping all events for granular tracking

  // Resolve working directory from project context
  const { cwd, repoPath, cloneInfo } = await resolveRepoCwd(session.issueId);

  // Check if we can resume a previous Claude Code session for this Linear session
  const existingClaudeSessionId = userMessage ? sessionStore.get(session.id) : undefined;

  // Build prompt: if resuming, just send the user's message (session has full history).
  // If not resuming (or initial), build the full prompt with system instructions + context.
  const prompt = existingClaudeSessionId
    ? userMessage!
    : buildAgentPrompt({
        repoPath,
        cloneInfo,
        session,
        promptContext,
        userMessage,
      });

  log("info", "Starting agent run", {
    sessionId: session.id,
    issueIdentifier: issue.identifier,
    promptLength: prompt.length,
    isFollowUp: !!userMessage,
    resumingSession: existingClaudeSessionId || false,
    cwd,
  });

  try {
    let responseText = "";

    const baseOptions = {
      cwd,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      tools: { type: "preset" as const, preset: "claude_code" as const },
      includePartialMessages: false,
      abortController,
    };

    const queryOptions = existingClaudeSessionId
      ? { ...baseOptions, resume: existingClaudeSessionId }
      : baseOptions;
    const iterator = query({ prompt, options: queryOptions });

    // Track stats for summary
    let turnCount = 0;
    let toolsUsed: string[] = [];
    let filesAccessed: string[] = [];
    let lastToolUseId: string | undefined;
    let claudeSessionCaptured = false;

    for await (const message of iterator) {
      // Capture the Claude Code session ID from the first message for future resumption
      if (!claudeSessionCaptured && "session_id" in message && message.session_id) {
        sessionStore.set(session.id, message.session_id as string);
        claudeSessionCaptured = true;
        log("info", "Captured Claude session for resumption", {
          linearSessionId: session.id,
          claudeSessionId: message.session_id,
        });
      }

      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            responseText = block.text;
            // Emit intermediate thinking for long text (helps show progress)
            if (block.text.length > 100) {
              const thoughtPreview = block.text.slice(0, 150).replace(/\n/g, " ");
              await emitActivity(session.id, {
                type: "thought",
                body: `${thoughtPreview}...`,
              }); // persistent - keeping all events for granular tracking
            }
          } else if (block.type === "tool_use") {
            lastToolUseId = block.id;
            turnCount++;
            if (!toolsUsed.includes(block.name)) {
              toolsUsed.push(block.name);
            }

            // Extract meaningful info from tool input
            const input = block.input as Record<string, unknown>;
            let parameter = "";
            let contextInfo = "";

            switch (block.name) {
              case "Read":
                parameter = String(input.file_path || "").slice(-60);
                if (parameter && !filesAccessed.includes(parameter)) {
                  filesAccessed.push(parameter);
                }
                contextInfo = `Reading ${parameter}`;
                break;
              case "Write":
              case "Edit":
                parameter = String(input.file_path || "").slice(-60);
                if (parameter && !filesAccessed.includes(parameter)) {
                  filesAccessed.push(parameter);
                }
                contextInfo = `${block.name === "Write" ? "Writing" : "Editing"} ${parameter}`;
                break;
              case "Glob":
                parameter = String(input.pattern || "");
                contextInfo = `Searching for files: ${parameter}`;
                break;
              case "Grep":
                parameter = String(input.pattern || "").slice(0, 40);
                contextInfo = `Searching content: "${parameter}"`;
                break;
              case "Bash":
                parameter = String(input.command || "").slice(0, 60);
                contextInfo = `Running: ${parameter}`;
                break;
              default:
                parameter = JSON.stringify(input).slice(0, 80);
                contextInfo = `${block.name}: ${parameter}`;
            }

            log("info", "Tool use", {
              sessionId: session.id,
              tool: block.name,
              context: contextInfo,
              turn: turnCount,
            });

            // Emit detailed action activity
            await emitActivity(session.id, {
              type: "action",
              action: block.name,
              parameter: contextInfo,
            });
          }
        }
      } else if (message.type === "user") {
        // Handle tool results - emit result feedback
        const toolResult = message.tool_use_result as
          | { output?: string; error?: string }
          | undefined;
        if (toolResult && lastToolUseId) {
          const isError = !!toolResult.error;
          const resultText = toolResult.error || toolResult.output || "";

          // Emit a brief result summary
          if (resultText) {
            const preview = resultText.slice(0, 200).replace(/\n/g, " ");
            const resultSummary = isError
              ? `Error: ${preview}`
              : preview.length > 150
                ? `${preview.slice(0, 150)}...`
                : preview;

            await emitActivity(session.id, {
              type: "thought",
              body: isError ? `❌ ${resultSummary}` : `✓ ${resultSummary}`,
            }); // persistent - keeping all events for granular tracking
          }
          lastToolUseId = undefined;
        }
      } else if (message.type === "result") {
        // Emit completion summary with stats
        const stats = {
          turns:
            message.subtype === "success"
              ? (message as { num_turns?: number }).num_turns
              : turnCount,
          cost:
            message.subtype === "success"
              ? (message as { total_cost_usd?: number }).total_cost_usd
              : undefined,
          tools: toolsUsed,
          files: filesAccessed.length,
        };

        log("info", "Agent run completed", {
          sessionId: session.id,
          subtype: message.subtype,
          durationMs: Date.now() - startTime,
          ...stats,
        });

        // Emit summary thought before final response
        if (stats.turns && stats.turns > 1) {
          const summaryParts = [];
          summaryParts.push(`Completed in ${stats.turns} steps`);
          if (stats.tools.length > 0) {
            summaryParts.push(`used ${stats.tools.join(", ")}`);
          }
          if (stats.files > 0) {
            summaryParts.push(`touched ${stats.files} file${stats.files > 1 ? "s" : ""}`);
          }
          if (stats.cost) {
            summaryParts.push(`cost: $${stats.cost.toFixed(4)}`);
          }

          await emitActivity(session.id, {
            type: "thought",
            body: `📊 ${summaryParts.join(" | ")}`,
          }); // persistent - keep as part of session history
        }
      }
    }

    // Emit final activity - either response (complete) or elicitation (awaiting input)
    // AIDEV-NOTE: Linear auto-creates a comment from response activities, so we don't need postComment()
    // Removed postComment() to avoid duplicate comments and reduce self-trigger risk
    // AIDEV-NOTE: The response activity is what tells Linear to transition session to "complete" state
    // The elicitation activity keeps session in "awaitingInput" state for user reply
    // If this fails, Linear will show indefinite loading state (see GENT-1019)
    if (responseText) {
      // Check if agent is asking for clarification
      const { needsClarification, cleanedText } = parseForClarification(responseText);
      const activityType = needsClarification ? "elicitation" : "response";
      const sanitized = sanitizeMentions(cleanedText.slice(0, 2000));

      const responseSuccess = await emitActivity(session.id, {
        type: activityType,
        body: sanitized,
      });
      log(responseSuccess ? "info" : "error", `Final ${activityType} activity emitted`, {
        sessionId: session.id,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        responseLength: sanitized.length,
        activityType,
        needsClarification,
        success: responseSuccess,
      });

      // If the activity failed, try once more
      if (!responseSuccess) {
        log("warn", `Retrying final ${activityType} activity`, { sessionId: session.id });
        const retrySuccess = await emitActivity(session.id, {
          type: activityType,
          body: sanitized,
        });
        log(retrySuccess ? "info" : "error", `Final ${activityType} retry result`, {
          sessionId: session.id,
          success: retrySuccess,
        });
      }
    } else {
      const fallback =
        "I looked into this but couldn't formulate a response. Please try rephrasing your request.";
      const fallbackSuccess = await emitActivity(session.id, { type: "response", body: fallback });
      log("warn", "Agent completed with fallback response", {
        sessionId: session.id,
        issueId: issue.id,
        success: fallbackSuccess,
      });
    }
  } catch (error) {
    // If we were trying to resume, clear the stale mapping so the next
    // follow-up starts a fresh session instead of retrying the same broken resume
    if (existingClaudeSessionId) {
      sessionStore.delete(session.id);
      log("warn", "Cleared stale session mapping after resume failure", {
        linearSessionId: session.id,
        claudeSessionId: existingClaudeSessionId,
      });
    }
    const errorMsg = `I encountered an error: ${error instanceof Error ? error.message : "Unknown error"}`;
    await emitActivity(session.id, { type: "error", body: sanitizeMentions(errorMsg) });
    log("error", "Agent failed with error", {
      sessionId: session.id,
      issueId: issue.id,
      durationMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
