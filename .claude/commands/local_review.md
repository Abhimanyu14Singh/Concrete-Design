---
description: Set up worktree for reviewing colleague's branch
---

# Local Review

You are tasked with setting up a local review environment for a colleague's branch. This involves creating a worktree and setting up dependencies, so the user can review the branch in a new Claude Code session started in the worktree directory.

## Process

When invoked with a parameter like `gh_username:branchName`:

1. **Parse the input**:
   - Extract GitHub username and branch name from the format `username:branchname`
   - If no parameter provided, ask for it in the format: `gh_username:branchName`

2. **Extract issue information**:
   - Look for a GitHub issue number in the branch name (e.g., `123` in `123-hotkey-for-yolo-mode`)
   - Use this to create a short worktree directory name
   - If no issue number found, use a sanitized version of the branch name

3. **Set up the remote and worktree**:
   - Check if the remote already exists using `git remote -v`
   - If not, add it: `git remote add USERNAME git@github.com:USERNAME/Concrete-Design`
   - Fetch from the remote: `git fetch USERNAME`
   - Create worktree: `git worktree add -b BRANCHNAME ../Concrete-Design-worktrees/SHORT_NAME USERNAME/BRANCHNAME`

4. **Configure the worktree**:
   - Copy Claude settings if present: `cp .claude/settings.local.json WORKTREE/.claude/`
   - Install dependencies: `cd WORKTREE && npm install`

## Error Handling

- If worktree already exists, inform the user they need to remove it first
- If remote fetch fails, check if the username/repo exists
- If setup fails, provide the error but continue

## Example Usage

```
/local_review abhimanyu14:123-hotkey-for-yolo-mode
```

This will:
- Add 'abhimanyu14' as a remote
- Create worktree at `../Concrete-Design-worktrees/123`
- Set up the environment
