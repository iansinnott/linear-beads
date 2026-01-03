# lb-cli

## Issue Tracking

This project uses **lb-dev** (the dev version of lb) for issue tracking via Linear.

**Quick reference:**
- `lb-dev sync` - Sync with Linear
- `lb-dev ready` - Find unblocked work
- `lb-dev create "Title" -d "Description"` - Create issue
- `lb-dev close <id> --reason "why"` - Complete work

Run `lb-dev --help` for full command list.

**Setup:** `lb-dev` should be aliased in your shell:
```bash
alias lb-dev='bun run /Users/ian/dev/linear-beads/src/cli.ts'
```

---

## CRITICAL: Task Tracking with `lb-dev`

**DO NOT use the TodoWrite/TodoRead tools. NEVER. Use `lb-dev` instead.**

### Before Starting ANY Work

```bash
lb-dev sync                    # Pull latest from Linear
lb-dev ready                   # See unblocked work
lb-dev show GENT-XXX           # Read full description before starting
lb-dev update GENT-XXX --status in_progress   # Claim it
```

### Planning Work

When you need to break down a task into steps, **create subtasks in lb-dev**, not mental notes or TodoWrite:

```bash
lb-dev create "Step 1: Do X" --parent GENT-XXX -d "Details..."
lb-dev create "Step 2: Do Y" --parent GENT-XXX -d "Details..."
```

### During Work

```bash
# Found something that needs doing? Create an issue
lb-dev create "Found: need to fix X" --parent GENT-XXX -d "Context..."

# Discovered a blocker or dependency?
lb-dev update GENT-AAA --deps blocks:GENT-BBB   # AAA blocks BBB
```

### Completing Work

```bash
lb-dev close GENT-XXX --reason "Brief summary of what was done"
```

### Key Commands Reference

| Command | Purpose |
|---------|---------|
| `lb-dev sync` | Sync with Linear |
| `lb-dev ready` | Show unblocked issues you can work on |
| `lb-dev list` | Show all issues |
| `lb-dev show GENT-XXX` | Full issue details |
| `lb-dev update GENT-XXX --status in_progress` | Claim work |
| `lb-dev close GENT-XXX --reason "why"` | Complete work |
| `lb-dev create "Title" --parent GENT-XXX -d "..."` | Create subtask |

### Rules

1. **NEVER use TodoWrite** - use `lb-dev create` for subtasks instead
2. **Always `lb-dev sync` and `lb-dev ready`** before asking what to work on
3. **Always `lb-dev show`** to read the full description before starting
4. **Always `lb-dev update --status in_progress`** before starting work
5. **Always include descriptions** with context for handoff
6. **Close issues with reasons** explaining what was done

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
   lb-dev sync
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
