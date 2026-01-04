/**
 * lb comment - Add a comment to an issue
 */

import { Command } from "commander";
import { addComment, resolveIssueId } from "../utils/linear.js";
import { output, outputError } from "../utils/output.js";
import { isLocalOnly } from "../utils/config.js";

export const commentCommand = new Command("comment")
  .description("Add a comment to an issue")
  .argument("<id>", "Issue ID (e.g., GENT-1017)")
  .argument("<body>", "Comment body (markdown supported)")
  .option("-j, --json", "Output as JSON")
  .action(async (id: string, body: string, options) => {
    try {
      // Local-only mode: comments aren't supported locally
      if (isLocalOnly()) {
        outputError("Comments require Linear connectivity (not supported in local-only mode)");
        process.exit(1);
      }

      // Resolve issue identifier to UUID
      const issueUuid = await resolveIssueId(id);
      if (!issueUuid) {
        outputError(`Issue not found: ${id}`);
        process.exit(1);
      }

      // Add the comment
      await addComment(issueUuid, body);

      if (options.json) {
        output(JSON.stringify({ success: true, issueId: id, body }));
      } else {
        output(`Comment added to ${id}`);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
