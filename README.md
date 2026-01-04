# linear-beads (lb)

Linear-backed issue tracking for AI agents. Inspired by [beads](https://github.com/steveyegge/beads).

`lb` gives you beads-style issue tracking with Linear as the backend. Your issues live in Linear where you can see them, but agents interact through a fast CLI with JSON output, background sync, and dependency tracking. Backward-compatible interop (import/export) with [beads](https://github.com/steveyegge/beads) issues.jsonl.

## Quickstart

Tell your agent:

> Run `lb onboard`

That's it. The agent will walk you through setup (install, auth, etc.) and configure itself to use `lb` for task tracking.

## Install

**Download a binary** from [releases](https://github.com/nikvdp/linear-beads/releases) and add it to your PATH.

**Or with bun:**

```bash
bun install -g github:nikvdp/linear-beads
```

## What happens behind the scenes

When your agent runs `lb onboard`, it will:

1. **Install lb** if not already installed
2. **Authenticate with Linear** (`lb auth`) - you'll be prompted for your API key
3. **Initialize the project** (`lb init`) - creates `.lb/` directory and syncs with Linear
4. **Update its instruction file** (CLAUDE.md or AGENTS.md) with lb usage instructions

After onboarding, your agent uses `lb` instead of its built-in task tools. Issues sync to Linear so you can see them in the Linear UI.

## How Issues Are Scoped

Each repository gets its own Linear project. When you run `lb init`, it creates (or finds) a project matching your repo name. All issues created with `lb` are automatically added to this project, making it easy to see all issues for a repo in Linear's project view.

**Migrating from older versions:** If you used `lb` before v10, your issues may have `repo:X` labels instead of project assignment. Run `lb migrate labels-to-project` to migrate them.

## Offline & Local-Only Modes

`lb` works offline and can run entirely without Linear.

### Offline Mode

When you lose internet connectivity, `lb` continues working:

- All reads work from local SQLite cache
- Writes queue in an outbox and sync when you're back online
- `lb sync` shows a friendly message instead of failing

## Dev Setup (from source)

For development on `lb` itself:

### 1. Prerequisites

- [Bun](https://bun.sh) - `curl -fsSL https://bun.sh/install | bash`
- A Linear account with API access

### 2. Clone and install

```bash
git clone git@github.com:iansinnott/linear-beads.git
cd linear-beads
bun install
```

### 3. Add the `lb` alias

Add to your shell config (`~/.zshrc` or `~/.bashrc`):

```bash
alias lb='bun run /path/to/linear-beads/src/cli.ts'
```

Then reload: `source ~/.zshrc`

### 4. Authenticate with Linear

```bash
lb auth
```

You'll need a Linear API key from https://linear.app/settings/api

### 5. Initialize in your project

```bash
cd /your/project
lb init
lb sync
```

This creates `.lb/` and syncs with Linear. Your issues are now available via `lb list`, `lb ready`, etc.

### 6. (Optional) Claude Code integration

If using Claude Code, the project's `AGENTS.md` already contains instructions. Claude will use `lb` for task tracking automatically.

### Local-Only Mode

For pure local usage (no Linear backend), add to `.lb/config.jsonc`:

```jsonc
{
  "local_only": true,
}
```

In local-only mode:

- `lb sync` is disabled (shows a message)
- `lb create` generates LOCAL-001, LOCAL-002, etc. IDs
- All commands work from local SQLite only
- Great for AI-only workflows or trying out lb without Linear

## Linear Agent

The `claude-linear-agent/` directory contains a webhook server that responds to `@Claude` mentions in Linear issues using the Claude Agent SDK.

### Running the Agent

```bash
bun run agent:dev
```

This starts the server with hot reload and logs to `tmp/server.log` for debugging.

### Customizing Agent Behavior

Edit `claude-linear-agent/agent-prompt.ts` to customize how the agent behaves. This file defines:

- **`AgentPromptContext`** - typed context available when building prompts (extend as needed)
- **`buildAgentPrompt()`** - builds the full prompt from context
- **`getSystemInstructions()`** - the agent's core personality and guidelines

See `claude-linear-agent/CLAUDE.md` for full dev setup including ngrok tunneling.

## License

MIT
