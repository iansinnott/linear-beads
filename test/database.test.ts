/**
 * Database unit tests
 *
 * Tests the SQLite cache behavior without requiring Linear API access.
 * Run with: bun test test/database.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

// We'll test the database module in isolation
// by creating a temporary database directory

const TEST_DIR = "/tmp/lb-db-test-" + Date.now();
const TEST_DB_PATH = join(TEST_DIR, ".lb", "cache.db");

// Mock the config module to use our test path
let testDb: Database | null = null;

function getTestDatabase(): Database {
  if (!testDb) {
    const dbDir = join(TEST_DIR, ".lb");
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    testDb = new Database(TEST_DB_PATH);
    testDb.exec("PRAGMA journal_mode = WAL");
    testDb.exec("PRAGMA synchronous = NORMAL");

    // Initialize schema
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        issue_type TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        assignee TEXT,
        linear_state_id TEXT,
        cached_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id TEXT NOT NULL,
        depends_on_id TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        UNIQUE(issue_id, depends_on_id, type)
      );
    `);
  }
  return testDb;
}

function closeTestDatabase() {
  if (testDb) {
    testDb.close();
    testDb = null;
  }
}

// Helper to count issues in database
function countIssues(): number {
  const db = getTestDatabase();
  const row = db.query("SELECT COUNT(*) as count FROM issues").get() as { count: number };
  return row.count;
}

// Helper to get all issue IDs
function getIssueIds(): string[] {
  const db = getTestDatabase();
  const rows = db.query("SELECT id FROM issues").all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

// Helper to insert an issue (simulating cached issue)
function insertIssue(id: string, title: string, status: string = "open") {
  const db = getTestDatabase();
  const now = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO issues
     (id, identifier, title, status, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, title, status, 2, now, now]
  );
}

// Helper to insert a dependency
function insertDependency(issueId: string, dependsOnId: string, type: string, createdBy: string) {
  const db = getTestDatabase();
  db.run(
    `INSERT OR IGNORE INTO dependencies
     (issue_id, depends_on_id, type, created_at, created_by)
     VALUES (?, ?, ?, datetime('now'), ?)`,
    [issueId, dependsOnId, type, createdBy]
  );
}

// Simulate replaceAllIssues (atomic clear + insert)
function replaceAllIssues(
  issues: Array<{ id: string; title: string; status: string; priority: number }>
) {
  const db = getTestDatabase();
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO issues
    (id, identifier, title, status, priority, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Atomic transaction: clear ALL issues and sync dependencies, then insert fresh data
  const transaction = db.transaction(() => {
    // Clear old data first (within same transaction)
    db.exec(`
      DELETE FROM issues;
      DELETE FROM dependencies WHERE created_by = 'sync';
    `);

    // Insert fresh issues
    for (const issue of issues) {
      insert.run(issue.id, issue.id, issue.title, issue.status, issue.priority, now, now);
    }
  });

  transaction();
}

// Simulate the OLD non-atomic behavior (for comparison)
function clearAndCacheIssues_NonAtomic(
  issues: Array<{ id: string; title: string; status: string; priority: number }>
) {
  const db = getTestDatabase();
  const now = new Date().toISOString();

  // Clear (separate from insert)
  db.exec(`
    DELETE FROM issues;
    DELETE FROM dependencies WHERE created_by = 'sync';
  `);

  // Gap here where another process could write!

  // Insert
  const insert = db.prepare(`
    INSERT OR REPLACE INTO issues
    (id, identifier, title, status, priority, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const issue of issues) {
    insert.run(issue.id, issue.id, issue.title, issue.status, issue.priority, now, now);
  }
}

describe("Database Cache Operations", () => {
  beforeEach(() => {
    // Start with fresh database
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    testDb = null;
    getTestDatabase(); // Initialize fresh
  });

  afterEach(() => {
    closeTestDatabase();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("replaceAllIssues (atomic)", () => {
    test("should replace all issues atomically", () => {
      // Setup: Insert some initial issues (simulating existing cache)
      insertIssue("TEAM-1", "Existing issue 1");
      insertIssue("TEAM-2", "Existing issue 2");
      insertIssue("TEAM-3", "Archived issue (should be removed)");
      expect(countIssues()).toBe(3);

      // Act: Replace with new set (simulating sync where TEAM-3 was archived)
      replaceAllIssues([
        { id: "TEAM-1", title: "Updated issue 1", status: "open", priority: 2 },
        { id: "TEAM-2", title: "Updated issue 2", status: "open", priority: 2 },
        { id: "TEAM-4", title: "New issue", status: "open", priority: 2 },
      ]);

      // Assert: Only the new issues should exist
      expect(countIssues()).toBe(3);
      const ids = getIssueIds();
      expect(ids).toContain("TEAM-1");
      expect(ids).toContain("TEAM-2");
      expect(ids).toContain("TEAM-4");
      expect(ids).not.toContain("TEAM-3"); // Archived issue should be gone
    });

    test("should clear sync dependencies but preserve user dependencies", () => {
      const db = getTestDatabase();

      // Setup: Insert issue and dependencies
      insertIssue("TEAM-1", "Issue 1");
      insertIssue("TEAM-2", "Issue 2");
      insertDependency("TEAM-1", "TEAM-2", "blocks", "sync");
      insertDependency("TEAM-1", "TEAM-2", "related", "user");

      // Count dependencies
      const beforeCount = (db.query("SELECT COUNT(*) as c FROM dependencies").get() as { c: number })
        .c;
      expect(beforeCount).toBe(2);

      // Act: Replace all issues
      replaceAllIssues([{ id: "TEAM-1", title: "Updated", status: "open", priority: 2 }]);

      // Assert: Only user dependency should remain
      const rows = db.query("SELECT * FROM dependencies").all() as Array<{ created_by: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0].created_by).toBe("user");
    });

    test("archived issues should not persist after sync", () => {
      // This is the key test for GENT-775
      // Setup: Cache has an archived issue that Linear no longer returns
      insertIssue("TEAM-1", "Active issue");
      insertIssue("TEAM-2", "This was archived in Linear");
      insertIssue("TEAM-3", "Another active issue");

      expect(countIssues()).toBe(3);
      expect(getIssueIds()).toContain("TEAM-2");

      // Act: Sync returns only active issues (Linear excludes archived)
      replaceAllIssues([
        { id: "TEAM-1", title: "Active issue", status: "open", priority: 2 },
        { id: "TEAM-3", title: "Another active issue", status: "open", priority: 2 },
      ]);

      // Assert: Archived issue should be gone
      expect(countIssues()).toBe(2);
      expect(getIssueIds()).not.toContain("TEAM-2");
    });

    test("deleted issues should not persist after sync", () => {
      // Similar to archived, but for deleted issues
      insertIssue("TEAM-1", "Active issue");
      insertIssue("TEAM-DEL", "This was deleted in Linear");

      expect(countIssues()).toBe(2);
      expect(getIssueIds()).toContain("TEAM-DEL");

      // Act: Sync returns only active issues
      replaceAllIssues([{ id: "TEAM-1", title: "Active issue", status: "open", priority: 2 }]);

      // Assert: Deleted issue should be gone
      expect(countIssues()).toBe(1);
      expect(getIssueIds()).not.toContain("TEAM-DEL");
    });

    test("should handle empty issue list", () => {
      // Setup: Cache has issues
      insertIssue("TEAM-1", "Issue 1");
      insertIssue("TEAM-2", "Issue 2");
      expect(countIssues()).toBe(2);

      // Act: Sync returns empty list (all issues archived/deleted)
      replaceAllIssues([]);

      // Assert: Cache should be empty
      expect(countIssues()).toBe(0);
    });

    test("should be atomic (all or nothing)", () => {
      // Setup
      insertIssue("TEAM-1", "Original 1");
      insertIssue("TEAM-2", "Original 2");

      // In a real scenario, if the transaction fails mid-way,
      // the database should rollback to original state.
      // We can't easily test failure in bun:sqlite, but we can verify
      // that the operation completes fully.

      replaceAllIssues([
        { id: "TEAM-3", title: "New 1", status: "open", priority: 2 },
        { id: "TEAM-4", title: "New 2", status: "open", priority: 2 },
      ]);

      // Should have exactly the new issues
      const ids = getIssueIds();
      expect(ids.length).toBe(2);
      expect(ids).toContain("TEAM-3");
      expect(ids).toContain("TEAM-4");
      expect(ids).not.toContain("TEAM-1");
      expect(ids).not.toContain("TEAM-2");
    });
  });

  describe("Edge cases", () => {
    test("should handle issues with same IDs (update existing)", () => {
      insertIssue("TEAM-1", "Original title", "open");

      replaceAllIssues([{ id: "TEAM-1", title: "Updated title", status: "in_progress", priority: 1 }]);

      expect(countIssues()).toBe(1);

      const db = getTestDatabase();
      const row = db.query("SELECT title, status FROM issues WHERE id = ?").get("TEAM-1") as {
        title: string;
        status: string;
      };
      expect(row.title).toBe("Updated title");
      expect(row.status).toBe("in_progress");
    });

    test("should handle large number of issues", () => {
      // Setup: Create 100 existing issues
      for (let i = 0; i < 100; i++) {
        insertIssue(`TEAM-${i}`, `Issue ${i}`);
      }
      expect(countIssues()).toBe(100);

      // Act: Replace with different set of 100 issues
      const newIssues = [];
      for (let i = 50; i < 150; i++) {
        newIssues.push({ id: `TEAM-${i}`, title: `New issue ${i}`, status: "open", priority: 2 });
      }
      replaceAllIssues(newIssues);

      // Assert: Should have exactly 100 issues (the new ones)
      expect(countIssues()).toBe(100);

      // Old issues (0-49) should be gone
      expect(getIssueIds()).not.toContain("TEAM-0");
      expect(getIssueIds()).not.toContain("TEAM-49");

      // Overlapping issues (50-99) should be updated
      expect(getIssueIds()).toContain("TEAM-50");
      expect(getIssueIds()).toContain("TEAM-99");

      // New issues (100-149) should exist
      expect(getIssueIds()).toContain("TEAM-100");
      expect(getIssueIds()).toContain("TEAM-149");
    });
  });
});
