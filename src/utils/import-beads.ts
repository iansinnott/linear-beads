/**
 * Import utilities for migrating from beads to lb
 */

import { readFileSync, existsSync } from "fs";
import type { IssueType, Priority, IssueStatus } from "../types.js";

/**
 * Beads issue structure (from .beads/issues.jsonl)
 */
export interface BeadsIssue {
  id: string;
  title: string;
  description?: string;
  status: IssueStatus;
  priority: Priority;
  issue_type: IssueType;
  created_at: string;
  updated_at?: string;
  closed_at?: string;
  dependencies?: BeadsDependency[];
  parent?: string;
}

/**
 * Beads dependency structure
 */
export interface BeadsDependency {
  type: string; // "blocks", "blocked-by", "discovered-from", "related"
  issue_id: string;
}

/**
 * Import options
 */
export interface ImportOptions {
  includeClosed?: boolean;
  since?: Date;
  source?: string;
}

/**
 * Parse beads JSONL file
 */
export function parseBeadsJsonl(path: string): BeadsIssue[] {
  if (!existsSync(path)) {
    throw new Error(`Beads file not found: ${path}`);
  }

  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n").filter(line => line.trim());
  const issues: BeadsIssue[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const issue = JSON.parse(lines[i]) as BeadsIssue;
      
      // Validate required fields
      if (!issue.id || !issue.title) {
        console.warn(`Line ${i + 1}: Missing required fields (id, title)`);
        continue;
      }

      issues.push(issue);
    } catch (error) {
      console.warn(`Line ${i + 1}: Failed to parse JSON:`, error instanceof Error ? error.message : error);
    }
  }

  return issues;
}

/**
 * Build dependency graph from issues
 * Returns map of issue ID -> list of dependency IDs
 */
export function buildDependencyGraph(issues: BeadsIssue[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();

  for (const issue of issues) {
    const deps: string[] = [];

    // Add parent as dependency
    if (issue.parent) {
      deps.push(issue.parent);
    }

    // Add explicit dependencies
    if (issue.dependencies) {
      for (const dep of issue.dependencies) {
        if (dep.type === "blocks" || dep.type === "blocked-by") {
          deps.push(dep.issue_id);
        }
      }
    }

    if (deps.length > 0) {
      graph.set(issue.id, deps);
    }
  }

  return graph;
}

/**
 * Filter issues based on options
 */
export function filterIssues(issues: BeadsIssue[], options: ImportOptions): BeadsIssue[] {
  let filtered = issues;

  // Filter by status (skip closed unless --include-closed)
  if (!options.includeClosed) {
    filtered = filtered.filter(issue => issue.status !== "closed");
  }

  // Filter by date (--since)
  if (options.since) {
    filtered = filtered.filter(issue => {
      const createdAt = new Date(issue.created_at);
      return createdAt >= options.since!;
    });
  }

  return filtered;
}
