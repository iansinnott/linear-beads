/**
 * lb close - Close an issue
 */

import { Command } from "commander";
import { closeIssue, getTeamId } from "../utils/linear.js";
import { formatIssueJson, formatIssueHuman, output } from "../utils/output.js";

export const closeCommand = new Command("close")
  .description("Close an issue")
  .argument("<id>", "Issue ID")
  .option("-r, --reason <reason>", "Close reason (added as comment)")
  .option("-j, --json", "Output as JSON")
  .option("--team <team>", "Team key (overrides config)")
  .action(async (id: string, options) => {
    try {
      const teamId = await getTeamId(options.team);
      const issue = await closeIssue(id, teamId, options.reason);

      if (options.json) {
        output(formatIssueJson(issue));
      } else {
        output(formatIssueHuman(issue));
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
