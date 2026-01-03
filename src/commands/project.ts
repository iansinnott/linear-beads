/**
 * lb project - Project management commands
 */

import { Command } from "commander";
import {
  getProjectWithLinks,
  setProjectRepoUrl,
  getGitHubRepoFromLinks,
} from "../utils/linear.js";
import { output, outputError } from "../utils/output.js";
import { getProjectName } from "../utils/config.js";

export const projectCommand = new Command("project")
  .description("Manage Linear projects");

// lb project show [name]
projectCommand
  .command("show")
  .description("Show project details including repo link")
  .argument("[name]", "Project name (defaults to current repo's project)")
  .option("-j, --json", "Output as JSON")
  .action(async (name: string | undefined, options) => {
    try {
      // Use provided name or fall back to configured project
      const projectName = name || getProjectName();

      const project = await getProjectWithLinks(projectName);
      if (!project) {
        outputError(`Project not found: ${projectName}`);
        process.exit(1);
      }

      if (options.json) {
        output(JSON.stringify(project, null, 2));
      } else {
        output(`${project.name}`);
        output(`  ID: ${project.id}`);
        output(`  State: ${project.state}`);
        if (project.description) {
          output(`  Description: ${project.description}`);
        }

        const repoUrl = getGitHubRepoFromLinks(project.externalLinks);
        if (repoUrl) {
          output(`  GitHub: ${repoUrl}`);
        } else {
          output(`  GitHub: (not set)`);
        }

        if (project.externalLinks.length > 0) {
          output(`  Links:`);
          for (const link of project.externalLinks) {
            output(`    - ${link.label}: ${link.url}`);
          }
        }
      }
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// lb project set-repo <name> <url>
projectCommand
  .command("set-repo")
  .description("Set or update GitHub repo URL for a project")
  .argument("<name>", "Project name")
  .argument("<url>", "GitHub repository URL")
  .action(async (name: string, url: string) => {
    try {
      // Validate URL looks like a GitHub URL
      if (!url.includes("github.com")) {
        outputError("URL must be a GitHub repository URL");
        process.exit(1);
      }

      const project = await setProjectRepoUrl(name, url);
      output(`Updated ${project.name} with GitHub repo: ${url}`);
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
