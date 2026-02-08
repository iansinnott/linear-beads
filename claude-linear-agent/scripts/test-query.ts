#!/usr/bin/env bun
/**
 * Test the Claude agent SDK query() iterator in isolation.
 * Usage: bun run test-query "your prompt here"
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

const prompt = process.argv[2] || "Say hello in one sentence.";
const cwd = process.env.REPO_PATH || process.cwd();

console.log(`Prompt: "${prompt}"`);
console.log(`CWD: ${cwd}`);
console.log("Starting query()...\n");

try {
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

  let messageCount = 0;

  for await (const message of iterator) {
    messageCount++;
    console.log(`[${messageCount}] type=${message.type}${message.type === "result" ? ` subtype=${(message as any).subtype}` : ""}`);

    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          console.log(`  text: ${block.text.slice(0, 200)}`);
        } else if (block.type === "tool_use") {
          console.log(`  tool: ${block.name} — ${JSON.stringify(block.input).slice(0, 100)}`);
        }
      }
    } else if (message.type === "result") {
      const r = message as any;
      console.log(`  turns: ${r.num_turns}, cost: $${r.total_cost_usd?.toFixed(4)}`);
    }
  }

  console.log(`\nDone. ${messageCount} messages received.`);
} catch (err) {
  console.error("query() threw:", err instanceof Error ? err.message : err);
  process.exit(1);
}
