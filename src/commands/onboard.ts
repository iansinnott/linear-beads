/**
 * lb onboard - Output agent instructions
 */

import { Command } from "commander";
import { output } from "../utils/output.js";

const ONBOARD_CONTENT = `## Issue Tracking with lb

**IMPORTANT**: This project uses **lb** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why lb?

- Linear-backed: Issues sync with Linear for visibility and collaboration
- Dependency-aware: Track blockers and relationships between issues
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Repo-scoped: Only see issues relevant to this repository
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**
\`\`\`bash
lb ready --json          # Your issues + unassigned
lb ready --all --json    # All ready issues
\`\`\`

**Create new issues:**
\`\`\`bash
lb create "Issue title" -t bug|feature|task -p 0-4 --json
lb create "Issue title" -p 1 --deps discovered-from:LIN-123 --json
lb create "Subtask" --parent LIN-123 --json
lb create "Bug" --unassign --json   # Don't auto-assign to me
\`\`\`

**Claim and update:**
\`\`\`bash
lb update LIN-42 --status in_progress --json
lb update LIN-42 --assign me --json
lb update LIN-42 --unassign --json
\`\`\`

**Complete work:**
\`\`\`bash
lb close LIN-42 --reason "Completed" --json
\`\`\`

### Issue Types

- \`bug\` - Something broken
- \`feature\` - New functionality
- \`task\` - Work item (tests, docs, refactoring)
- \`epic\` - Large feature with subtasks
- \`chore\` - Maintenance (dependencies, tooling)

### Priorities

- \`0\` - Critical (security, data loss, broken builds)
- \`1\` - High (major features, important bugs)
- \`2\` - Medium (default, nice-to-have)
- \`3\` - Low (polish, optimization)
- \`4\` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: \`lb ready --json\` shows your unblocked issues (+ unassigned)
2. **Claim your task**: \`lb update <id> --status in_progress --json\`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue (auto-assigned to you):
   - \`lb create "Found bug" -p 1 --deps discovered-from:<parent-id> --json\`
5. **Complete**: \`lb close <id> --reason "Done" --json\`

**Assignee behavior:**
- \`lb create\` auto-assigns to you (use \`--unassign\` to skip)
- \`lb ready\` shows your issues + unassigned (use \`--all\` for everyone's)
- \`lb import\` assigns all imported issues to you

### Background Sync

lb automatically syncs changes to Linear in the background:

- Write commands (create/update/close) return immediately after queuing
- A background worker process pushes changes to Linear asynchronously
- Linear may be slightly behind - eventual consistency
- No manual sync needed - it's fire-and-forget!

Commands accept \`--sync\` to push immediately (blocking) instead of queuing.

### CLI Help

Run \`lb <command> --help\` to see all available flags for any command.
For example: \`lb create --help\` shows \`--parent\`, \`--deps\`, \`--type\`, etc.

### Important Rules

- Use lb for ALL task tracking
- Always use \`--json\` flag for programmatic use
- Link discovered work with \`--deps discovered-from:<id>\`
- Check \`lb ready\` before asking "what should I work on?"
- Changes sync automatically in background (fire-and-forget)
- Use \`--sync\` flag only if you need immediate blocking sync
- Do NOT create markdown TODO lists
- Do NOT use external issue trackers
- Do NOT duplicate tracking systems
`;

export const onboardCommand = new Command("onboard")
  .description("Output agent instructions for lb")
  .option("-o, --output <file>", "Write to file instead of stdout")
  .action(async (options) => {
    if (options.output) {
      const { writeFileSync } = await import("fs");
      writeFileSync(options.output, ONBOARD_CONTENT);
      output(`Written to ${options.output}`);
    } else {
      output(ONBOARD_CONTENT);
    }
  });
