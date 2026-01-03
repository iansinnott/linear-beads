/**
 * lb migrate - Migration utilities
 */

import { Command } from "commander";
import { getGraphQLClient } from "../utils/graphql.js";
import { getTeamId, fetchIssues, ensureProject } from "../utils/linear.js";
import { getRepoLabel } from "../utils/config.js";
import { output } from "../utils/output.js";

/**
 * Migrate issues from repo label scoping to project scoping
 */
async function migrateLabelsToProject(
  teamId: string,
  dryRun: boolean,
  removeLabels: boolean
): Promise<void> {
  const client = getGraphQLClient();
  const repoLabel = getRepoLabel();

  output(`Looking for issues with label '${repoLabel}'...`);

  // Query issues with the repo label
  const query = `
    query GetIssuesWithLabel($teamId: String!, $labelName: String!) {
      team(id: $teamId) {
        issues(filter: { labels: { name: { eq: $labelName } } }, first: 100) {
          nodes {
            id
            identifier
            title
            project {
              id
              name
            }
            labels {
              nodes {
                id
                name
              }
            }
          }
        }
      }
    }
  `;

  const result = await client.request<{
    team: {
      issues: {
        nodes: Array<{
          id: string;
          identifier: string;
          title: string;
          project: { id: string; name: string } | null;
          labels: { nodes: Array<{ id: string; name: string }> };
        }>;
      };
    };
  }>(query, { teamId, labelName: repoLabel });

  const issues = result.team.issues.nodes;
  output(`Found ${issues.length} issues with label '${repoLabel}'`);

  if (issues.length === 0) {
    output("No issues to migrate.");
    return;
  }

  // Get or create the project
  const projectId = await ensureProject(teamId);
  output(`Target project ID: ${projectId}`);

  // Find the repo label ID for removal if needed
  let repoLabelId: string | undefined;
  if (removeLabels && issues.length > 0) {
    const labelMatch = issues[0].labels.nodes.find((l) => l.name === repoLabel);
    repoLabelId = labelMatch?.id;
  }

  const updateMutation = `
    mutation UpdateIssueProject($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          identifier
          project {
            name
          }
        }
      }
    }
  `;

  let migrated = 0;
  let skipped = 0;

  for (const issue of issues) {
    // Skip if already in the target project
    if (issue.project?.id === projectId) {
      output(`  ${issue.identifier}: Already in project, skipping`);
      skipped++;
      continue;
    }

    // Build the update input
    const input: Record<string, unknown> = {
      projectId,
    };

    // If removing labels, filter out the repo label
    if (removeLabels && repoLabelId) {
      const newLabelIds = issue.labels.nodes
        .filter((l) => l.id !== repoLabelId)
        .map((l) => l.id);
      input.labelIds = newLabelIds;
    }

    if (dryRun) {
      const action = removeLabels ? "add to project & remove label" : "add to project";
      output(`  ${issue.identifier}: Would ${action} - "${issue.title}"`);
    } else {
      try {
        const updateResult = await client.request<{
          issueUpdate: {
            success: boolean;
            issue: { identifier: string; project: { name: string } | null };
          };
        }>(updateMutation, { id: issue.id, input });

        if (updateResult.issueUpdate.success) {
          const action = removeLabels ? "migrated & label removed" : "migrated";
          output(`  ${issue.identifier}: ${action} - "${issue.title}"`);
          migrated++;
        } else {
          output(`  ${issue.identifier}: Failed to migrate`);
        }
      } catch (error) {
        output(`  ${issue.identifier}: Error - ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  output("");
  if (dryRun) {
    output(`Dry run complete. Would migrate ${issues.length - skipped} issues.`);
    output("Run without --dry-run to apply changes.");
  } else {
    output(`Migration complete. Migrated ${migrated} issues, skipped ${skipped}.`);
  }
}

/**
 * Remove type labels from all issues in this repo
 */
async function removeTypeLabels(teamId: string, dryRun: boolean): Promise<void> {
  const client = getGraphQLClient();
  const repoLabel = getRepoLabel();

  // First, fetch all issues for this repo
  output(`Fetching issues with label '${repoLabel}'...`);
  const issues = await fetchIssues(teamId);
  output(`Found ${issues.length} issues`);

  // Get all labels for this team
  const labelsQuery = `
    query GetLabels($teamId: String!) {
      team(id: $teamId) {
        labels {
          nodes {
            id
            name
          }
        }
      }
    }
  `;

  const labelsResult = await client.request<{
    team: { labels: { nodes: Array<{ id: string; name: string }> } };
  }>(labelsQuery, { teamId });

  // Find type labels (old format "type:X" or new format matching type names)
  const typeLabels = labelsResult.team.labels.nodes.filter(
    (l) =>
      l.name.startsWith("type:") || ["Bug", "Feature", "Task", "Epic", "Chore"].includes(l.name)
  );

  if (typeLabels.length === 0) {
    output("No type labels found to remove.");
    return;
  }

  output(`Found ${typeLabels.length} type labels: ${typeLabels.map((l) => l.name).join(", ")}`);

  // For each issue, check if it has type labels and remove them
  const issueQuery = `
    query GetIssue($id: String!) {
      issue(id: $id) {
        id
        identifier
        labels {
          nodes {
            id
            name
          }
        }
      }
    }
  `;

  const updateMutation = `
    mutation UpdateIssueLabels($id: String!, $labelIds: [String!]!) {
      issueUpdate(id: $id, input: { labelIds: $labelIds }) {
        success
      }
    }
  `;

  let updated = 0;
  const typeLabelIds = new Set(typeLabels.map((l) => l.id));

  for (const issue of issues) {
    // Fetch current labels for this issue
    const issueResult = await client.request<{
      issue: {
        id: string;
        identifier: string;
        labels: { nodes: Array<{ id: string; name: string }> };
      } | null;
    }>(issueQuery, { id: issue.id });

    if (!issueResult.issue) continue;

    const currentLabels = issueResult.issue.labels.nodes;
    const typeLabelsOnIssue = currentLabels.filter((l) => typeLabelIds.has(l.id));

    if (typeLabelsOnIssue.length === 0) continue;

    // Filter out type labels
    const newLabelIds = currentLabels.filter((l) => !typeLabelIds.has(l.id)).map((l) => l.id);

    if (dryRun) {
      output(`Would remove from ${issue.id}: ${typeLabelsOnIssue.map((l) => l.name).join(", ")}`);
    } else {
      await client.request(updateMutation, {
        id: issueResult.issue.id,
        labelIds: newLabelIds,
      });
      output(`Removed from ${issue.id}: ${typeLabelsOnIssue.map((l) => l.name).join(", ")}`);
    }
    updated++;
  }

  if (dryRun) {
    output(`\nDry run: Would update ${updated} issues. Run without --dry-run to proceed.`);
  } else {
    output(`\nUpdated ${updated} issues.`);
  }
}

export const migrateCommand = new Command("migrate")
  .description("Migration utilities")
  .addCommand(
    new Command("labels-to-project")
      .description("Migrate issues from repo label scoping to project scoping")
      .option("--dry-run", "Show what would be changed without making changes")
      .option("--remove-labels", "Remove the repo:X label after migrating each issue")
      .option("--team <team>", "Team key (overrides config)")
      .action(async (options) => {
        try {
          const teamId = await getTeamId(options.team);
          await migrateLabelsToProject(teamId, options.dryRun, options.removeLabels);
        } catch (error) {
          console.error("Error:", error instanceof Error ? error.message : error);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command("remove-type-labels")
      .description("Remove type labels (type:X or Type group) from all issues in this repo")
      .option("--dry-run", "Show what would be changed without making changes")
      .option("--team <team>", "Team key (overrides config)")
      .action(async (options) => {
        try {
          const teamId = await getTeamId(options.team);
          await removeTypeLabels(teamId, options.dryRun);
        } catch (error) {
          console.error("Error:", error instanceof Error ? error.message : error);
          process.exit(1);
        }
      })
  );
