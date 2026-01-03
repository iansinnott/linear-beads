import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const prompt = process.argv.slice(2).join(" ");

if (!prompt) {
  console.log("Usage: bun run agent 'your prompt here'");
  console.log("Example: bun run agent 'List the files in the current directory'");
  process.exit(1);
}

console.log(`\n🤖 Running agent with prompt: "${prompt}"\n`);
console.log("─".repeat(60));

async function runAgent() {
  const iterator = query({
    prompt,
    options: {
      // Use bypassPermissions for the demo - in production you'd want proper permission handling
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Limit tools for safety in this demo
      tools: ["Read", "Glob", "Grep", "Bash"],
      // Include streaming for real-time output
      includePartialMessages: false,
    },
  });

  for await (const message of iterator) {
    handleMessage(message);
  }
}

function handleMessage(message: SDKMessage) {
  switch (message.type) {
    case "system":
      if (message.subtype === "init") {
        console.log(`📦 Session: ${message.session_id}`);
        console.log(`🔧 Tools: ${message.tools.join(", ")}`);
        console.log(`🤖 Model: ${message.model}`);
        console.log("─".repeat(60));
      }
      break;

    case "assistant":
      // Extract text and tool use from the message
      for (const block of message.message.content) {
        if (block.type === "text") {
          console.log(`\n💬 ${block.text}`);
        } else if (block.type === "tool_use") {
          console.log(`\n🔨 Tool: ${block.name}`);
          console.log(`   Input: ${JSON.stringify(block.input, null, 2).split("\n").join("\n   ")}`);
        }
      }
      break;

    case "user":
      // Tool results come back as user messages
      if (message.tool_use_result !== undefined) {
        const resultObj = message.tool_use_result as { output?: string; error?: string };
        const result = resultObj.error || resultObj.output || JSON.stringify(message.tool_use_result);
        const lines = result.split("\n").slice(0, 8);
        const truncated = lines.join("\n").slice(0, 400);
        console.log(`   Result: ${truncated.split("\n").join("\n   ")}${result.length > 400 ? "..." : ""}`);
      }
      break;

    case "result":
      console.log("\n" + "─".repeat(60));
      if (message.subtype === "success") {
        console.log(`✅ Completed in ${message.num_turns} turns`);
        console.log(`💰 Cost: $${message.total_cost_usd.toFixed(4)}`);
        console.log(`📊 Tokens: ${message.usage.input_tokens} in / ${message.usage.output_tokens} out`);
      } else {
        console.log(`❌ Error: ${message.subtype}`);
        if ("errors" in message) {
          console.log(`   ${message.errors.join("\n   ")}`);
        }
      }
      break;
  }
}

runAgent().catch((err) => {
  console.error("Agent error:", err);
  process.exit(1);
});
