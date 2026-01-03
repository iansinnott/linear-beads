# lb-cli

## Issue Tracking

This project uses **lb** for issue tracking via Linear.

**Quick reference:**
- `lb sync` - Sync with Linear
- `lb ready` - Find unblocked work
- `lb create "Title" -d "Description"` - Create issue
- `lb close <id> --reason "why"` - Complete work

Run `lb --help` for full command list.

**Setup:** Add this alias to your shell config:
```bash
alias lb='bun run /Users/ian/dev/linear-beads/src/cli.ts'
```

---

## CRITICAL: Task Tracking with `lb`

**DO NOT use the TodoWrite/TodoRead tools. NEVER. Use `lb` instead.**

### Before Starting ANY Work

```bash
lb sync                    # Pull latest from Linear
lb ready                   # See unblocked work
lb show GENT-XXX           # Read full description before starting
lb update GENT-XXX --status in_progress   # Claim it
```

### Planning Work

When you need to break down a task into steps, **create subtasks in lb**, not mental notes or TodoWrite:

```bash
lb create "Step 1: Do X" --parent GENT-XXX -d "Details..."
lb create "Step 2: Do Y" --parent GENT-XXX -d "Details..."
```

### During Work

```bash
# Found something that needs doing? Create an issue
lb create "Found: need to fix X" --parent GENT-XXX -d "Context..."
```

### Completing Work

```bash
lb close GENT-XXX --reason "Brief summary of what was done"
```

### Documenting Learnings

**Add comments to issues with insights that future readers would benefit from.** This includes:

- **What you tried that didn't work** and why (saves others from repeating dead ends)
- **Non-obvious constraints** discovered during implementation (API limits, edge cases)
- **Key decisions** and their rationale
- **Verification steps** that confirmed the fix works

Use `mcp__linear-server__create_comment` to add comments:
```
mcp__linear-server__create_comment with issueId: "GENT-XXX", body: "## What I learned\n\n..."
```

**Why this matters:**
- Future agents (and humans) will read these issues for context
- Prevents re-discovering the same constraints
- Creates institutional knowledge that persists across sessions

### Key Commands Reference

| Command | Purpose |
|---------|---------|
| `lb sync` | Sync with Linear |
| `lb ready` | Show unblocked issues you can work on |
| `lb list` | Show all issues |
| `lb show GENT-XXX` | Full issue details |
| `lb update GENT-XXX --status in_progress` | Claim work |
| `lb close GENT-XXX --reason "why"` | Complete work |
| `lb create "Title" --parent GENT-XXX -d "..."` | Create subtask |
| `lb update GENT-XXX --blocked-by GENT-YYY` | Set dependency |
| `lb update GENT-XXX --blocks GENT-YYY` | This issue blocks another |

### Dependency Management

**Always maintain the dependency graph.** When planning work:

1. **Identify dependencies** - What must be done before this task?
2. **Set blockers** - Use `--blocked-by` to mark prerequisites
3. **Create in order** - Parent issues first, then subtasks

```bash
# Example: Setting up a multi-phase project
lb create "Phase 1: Foundation" --parent GENT-XXX -d "..."
lb create "Phase 2: Build on foundation" --parent GENT-XXX -d "..."
lb create "Phase 3: Polish" --parent GENT-XXX -d "..."

# After syncing to get IDs:
lb sync
lb update GENT-P2 --blocked-by GENT-P1   # Phase 2 blocked by Phase 1
lb update GENT-P3 --blocked-by GENT-P2   # Phase 3 blocked by Phase 2
```

**If lb commands don't work for dependencies**, use Linear MCP tools directly:
```
mcp__linear-server__update_issue with blockedBy: ["GENT-XXX"]
```

**Why dependencies matter:**
- `lb ready` shows only unblocked work (what can actually be started)
- Prevents wasted effort on tasks whose prerequisites aren't done
- Documents the intended execution order for handoff

### Rules

1. **NEVER use TodoWrite** - use `lb create` for subtasks instead
2. **Always `lb sync` and `lb ready`** before asking what to work on
3. **Always `lb show`** to read the full description before starting
4. **Always `lb update --status in_progress`** before starting work
5. **Always include descriptions** with context for handoff
6. **Close issues with reasons** explaining what was done
7. **Maintain dependencies** - set `--blocked-by` when tasks have prerequisites
8. **Document learnings** - add comments with insights, failed approaches, and non-obvious constraints

## Git Workflow

Commit atomically as you work (one logical change per commit) unless told otherwise.

## Versioning

After committing changes, consider whether a version bump is warranted. If the changes add features, fix bugs, or make breaking changes:
1. Update version in `package.json` and `src/cli.ts`
2. Add entry to `CHANGELOG.md`

Version follows `0.X.0` format where X maps to the changelog version (e.g., v11 = 0.11.0).

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   lb sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
