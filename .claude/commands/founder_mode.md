---
description: Create a GitHub issue and PR for experimental features after implementation
---

Requirements: GitHub MCP access to `Abhimanyu14Singh/Concrete-Design`.

you're working on an experimental feature that didn't get the proper issue-tracking and PR stuff set up.

assuming you just made a commit, here are the next steps:


1. get the sha of the commit you just made (if you didn't make one, read `.claude/commands/commit.md` and make one)

2. read `.claude/commands/linear.md` - think deeply about what you just implemented, then create a GitHub issue about what you just did using the GitHub MCP tools (`mcp__github__issue_write`). Leave it open and apply an `in-dev` label. It should have ### headers for "problem to solve" and "proposed solution"
3. derive a git branch name from the new issue: `<issue#>-<kebab-title>` (GitHub does not auto-generate one)
4. git checkout main
5. git checkout -b 'BRANCHNAME'
6. git cherry-pick 'COMMITHASH'
7. git push -u origin 'BRANCHNAME'
8. open a pull request with the GitHub MCP tools (`mcp__github__create_pull_request`), targeting `main` and referencing the issue (e.g. "Closes #123") in the body
9. read '.claude/commands/describe_pr.md' and follow the instructions
