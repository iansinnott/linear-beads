/**
 * lb attach - Add link attachments to issues
 */

import { Command } from "commander";
import { addAttachment, getIssueAttachments } from "../utils/linear.js";
import { output, outputError } from "../utils/output.js";

export const attachCommand = new Command("attach")
  .description("Add a link attachment to an issue")
  .argument("<id>", "Issue ID (e.g., GENT-12)")
  .argument("<url>", "URL to attach")
  .argument("[title]", "Link title (defaults to URL)")
  .option("-s, --subtitle <subtitle>", "Link subtitle (e.g., 'Open', 'Merged')")
  .option("-j, --json", "Output as JSON")
  .action(async (id: string, url: string, title: string | undefined, options) => {
    try {
      const linkTitle = title || url;
      const attachment = await addAttachment(id, url, linkTitle, options.subtitle);

      if (options.json) {
        output(JSON.stringify(attachment, null, 2));
      } else {
        output(`Attached to ${id}: ${attachment.title}`);
        if (attachment.subtitle) {
          output(`  Subtitle: ${attachment.subtitle}`);
        }
        output(`  URL: ${attachment.url}`);
      }
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
