# lb-cli (Linear-native beads-style tracker)

This repo uses **bd (Beads)** for all planning and task tracking while we build `lb`.

## bd workflow (agents)

- Always start by checking ready work: `bd ready --json`
- When you pick something: `bd update <id> --status in_progress --json`
- If you discover new work, create it linked back:
  - `bd create "New issue" -p 1 --deps discovered-from:<parent-id> --json`
- When done: `bd close <id> --reason "Done" --json`

For the canonical bd instructions (auto-generated), see `.beads/BD_GUIDE.md`.
