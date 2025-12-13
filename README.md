# lb

A CLI for tracking issues in Linear. Designed for AI agents and fast terminal workflows.

## Install

```bash
bun install -g github:nikvdp/linear-beads
```

## Setup

```bash
# Authenticate with Linear (get key at https://linear.app/settings/api)
lb auth

# Initialize in your project
cd your-project
lb init
```

## Usage

```bash
# See what's ready to work on
lb ready --json

# Create issues
lb create "Fix login bug" -t bug -p 1
lb create "Add search" -t feature
lb create "Subtask" --parent LIN-123

# Work on issues
lb update LIN-123 --status in_progress
lb close LIN-123 --reason "Fixed"

# List and show
lb list
lb show LIN-123
```

## Commands

| Command | Description |
|---------|-------------|
| `lb auth` | Set up Linear API key |
| `lb init` | Initialize lb in current repo |
| `lb ready` | List issues ready to work on |
| `lb list` | List all issues |
| `lb show <id>` | Show issue details |
| `lb create <title>` | Create issue |
| `lb update <id>` | Update issue |
| `lb close <id>` | Close issue |
| `lb sync` | Sync with Linear |

## Flags

**Global:**
- `-j, --json` - JSON output
- `--sync` - Sync immediately (default is background)

**Create:**
- `-t, --type` - bug, feature, task, epic, chore
- `-p, --priority` - 0 (critical) to 4 (backlog)
- `-d, --description` - Description
- `--parent <id>` - Parent issue

**Update:**
- `-s, --status` - open, in_progress, closed
- `-p, --priority` - 0-4
- `--assign <email>` - Assign to user
- `--unassign` - Remove assignee

**List/Ready:**
- `-a, --all` - Show all issues (not just mine)
- `-s, --status` - Filter by status

## For AI Agents

Run `lb onboard` to get workflow instructions for agents.

## Config

`lb auth` saves to `~/.config/lb/config.json`. You can also use:
- `LINEAR_API_KEY` env var
- `.lb.json` in project root

## License

MIT
