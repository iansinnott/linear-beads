# Repo Resolution: How Claude Finds the Right Working Directory

## Problem

When Claude receives a task via Linear, it needs a working directory. Today `REPO_PATH` is a single static path. We need Claude to work on arbitrary repos depending on what issue it's assigned.

## Scenarios

### 1. Issue in a project with a linked repo
> "Fix the auth bug" on an issue in the `finfun` project, which has `github.com/iansinnott/finfun` as a resource link.

Claude needs to resolve the repo URL to a local path, clone if needed, and work there.

### 2. Issue in a project with no repo
> "Research competitor pricing" in a project with no code.

Claude can still answer — it just doesn't need a specific cwd. A scratch/default directory works.

### 3. Issue with no project at all
> "How do I set up ESLint with TypeScript?"

Same as above. Knowledge question, any cwd works.

### 4. Issue that requires creating a new repo
> "Bootstrap a new service for notifications"

This is the "greenfield" case. Claude would need somewhere to put new code.

### 5. Multiple agents working on the same repo simultaneously
> Two issues in the `finfun` project, both kicked off at the same time.

They'll clobber each other if sharing a working directory.

---

## Design

### Repo lookup chain

When an issue arrives, resolve the working directory:

```
issue
  → issue.project
    → project.resources[] (look for GitHub URL)
      → derive local path
        → clone if missing
```

**Concrete steps in the webhook handler:**

1. Extract `session.issue.project.id` from the webhook payload
2. Query Linear API: `project(id) { resources { url } }` — filter for GitHub URLs
3. If found, derive local path: `{REPOS_BASE}/{org}/{repo}` (e.g. `~/repos/iansinnott/finfun`)
4. If directory doesn't exist, `git clone` it
5. If no repo found, use a default scratch directory

**What about sub-issues?** Linear sub-issues inherit their parent's project. If an issue has no project, we walk up the parent chain. In practice this should rarely matter — most issues belong to a project directly.

### Path convention

```
REPOS_BASE/
  iansinnott/
    finfun/           # main clone
    finfun--issue-123/ # worktree (see parallel work below)
    limbic/
    full-text-tabs-forever/
```

`REPOS_BASE` defaults to `~/repos` (configurable via env).

The convention `{org}/{repo}` mirrors GitHub's structure. Simple, predictable, no config file needed.

### When no repo is linked

**Do nothing special.** Use a default/scratch directory. Claude can answer knowledge questions, do web research, etc. without repo access.

If Claude determines mid-run that it needs to write code but has no repo, it can:
- Tell the user via an elicitation: "This issue doesn't have a linked repo. Which repo should I work in, or should I create a new one?"
- This keeps the human in the loop for the decision, which is the right default

**We should NOT auto-create repos.** Creating a GitHub repo is a meaningful decision (naming, visibility, org). Let the user do it and link it to the project.

### When to add repo links to projects

**Manual, with nudges.** The agent can detect "project has code-related issues but no linked repo" and suggest adding one. But it shouldn't create repos or add links on its own.

A reasonable nudge: when Claude gets an issue that looks like it needs code (mentions files, bugs, features) but the project has no repo, include a note in the response:
> "I don't have a repo linked to this project, so I can't access the code. Add a GitHub repo link to the project resources if you'd like me to work on code."

---

## Parallel Work: Worktrees

### The problem

Two Claude agents working on the same repo at the same time will conflict — they share the same working tree, index, and HEAD. One agent's `git checkout` or file edits will corrupt the other's state.

### Solution: git worktrees

Git worktrees let you check out multiple branches of the same repo simultaneously, each in its own directory, sharing a single `.git` object store.

```bash
# One-time: clone the "bare" main copy
git clone --bare https://github.com/iansinnott/finfun.git ~/repos/iansinnott/finfun.git

# Per-agent: create an isolated worktree
git -C ~/repos/iansinnott/finfun.git worktree add \
  ~/repos/iansinnott/finfun--gent-123 \
  -b agent/gent-123 \
  main
```

Each agent gets:
- Its own directory (`finfun--gent-123`)
- Its own branch (`agent/gent-123`)
- Full filesystem isolation from other agents
- Shared git history (no duplicate clones)

