# linear-beads (lb)

Linear-backed issue tracking for AI agents. Inspired by [beads](https://github.com/steveyegge/beads).

`lb` gives you beads-style issue tracking with Linear as the backend. Your issues live in Linear where you can see them, but agents interact through a fast CLI with JSON output, background sync, and dependency tracking. Backward-compatible interop (import/export) with [beads](https://github.com/steveyegge/beads) issues.jsonl.

## Thinking

- Linear is a great human-centric UI.
- Linear also has a great API.
- If you sort of squint, you can think of Linear entities (projects, issues, updates, comments, etc) as markdown files with structured frontmatter.
- `lb` is a command line tool, and CLIs are great interfaces for AIs
- Linear is an excellent _communication surface_ for humans interfacing with AI agents about specific tasks.
   - Human uses Linear GUI
   - Agent uses `lb` (or Linear API directly) if/when `lb` is lacking in some way.

The big realization (kudos Steve Yegge) was that task managers are super useful for AIs as well as humans.

My realization, on top of this, is that Linear (or something like it) is a perfect surface for communication. AI uses CLI, human sues GUI. Amazing!

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

## Quick Setup (from source)

```bash
# Install bun if needed
curl -fsSL https://bun.sh/install | bash

# Clone and install
git clone git@github.com:iansinnott/linear-beads.git
cd linear-beads
bun install

# Add alias to shell config (~/.zshrc or ~/.bashrc)
echo "alias lb='bun run $(pwd)/src/cli.ts'" >> ~/.zshrc
source ~/.zshrc

# Auth with Linear (get key from https://linear.app/settings/api)
lb auth

# Init in any project
cd /your/project
lb init && lb sync
```

**Multiple Linear teams?** If you have more than one team, create `.lb/config.jsonc` before running `lb init`:

```jsonc
{
  "team_key": "YOUR_TEAM_KEY"  // e.g., "ENG", "PROD"
}
```

All state lives in Linear—switching machines just requires re-running these steps. `lb sync` pulls everything down.

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

## Local-Only Mode

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

### Setup

1. Set up your Linear OAuth app credentials in `.env`:
   ```bash
   LINEAR_CLIENT_ID=...
   LINEAR_CLIENT_SECRET=...
   LINEAR_WEBHOOK_SECRET=...
   ```

2. Get an app actor token:
   ```bash
   cd claude-linear-agent
   bun run oauth
   ```

3. Add the token to `.env`:
   ```bash
   LINEAR_ACCESS_TOKEN=lin_oauth_...
   ```

### Running the Agent

```bash
cd claude-linear-agent
bun run dev
```

This starts both the server and ngrok tunnel with combined, prefixed output. Logs are written to `tmp/dev.log`. The ngrok web UI is available at http://localhost:4040/inspect/http.

### Customizing Agent Behavior

Edit `claude-linear-agent/agent-prompt.ts` to customize how the agent behaves. This file defines:

- **`AgentPromptContext`** - typed context available when building prompts (extend as needed)
- **`buildAgentPrompt()`** - builds the full prompt from context
- **`getSystemInstructions()`** - the agent's core personality and guidelines

See `docs/linear/oauth-setup.md` for full OAuth setup details.

## License

MIT
