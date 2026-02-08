/**
 * lb branch - Get the Linear-generated branch name for an issue
 */

import { Command } from "commander";
import { getIssueBranchName } from "../utils/linear.js";
import { output, outputError } from "../utils/output.js";

export const branchCommand = new Command("branch")
  .description("Get the branch name for an issue")
  .argument("<id>", "Issue ID (e.g., GENT-12)")
  .action(async (id: string) => {
    try {
      const branchName = await getIssueBranchName(id);
      if (!branchName) {
        outputError(`No branch name found for: ${id}`);
        process.exit(1);
      }
      output(branchName);
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
