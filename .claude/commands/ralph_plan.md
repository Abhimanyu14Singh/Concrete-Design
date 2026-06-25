---
description: Create implementation plan for highest priority GitHub issue ready for spec
argument-hint: "[optional issue number, e.g. #123]"
---

Requirements: GitHub MCP access to `Abhimanyu14Singh/Concrete-Design`.

## PART I - IF AN ISSUE IS MENTIONED

0c. fetch the selected issue with `mcp__github__issue_read` and save it into the repo at `docs/tickets/<issue#>.md` with the issue number (this file is committed to the repo)
0d. read the issue and all comments (`mcp__github__issue_read`) to learn about past implementations and research, and any questions or concerns about them


### PART I - IF NO ISSUE IS MENTIONED

0.  read .claude/commands/linear.md
0a. fetch the open issues labeled "ready-for-plan" using `mcp__github__list_issues` (sort by priority labels / reactions), noting any linked documents referenced in their bodies
0b. select the highest priority issue labeled SMALL or XS from the list (if no SMALL or XS issues exist, EXIT IMMEDIATELY and inform the user)
0c. fetch the selected issue with `mcp__github__issue_read` and save it into the repo at `docs/tickets/<issue#>.md` with the issue number (this file is committed to the repo)
0d. read the issue and all comments to learn about past implementations and research, and any questions or concerns about them

### PART II - NEXT STEPS

think deeply

1. mark the issue as plan-in-progress: apply the `plan-in-progress` label (and remove `ready-for-plan`) via `mcp__github__issue_write`
1a. read ./claude/commands/create_plan.md
1b. determine if the issue has a linked implementation plan document based on links referenced in the issue body or comments
1d. if the plan exists, you're done, respond with a link to the issue
1e. if the research is insufficient or has unanswered questions, create a new plan document following the instructions in ./claude/commands/create_plan.md

think deeply

2. when the plan is complete, the plan document lives at `docs/plans/...` in the repo and should be committed. Reference the doc in the issue by adding an `mcp__github__add_issue_comment` with a terse comment linking to the plan file path (re-read .claude/commands/linear.md if needed)
2a. mark the issue as plan-in-review: apply the `plan-in-review` label (and remove `plan-in-progress`) via `mcp__github__issue_write`

think deeply, use TodoWrite to track your tasks. When listing issues, review the top items by priority but only work on ONE item - specifically the highest priority SMALL or XS sized issue.

### PART III - When you're done


Print a message for the user (replace placeholders with actual values):

```
✅ Completed implementation plan for #123: [issue title]

Approach: [selected approach description]

The plan has been:

Created at docs/plans/YYYY-MM-DD-123-description.md (committed to the repo)
Referenced in a comment on the GitHub issue
Issue labeled "plan-in-review"

Implementation phases:
- Phase 1: [phase 1 description]
- Phase 2: [phase 2 description]
- Phase 3: [phase 3 description if applicable]

View the issue: https://github.com/Abhimanyu14Singh/Concrete-Design/issues/123
```
