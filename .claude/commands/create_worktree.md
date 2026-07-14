---
description: Create a git worktree and start an implementation session for a plan
argument-hint: "[issue# or plan file]"
---

# Create Worktree

You are tasked with creating a git worktree for implementing a plan, then handing the user a command to start the implementation session.

1. determine required data:

- branch name (use `<issue#>-<kebab-title>`, e.g. `123-fix-column-keepalive`; if there is no GitHub issue, use a short kebab-case description)
- path to plan file (use a repo-relative path, e.g. `docs/plans/fix-column-keepalive.md`)
- worktree path (e.g. `../Concrete-Design-worktrees/<issue#>`)

2. set up the worktree for implementation:

```bash
git worktree add -b BRANCH_NAME ../Concrete-Design-worktrees/<issue#>
```

**IMPORTANT PATH USAGE:**
- The plan file lives in the repo under `docs/plans/...`, so it is present in the worktree at the same relative path.
- Always refer to it with its repo-relative path (e.g. `docs/plans/fix-column-keepalive.md`), not an absolute path.

3. confirm with the user:

```
based on the input, I plan to create a worktree with the following details:

worktree path: ../Concrete-Design-worktrees/<issue#>
branch name: BRANCH_NAME
path to plan file: $FILEPATH

After it's created, start a new Claude Code session in the worktree directory and run:

    /implement_plan at $FILEPATH and when you are done implementing and all tests pass (`npm test`, `npm run lint`, and `npm run build`), read .claude/commands/commit.md and create a commit, then read .claude/commands/describe_pr.md and create a PR, then add a comment to the GitHub issue with the PR link (via the GitHub MCP tools against the Abhimanyu14Singh/Concrete-Design repo)
```

incorporate any user feedback, then:

4. create the worktree with the command from step 2, and tell the user to start a new Claude Code session in the worktree directory (`../Concrete-Design-worktrees/<issue#>`) and run the `/implement_plan ...` command shown above.
