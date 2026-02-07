#!/usr/bin/env bun
/**
 * Combined dev server script
 * Runs both the agent server and ngrok tunnel with combined, prefixed output.
 *
 * Logs to tmp/dev.log by default (use --no-log to disable).
 */

import { spawn } from "child_process";
import { mkdirSync, createWriteStream, type WriteStream } from "fs";
import { dirname, resolve } from "path";

const NGROK_DOMAIN = "fumelike-scourgingly-shalon.ngrok-free.dev";
const PORT = process.env.PORT || "3000";
const LOG_FILE = resolve(import.meta.dir, "../tmp/dev.log");

// Parse args
const args = process.argv.slice(2);
const enableLog = !args.includes("--no-log");

// ANSI colors for prefixing
const COLORS = {
  server: "\x1b[36m", // cyan
  ngrok: "\x1b[33m", // yellow
  reset: "\x1b[0m",
};

// Strip ANSI codes for log file
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// Set up log file
let logStream: WriteStream | null = null;
if (enableLog) {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  logStream = createWriteStream(LOG_FILE, { flags: "w" });
  logStream.write(`=== Dev server started at ${new Date().toISOString()} ===\n\n`);
}

function output(prefix: string, color: string, data: Buffer) {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    if (line.trim()) {
      const formatted = `${color}[${prefix}]${COLORS.reset} ${line}`;
      console.log(formatted);
      if (logStream) {
        logStream.write(`[${prefix}] ${stripAnsi(line)}\n`);
      }
    }
  }
}

console.log(`\n🚀 Starting dev environment...\n`);
console.log(`   Server: http://localhost:${PORT}`);
console.log(`   Tunnel: https://${NGROK_DOMAIN}`);
console.log(`   Ngrok UI: http://localhost:4040/inspect/http`);
if (enableLog) {
  console.log(`   Log file: ${LOG_FILE}`);
}
console.log();

// Start the agent server
const server = spawn("bun", ["run", "server.ts"], {
  cwd: import.meta.dir + "/..",
  env: { ...process.env, PORT },
});

server.stdout.on("data", (data) => output("server", COLORS.server, data));
server.stderr.on("data", (data) => output("server", COLORS.server, data));

// Start ngrok with logging
const ngrok = spawn("ngrok", ["http", PORT, `--domain=${NGROK_DOMAIN}`, "--log=stdout", "--log-format=term"], {
  env: { ...process.env },
});

ngrok.stdout.on("data", (data) => output("ngrok", COLORS.ngrok, data));
ngrok.stderr.on("data", (data) => output("ngrok", COLORS.ngrok, data));

// Handle process exit
function cleanup() {
  console.log("\n🛑 Shutting down...");
  if (logStream) {
    logStream.write(`\n=== Dev server stopped at ${new Date().toISOString()} ===\n`);
    logStream.close();
  }
  server.kill();
  ngrok.kill();
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// Exit if either process dies
server.on("exit", (code) => {
  console.log(`\n❌ Server exited with code ${code}`);
  ngrok.kill();
  process.exit(code || 1);
});

ngrok.on("exit", (code) => {
  console.log(`\n❌ ngrok exited with code ${code}`);
  server.kill();
  process.exit(code || 1);
});
