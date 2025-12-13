/**
 * Spawn background sync worker if not already running
 */

import { spawn } from "child_process";
import { isWorkerRunning } from "./pid-manager.js";

/**
 * Spawn background sync worker if needed
 * Returns true if spawned, false if already running
 */
export function spawnWorkerIfNeeded(): boolean {
  // Check if worker already running
  if (isWorkerRunning()) {
    return false;
  }

  try {
    // Detect if we're running as a compiled binary or via bun run
    const execPath = process.execPath;
    const isCompiled = execPath.endsWith("/lb") || execPath.endsWith("\\lb.exe");

    let cmd: string;
    let args: string[];

    if (isCompiled) {
      // Compiled binary: just run with --worker
      cmd = execPath;
      args = ["--worker"];
    } else {
      // Dev mode: need to run bun with the script
      // import.meta.path gives us the current file, we need cli.ts
      const cliPath = import.meta.path.replace(/spawn-worker\.[tj]s$/, "../cli.ts");
      cmd = execPath;
      args = ["run", cliPath, "--worker"];
    }

    const worker = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      cwd: process.cwd(),
    });

    // Unref so parent can exit
    worker.unref();

    return true;
  } catch (error) {
    // Log but don't fail - user can manually sync
    console.error("Warning: Failed to spawn background sync worker:", error);
    return false;
  }
}
