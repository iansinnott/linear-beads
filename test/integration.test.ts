/**
 * Integration tests for lb CLI
 * 
 * Requires:
 * - LINEAR_API_KEY environment variable
 * - LB_TEAM_KEY environment variable (or uses LIN as default)
 * 
 * Run with: bun test test/integration.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";

// Increase timeout for API calls
setDefaultTimeout(30000);

const TEAM_KEY = process.env.LB_TEAM_KEY || "LIN";
const TEST_PREFIX = `[test-${Date.now()}]`;

// Helper to run lb commands
async function lb(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, LB_TEAM_KEY: TEAM_KEY },
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  
  return { stdout, stderr, exitCode };
}

// Helper to run lb and parse JSON output
async function lbJson<T>(...args: string[]): Promise<T> {
  const result = await lb(...args, "--json");
  if (result.exitCode !== 0) {
    throw new Error(`lb ${args.join(" ")} failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

describe("lb CLI Integration Tests", () => {
  
  beforeAll(async () => {
    // Verify API key is set
    if (!process.env.LINEAR_API_KEY) {
      throw new Error("LINEAR_API_KEY environment variable is required");
    }
  });

  afterAll(async () => {
    // Get all issues with our test prefix
    await lb("sync"); // refresh cache
    const allIssues = await lbJson<Array<{ id: string; title: string; status: string }>>("list");
    
    // Close all test issues that aren't already closed
    for (const issue of allIssues) {
      if (issue.title.includes(TEST_PREFIX) && issue.status !== "closed") {
        try {
          await lb("close", issue.id, "--reason", "Integration test cleanup");
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  });

  describe("whoami", () => {
    test("should authenticate and return user info", async () => {
      const result = await lbJson<{
        userId: string;
        userName: string;
        teams: Array<{ id: string; key: string; name: string }>;
      }>("whoami");

      expect(result.userId).toBeDefined();
      expect(result.userName).toBeDefined();
      expect(Array.isArray(result.teams)).toBe(true);
      expect(result.teams.length).toBeGreaterThan(0);
    });

    test("should include configured team", async () => {
      const result = await lbJson<{
        teams: Array<{ key: string }>;
      }>("whoami");

      const teamKeys = result.teams.map(t => t.key);
      expect(teamKeys).toContain(TEAM_KEY);
    });
  });

  describe("create", () => {
    test("should create issue and sync immediately", async () => {
      const title = `${TEST_PREFIX} Create test`;
      const result = await lbJson<Array<{
        id: string;
        title: string;
        status: string;
        priority: number;
        issue_type: string;
      }>>("create", title, "-t", "task", "-p", "2");

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);
      expect(result[0].id).toMatch(/^[A-Z]+-\d+$/);
      expect(result[0].title).toBe(title);
      expect(result[0].status).toBe("open");
      expect(result[0].priority).toBe(2);
      expect(result[0].issue_type).toBe("task");
    });

    test("should support bug type", async () => {
      const title = `${TEST_PREFIX} Type test: bug`;
      const result = await lbJson<Array<{
        id: string;
        issue_type: string;
      }>>("create", title, "-t", "bug");

      expect(result[0].issue_type).toBe("bug");
    });

    test("should support feature type", async () => {
      const title = `${TEST_PREFIX} Type test: feature`;
      const result = await lbJson<Array<{
        id: string;
        issue_type: string;
      }>>("create", title, "-t", "feature");

      expect(result[0].issue_type).toBe("feature");
    });

    test("should support priority 0 (critical)", async () => {
      const title = `${TEST_PREFIX} Priority test: 0`;
      const result = await lbJson<Array<{
        id: string;
        priority: number;
      }>>("create", title, "-p", "0");

      expect(result[0].priority).toBe(0);
    });

    test("should support priority 4 (backlog)", async () => {
      const title = `${TEST_PREFIX} Priority test: 4`;
      const result = await lbJson<Array<{
        id: string;
        priority: number;
      }>>("create", title, "-p", "4");

      expect(result[0].priority).toBe(4);
    });
  });

  describe("list", () => {
    test("should return array of issues", async () => {
      // Ensure we have at least one issue
      await lbJson<Array<{ id: string }>>(
        "create", `${TEST_PREFIX} List test`
      );

      // Sync to refresh cache
      await lb("sync");

      const result = await lbJson<Array<{
        id: string;
        title: string;
        status: string;
        priority: number;
        issue_type: string;
        dependency_count: number;
        dependent_count: number;
      }>>("list");

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);

      // Check structure of first issue
      const issue = result[0];
      expect(issue.id).toBeDefined();
      expect(issue.title).toBeDefined();
      expect(issue.status).toBeDefined();
      expect(typeof issue.priority).toBe("number");
      expect(typeof issue.dependency_count).toBe("number");
      expect(typeof issue.dependent_count).toBe("number");
    });

    test("should filter by status", async () => {
      const result = await lbJson<Array<{ status: string }>>("list", "-s", "open");
      
      for (const issue of result) {
        expect(issue.status).toBe("open");
      }
    });
  });

  describe("ready", () => {
    test("should return only open unblocked issues", async () => {
      const result = await lbJson<Array<{
        id: string;
        status: string;
        dependencies: Array<unknown>;
      }>>("ready");

      expect(Array.isArray(result)).toBe(true);

      for (const issue of result) {
        expect(issue.status).toBe("open");
        expect(Array.isArray(issue.dependencies)).toBe(true);
      }
    });
  });

  describe("update", () => {
    test("should update issue status", async () => {
      // Create an issue first
      const createResult = await lbJson<Array<{ id: string }>>(
        "create", `${TEST_PREFIX} Update test`
      );
      const issueId = createResult[0].id;

      // Update to in_progress
      const updateResult = await lbJson<Array<{
        id: string;
        status: string;
      }>>("update", issueId, "-s", "in_progress");

      expect(updateResult[0].id).toBe(issueId);
      expect(updateResult[0].status).toBe("in_progress");
    });

    test("should update issue priority", async () => {
      // Create an issue first
      const createResult = await lbJson<Array<{ id: string }>>(
        "create", `${TEST_PREFIX} Priority update test`, "-p", "3"
      );
      const issueId = createResult[0].id;

      // Update priority
      const updateResult = await lbJson<Array<{
        id: string;
        priority: number;
      }>>("update", issueId, "-p", "1");

      expect(updateResult[0].priority).toBe(1);
    });
  });

  describe("close", () => {
    test("should close issue with reason", async () => {
      // Create an issue first
      const createResult = await lbJson<Array<{ id: string }>>(
        "create", `${TEST_PREFIX} Close test`
      );
      const issueId = createResult[0].id;

      // Close it
      const closeResult = await lbJson<Array<{
        id: string;
        status: string;
        closed_at: string;
      }>>("close", issueId, "-r", "Test complete");

      expect(closeResult[0].id).toBe(issueId);
      expect(closeResult[0].status).toBe("closed");
      expect(closeResult[0].closed_at).toBeDefined();
    });
  });

  describe("show", () => {
    test("should show issue details", async () => {
      // Create an issue first
      const createResult = await lbJson<Array<{ id: string }>>(
        "create", `${TEST_PREFIX} Show test`, "-d", "Test description"
      );
      const issueId = createResult[0].id;

      // Sync to ensure it's in cache
      await lb("sync");

      // Show it
      const showResult = await lbJson<Array<{
        id: string;
        title: string;
        description: string;
      }>>("show", issueId);

      expect(showResult[0].id).toBe(issueId);
      expect(showResult[0].title).toContain("Show test");
    });
  });

  describe("JSON output format (bd compatibility)", () => {
    test("should use snake_case keys", async () => {
      const result = await lbJson<Array<Record<string, unknown>>>("list");
      
      if (result.length > 0) {
        const issue = result[0];
        expect("issue_type" in issue).toBe(true);
        expect("created_at" in issue).toBe(true);
        expect("updated_at" in issue).toBe(true);
        expect("dependency_count" in issue).toBe(true);
        expect("dependent_count" in issue).toBe(true);
      }
    });

    test("should always return arrays", async () => {
      // list returns array
      const listResult = await lbJson<unknown>("list");
      expect(Array.isArray(listResult)).toBe(true);

      // ready returns array
      const readyResult = await lbJson<unknown>("ready");
      expect(Array.isArray(readyResult)).toBe(true);

      // show returns array (even for single issue)
      const createResult = await lbJson<Array<{ id: string }>>(
        "create", `${TEST_PREFIX} Array test`
      );
      
      await lb("sync");
      
      const showResult = await lbJson<unknown>("show", createResult[0].id);
      expect(Array.isArray(showResult)).toBe(true);
    });
  });
});
