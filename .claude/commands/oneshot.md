---
description: Research a GitHub issue, then hand off to a planning session
argument-hint: "[issue number, e.g. #123]"
---

1. use SlashCommand() to call /ralph_research with the given issue number
2. When research is complete, tell the user to continue with planning manually: "Research done. Start a new Claude Code session and run `/oneshot_plan #123` (substitute the issue number) to create and implement the plan."