### Lifecycle

```
Issue assigned to Claude
  → Resolve repo (see lookup chain above)
  → Create worktree: {repo}--{issue-identifier}
  → Branch: agent/{issue-identifier}
  → Claude works in the worktree
  → When done: create PR from agent/{issue-identifier} → main
  → Clean up worktree (after PR merged or agent session ends)
```

### Alternative considered: separate clones

Simpler but wasteful. Each clone duplicates the full git history. For large repos this means significant disk and network cost. Worktrees share the object store — a worktree is essentially free.

---

## PRs and Merging

### How work gets merged

Each agent run produces a branch (`agent/gent-123`). The natural output is a PR.

**Flow:**
1. Agent works on branch `agent/gent-123` in its worktree
2. Agent pushes branch and creates a PR via `gh pr create`
3. Agent links the PR to the Linear issue (via Linear API or PR description)
4. Human reviews and merges (or asks Claude for changes via Linear follow-up)

**Multiple agents, same repo:**
- Each agent has its own branch and worktree — no conflicts during work
- Merge conflicts happen at PR time, which is normal and expected
- If two PRs conflict, the second one to merge will need a rebase — this can be handled by the agent if the human asks

### What Claude should include in PRs

- Link back to the Linear issue
- Summary of what was changed and why
- Test results if applicable

### Linear integration

When Claude creates a PR, it should:
1. Add the PR URL as a comment on the Linear issue
2. Optionally move the issue to "In Review" status
3. When PR is merged (detected via webhook or polling), move issue to "Done"

---

## API Capabilities for Links & Attachments

Two Linear GraphQL mutations support linking external resources:

### `attachmentCreate` — Link PRs (or any URL) to issues

Adds an external link attachment to an issue. **Idempotent on URL+issueId** — calling it again with the same URL updates the existing attachment rather than creating a duplicate. This is useful for updating PR status (e.g. title "PR #42 (Open)" → "PR #42 (Merged)").

Helper: `createAttachmentMutation()` in `lib.ts`

### `projectLinkCreate` — Link repos to projects

Adds a resource link to a project. This is how repo URLs get associated with projects for the repo lookup chain above.

Helper: `createProjectLinkMutation()` in `lib.ts`

### Usage

Both helpers return `{ query, variables }` objects compatible with `linearApiRequest()` in `server.ts`:

```typescript
import { createAttachmentMutation, createProjectLinkMutation } from "./lib";

// Link a PR to an issue
const result = await linearApiRequest(
  createAttachmentMutation(issueId, prUrl, "PR #42: Fix auth bug", "Open")
);

// Link a repo to a project
const result = await linearApiRequest(
  createProjectLinkMutation(projectId, repoUrl, "github.com/org/repo")
);
```

---

## Implementation Phases

### Phase 1: Basic repo resolution (MVP)
- Query project resources for GitHub URL on each webhook
- Clone to `REPOS_BASE/{org}/{repo}` if not present
- Use as cwd for `query()`
- Fall back to default dir if no repo linked
- No worktrees yet — single working directory per repo

### Phase 2: Worktrees for isolation
- Switch to bare clone + worktrees
- Each agent session gets its own worktree
- Auto-cleanup worktrees after session ends

### Phase 3: PR workflow
- Agent creates PR on completion
- Links PR to Linear issue
- Status transitions based on PR state

### Phase 4: Nudges and polish
- Detect code-related issues with no linked repo, suggest adding one
- Handle private repos (SSH keys, GitHub App tokens)
- Support non-GitHub repos (GitLab, etc.)

---

## Open Questions

- **Private repo auth:** How does the server clone private repos? SSH key on the host? GitHub App installation token? For now, assume repos are public or SSH is configured.
- **Repo freshness:** Should Claude `git pull` before starting work? Probably yes — stale main means more merge conflicts.
- **Disk cleanup:** Worktrees accumulate. Clean up after PR merge? After N days? On-demand?
- **Non-code projects:** Some projects (Books, Childcare) will never have repos. The "no repo = use scratch dir" default handles this fine.
