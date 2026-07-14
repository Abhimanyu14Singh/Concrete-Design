---
description: Research highest priority GitHub issue needing investigation
argument-hint: "[optional issue number, e.g. #123]"
---

Requirements: GitHub MCP access to `Abhimanyu14Singh/Concrete-Design`.

## PART I - IF A GITHUB ISSUE IS MENTIONED

0c. fetch the selected issue with `mcp__github__issue_read` and save it into the repo at `docs/tickets/<issue#>.md` with the issue number (this file is committed to the repo)
0d. read the issue and all comments to understand what research is needed and any previous attempts

## PART I - IF NO ISSUE IS MENTIONED

0.  read .claude/commands/linear.md
0a. fetch the open issues labeled "research-needed" using `mcp__github__list_issues` (sort by priority labels / reactions), noting any linked documents referenced in their bodies
0b. select the highest priority issue labeled SMALL or XS from the list (if no SMALL or XS issues exist, EXIT IMMEDIATELY and inform the user)
0c. fetch the selected issue with `mcp__github__issue_read` and save it into the repo at `docs/tickets/<issue#>.md` with the issue number (this file is committed to the repo)
0d. read the issue and all comments to understand what research is needed and any previous attempts

## PART II - NEXT STEPS

think deeply

1. mark the issue as research-in-progress: apply the `research-in-progress` label (and remove `research-needed`) via `mcp__github__issue_write`
1a. read any linked documents referenced in the issue body or comments to understand context
1b. if insufficient information to conduct research, add a comment (`mcp__github__add_issue_comment`) asking for clarification and revert to the `research-needed` label

think deeply about the research needs

2. conduct the research:
2a. read .claude/commands/research_codebase.md for guidance on effective codebase research
2b. if the issue comments suggest web research is needed, use WebSearch to research external solutions, APIs, or best practices
2c. search the codebase for relevant implementations and patterns
2d. examine existing similar features or related code
2e. identify technical constraints and opportunities
2f. Be unbiased - don't think too much about an ideal implementation plan, just document all related files and how the systems work today
2g. document findings in a new document in the repo: `docs/research/YYYY-MM-DD-123-description.md`
   - Format: `YYYY-MM-DD-<issue#>-description.md` where:
     - YYYY-MM-DD is today's date
     - <issue#> is the issue number (omit if no issue)
     - description is a brief kebab-case description of the research topic
   - Examples:
     - With issue: `2025-01-08-123-parent-child-tracking.md`
     - Without issue: `2025-01-08-error-handling-patterns.md`

think deeply about the findings

3. synthesize research into actionable insights:
3a. summarize key findings and technical decisions
3b. identify potential implementation approaches
3c. note any risks or concerns discovered
3d. the research document lives at `docs/research/...` in the repo and should be committed

4. update the issue:
4a. reference the research document in the issue by adding a comment (`mcp__github__add_issue_comment`) with the plan/research file path
4b. add a comment summarizing the research outcomes
4c. mark the issue as research-in-review: apply the `research-in-review` label (and remove `research-in-progress`) via `mcp__github__issue_write`

think deeply, use TodoWrite to track your tasks. When listing issues, review the top items by priority but only work on ONE item - specifically the highest priority issue.

## PART III - When you're done

Print a message for the user (replace placeholders with actual values):

```
✅ Completed research for #123: [issue title]

Research topic: [research topic description]

The research has been:

Created at docs/research/YYYY-MM-DD-123-description.md (committed to the repo)
Referenced in a comment on the GitHub issue
Issue labeled "research-in-review"

Key findings:
- [Major finding 1]
- [Major finding 2]
- [Major finding 3]

View the issue: https://github.com/Abhimanyu14Singh/Concrete-Design/issues/123
```
