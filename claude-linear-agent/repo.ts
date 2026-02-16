/**
 * Repository resolution
 *
 * Resolves the working directory for an agent run based on the issue's project.
 * Resolution chain: issue → project → externalLinks → GitHub URL → REPOS_BASE/{org}/{repo}
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "./logger";
import { linearApiRequest } from "./linear-api";

// --- Constants ---

export const REPOS_BASE = process.env.REPOS_BASE || join(homedir(), "repos");
export const SCRATCH_DIR = join(REPOS_BASE, "_scratch");

// --- GitHub URL helpers ---

export interface GitHubRepo {
  org: string;
  repo: string;
}

/**
 * Parse a GitHub URL into org/repo components.
 * Handles HTTPS, SSH, .git suffix, and trailing paths.
 */
export function parseGitHubUrl(url: string): GitHubRepo | null {
  try {
    // Handle SSH URLs: git@github.com:org/repo.git
    const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/.]+)/);
    if (sshMatch) return { org: sshMatch[1], repo: sshMatch[2] };

    // Handle HTTPS URLs
    const parsed = new URL(url);
    if (!parsed.hostname.includes("github.com")) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { org: parts[0], repo: parts[1].replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

/**
 * Find the first GitHub URL from a list of external links.
 */
export function findGitHubLink(links: Array<{ url: string }>): string | null {
  const match = links.find((l) => l.url.includes("github.com"));
  return match?.url || null;
}

/**
 * Create GraphQL query to fetch an issue's project and its external links.
 * Used to resolve which repo an issue belongs to.
 */
export function createIssueProjectQuery(issueId: string) {
  return {
    query: `
      query GetIssueProject($issueId: String!) {
        issue(id: $issueId) {
          project {
            id
            name
            externalLinks {
              nodes {
                url
                label
              }
            }
          }
        }
      }
    `,
    variables: { issueId },
  };
}

/**
 * Create GraphQL query to fetch a project's external links directly.
 * Used for project update resolution (no issue lookup needed).
 */
export function createProjectExternalLinksQuery(projectId: string) {
  return {
    query: `
      query GetProjectExternalLinks($projectId: String!) {
        project(id: $projectId) {
          id
          name
          externalLinks {
            nodes {
              url
              label
            }
          }
        }
      }
    `,
    variables: { projectId },
  };
}

// --- Repo resolution ---

/**
 * Resolve the working directory for a project update.
 * Simpler than resolveRepoCwd since we already have projectId.
 *
 * Resolution chain:
 *   projectId → externalLinks → GitHub URL → REPOS_BASE/{org}/{repo}
 */
export async function resolveProjectRepoCwd(projectId: string): Promise<{
  cwd: string;
  repoPath: string | undefined;
  cloneInfo?: { gitUrl: string; clonePath: string };
}> {
  try {
    const result = await linearApiRequest(createProjectExternalLinksQuery(projectId));
    const project = (result.data as Record<string, unknown>)?.project as Record<string, unknown> | undefined;

    if (project) {
      const nodes = ((project.externalLinks as Record<string, unknown>)?.nodes || []) as Array<{ url: string }>;
      const githubUrl = findGitHubLink(nodes);

      if (githubUrl) {
        const parsed = parseGitHubUrl(githubUrl);
        if (parsed) {
          const repoDir = join(REPOS_BASE, parsed.org, parsed.repo);
          if (existsSync(repoDir)) {
            log("info", "Resolved repo from project link", {
              projectId,
              project: project.name,
              repo: `${parsed.org}/${parsed.repo}`,
              repoDir,
            });
            return { cwd: repoDir, repoPath: repoDir };
          }
          // Repo linked but not on disk
          log("info", "Repo linked but not on disk", {
            projectId,
            project: project.name,
            repo: `${parsed.org}/${parsed.repo}`,
            expectedDir: repoDir,
          });
          if (!existsSync(SCRATCH_DIR)) {
            mkdirSync(SCRATCH_DIR, { recursive: true });
          }
          return {
            cwd: SCRATCH_DIR,
            repoPath: undefined,
            cloneInfo: { gitUrl: githubUrl, clonePath: repoDir },
          };
        }
      }
    }
  } catch (err) {
    log("warn", "Failed to resolve repo from project", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Fallback: scratch directory
  if (!existsSync(SCRATCH_DIR)) {
    mkdirSync(SCRATCH_DIR, { recursive: true });
  }
  log("info", "Using scratch directory", { projectId, scratchDir: SCRATCH_DIR });
  return { cwd: SCRATCH_DIR, repoPath: undefined };
}

/**
 * Resolve the working directory for an agent run based on the issue's project.
 *
 * Resolution chain:
 *   issue → project → externalLinks → GitHub URL → REPOS_BASE/{org}/{repo}
 *
 * Falls back to SCRATCH_DIR when no repo is linked or not on disk.
 */
export async function resolveRepoCwd(issueId: string): Promise<{
  cwd: string;
  repoPath: string | undefined;
  // When a repo is linked but not yet on disk, provide clone info so the agent can clone it
  cloneInfo?: { gitUrl: string; clonePath: string };
}> {
  try {
    const result = await linearApiRequest(createIssueProjectQuery(issueId));
    const issue = (result.data as Record<string, unknown>)?.issue as Record<string, unknown> | undefined;
    const project = issue?.project as Record<string, unknown> | undefined;

    if (project) {
      const nodes = ((project.externalLinks as Record<string, unknown>)?.nodes || []) as Array<{ url: string }>;
      const githubUrl = findGitHubLink(nodes);

      if (githubUrl) {
        const parsed = parseGitHubUrl(githubUrl);
        if (parsed) {
          const repoDir = join(REPOS_BASE, parsed.org, parsed.repo);
          if (existsSync(repoDir)) {
            log("info", "Resolved repo from project link", {
              issueId,
              project: project.name,
              repo: `${parsed.org}/${parsed.repo}`,
              repoDir,
            });
            return { cwd: repoDir, repoPath: repoDir };
          }
          // Repo linked but not on disk — fall to scratch but provide clone info
          log("info", "Repo linked but not on disk", {
            issueId,
            project: project.name,
            repo: `${parsed.org}/${parsed.repo}`,
            expectedDir: repoDir,
          });
          if (!existsSync(SCRATCH_DIR)) {
            mkdirSync(SCRATCH_DIR, { recursive: true });
          }
          return {
            cwd: SCRATCH_DIR,
            repoPath: undefined,
            cloneInfo: { gitUrl: githubUrl, clonePath: repoDir },
          };
        }
      }
    }
  } catch (err) {
    log("warn", "Failed to resolve repo from project", {
      issueId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Fallback: scratch directory (no repo linked at all)
  if (!existsSync(SCRATCH_DIR)) {
    mkdirSync(SCRATCH_DIR, { recursive: true });
  }
  log("info", "Using scratch directory", { issueId, scratchDir: SCRATCH_DIR });
  return { cwd: SCRATCH_DIR, repoPath: undefined };
}
