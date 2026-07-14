---
description: Manage GitHub Issues - create, update, comment, and follow workflow patterns
argument-hint: "[issue number or topic, optional]"
---

# GitHub Issues - Issue Management

Requirements: GitHub MCP access to `Abhimanyu14Singh/Concrete-Design` (the `mcp__github__*` tools).

You are tasked with managing GitHub Issues for the `Abhimanyu14Singh/Concrete-Design` repository, including creating issues from docs documents, updating existing issues, and following the team's specific workflow patterns.

## Initial Setup

First, verify that the GitHub MCP tools are available by checking if any `mcp__github__` tools exist. If not, respond:
```
I need access to the GitHub MCP tools to help with issue management. Please run the `/mcp` command to enable the GitHub MCP server, then try again.
```

If tools are available, respond based on the user's request:

### For general requests:
```
I can help you with GitHub Issues. What would you like to do?
1. Create a new issue from a docs document
2. Add a comment to an issue (I'll use our conversation context)
3. Search for issues
4. Update issue status (labels / open-closed) or details
```

### For specific create requests:
```
I'll help you create a GitHub issue from your docs document. Please provide:
1. The path to the docs document (or topic to search for)
2. Any specific focus or angle for the issue (optional)
```

Then wait for the user's input.

## Team Workflow & Status Progression

GitHub has no built-in workflow states, so the workflow is modeled with **labels** on **open** issues, plus open/closed for the terminal states. The team follows this progression to ensure alignment before code implementation:

1. **triage** → All new issues start here (label `triage`) for initial review
2. **spec-needed** → More detail is needed - problem to solve and solution outline necessary
3. **research-needed** → Issue requires investigation before plan can be written
4. **research-in-progress** → Active research/investigation underway
5. **research-in-review** → Research findings under review (optional step)
6. **ready-for-plan** → Research complete, issue needs an implementation plan
7. **plan-in-progress** → Actively writing the implementation plan
8. **plan-in-review** → Plan is written and under discussion
9. **ready-for-dev** → Plan approved, ready for implementation
10. **in-dev** → Active development
11. **code-review** → PR submitted (link the PR to the issue)
12. **Done** → Completed (close the issue)

Move an issue between states by swapping these labels with `mcp__github__issue_write` (add the new state label, remove the old one). Closing the issue represents "Done"; reopening returns it to the active workflow.

**Key principle**: Review and alignment happen at the plan stage (not PR stage) to move faster and avoid rework.

## Important Conventions

### URL / Path References for Docs Documents
Documents live in this repository under `docs/`. When referencing them, use a backtick'd repo-relative path and, when helpful, a blob link:
- `docs/plans/...`, `docs/research/...`, `docs/tickets/...` → `https://github.com/Abhimanyu14Singh/Concrete-Design/blob/main/docs/...`

These docs are committed to this repo, so a path reference is usually sufficient.

### Default Values
- **Status**: Always create new issues with the `triage` label
- **Repository**: All issues live in `Abhimanyu14Singh/Concrete-Design` (GitHub has no separate "project" concept here)
- **Priority**: Default to a `priority:medium` label for most tasks, use best judgment or ask user
  - `priority:urgent`: Critical blockers, security issues
  - `priority:high`: Important features with deadlines, major bugs
  - `priority:medium`: Standard implementation tasks (default)
  - `priority:low`: Nice-to-haves, minor improvements
- **Links**: GitHub issues have no separate "links" field — include reference URLs inline in the issue body (and in comments) as markdown links

### Automatic Label Assignment
Automatically apply area labels based on the issue content:
- **frontend**: For issues about the React/Vite UI under `src/`
- **electron**: For issues about the Electron main/preload code under `electron/`
- **docs**: For issues about documentation under `docs/`

Issues can carry both `frontend` and `electron` when they span the renderer and main process.

## Action-Specific Instructions

### 1. Creating Issues from Docs

#### Steps to follow after receiving the request:

1. **Locate and read the docs document:**
   - If given a path, read the document directly
   - If given a topic/keyword, search the `docs/` directory using Grep to find relevant documents
   - If multiple matches found, show list and ask user to select
   - Create a TodoWrite list to track: Read document → Analyze content → Draft issue → Get user input → Create issue

2. **Analyze the document content:**
   - Identify the core problem or feature being discussed
   - Extract key implementation details or technical decisions
   - Note any specific code files or areas mentioned
   - Look for action items or next steps
   - Identify what stage the idea is at (early ideation vs ready to implement)
   - Take time to ultrathink about distilling the essence of this document into a clear problem statement and solution approach

3. **Check for related context (if mentioned in doc):**
   - If the document references specific code files, read relevant sections
   - If it mentions other docs documents, quickly check them
   - Look for any existing GitHub issues mentioned (search with `mcp__github__search_issues`)

4. **Get repository context:**
   - The repository is fixed: `Abhimanyu14Singh/Concrete-Design`
   - Review existing labels if needed (`mcp__github__get_label`) so you apply ones that exist

5. **Draft the issue summary:**
   Present a draft to the user:
   ```
   ## Draft GitHub Issue

   **Title**: [Clear, action-oriented title]

   **Description**:
   [2-3 sentence summary of the problem/goal]

   ## Key Details
   - [Bullet points of important details from docs]
   - [Technical decisions or constraints]
   - [Any specific requirements]

   ## Implementation Notes (if applicable)
   [Any specific technical approach or steps outlined]

   ## References
   - Source: `docs/[path/to/document.md]` ([View on GitHub](blob URL))
   - Related code: [any file:line references]
   - Parent issue: [if applicable]

   ---
   Based on the document, this seems to be at the stage of: [ideation/planning/ready to implement]
   ```

6. **Interactive refinement:**
   Ask the user:
   - Does this summary capture the issue accurately?
   - What priority? (Default: `priority:medium`)
   - Any additional context to add?
   - Should we include more/less implementation detail?
   - Do you want to assign it to yourself?

   Note: Issue will be created with the `triage` label by default.

7. **Create the GitHub issue:**
   ```
   mcp__github__issue_write with:
   - method: "create"
   - owner: "Abhimanyu14Singh"
   - repo: "Concrete-Design"
   - title: [refined title]
   - body: [final description in markdown, including reference URLs inline]
   - labels: [`triage`, the chosen `priority:*`, plus automatic area labels from above]
   - assignees: [if requested]
   ```

8. **Post-creation actions:**
   - Show the created issue URL (and issue number)
   - Ask if user wants to:
     - Add a comment with additional implementation details
     - Create sub-issues for specific action items (`mcp__github__sub_issue_write`)
     - Update the original docs document with the issue reference
   - If yes to updating docs doc:
     ```
     Add at the top of the document:
     ---
     github_issue: [URL]
     created: [date]
     ---
     ```

## Example transformations:

### From verbose docs notes:
```
"I've been thinking about how our resumed sessions don't inherit permissions properly.
This is causing issues where users have to re-specify everything. We should probably
store all the config and then pull it when resuming. Maybe we need new fields for
permission_prompt_tool and allowed_tools..."
```

### To concise issue:
```
Title: Fix resumed sessions to inherit all configuration from parent

Description:

## Problem to solve
Currently, resumed sessions only inherit Model and WorkingDir from parent sessions,
causing all other configuration to be lost. Users must re-specify permissions and
settings when resuming.

## Solution
Store all session configuration and automatically inherit it when
resuming sessions, with support for explicit overrides.
```

### 2. Adding Comments and References to Existing Issues

When user wants to add a comment to an issue:

1. **Determine which issue:**
   - Use context from the current conversation to identify the relevant issue
   - If uncertain, use `mcp__github__issue_read` to show issue details and confirm with user
   - Look for issue references (e.g. `#123`) in recent work discussed

2. **Format comments for clarity:**
   - Attempt to keep comments concise (~10 lines) unless more detail is needed
   - Focus on the key insight or most useful information for a human reader
   - Not just what was done, but what matters about it
   - Include relevant file references with backticks and (when helpful) blob links

3. **File reference formatting:**
   - Wrap paths in backticks: `docs/research/example.md`
   - Optionally add a blob link after: `([View](url))`
   - Do this for both docs/ and code files mentioned

4. **Comment structure example:**
   ```markdown
   Implemented retry logic in the export handler to address rate limit issues.

   Key insight: The 429 responses were clustered during batch operations,
   so exponential backoff alone wasn't sufficient - added request queuing.

   Files updated:
   - `electron/export/handler.ts` ([GitHub](link))
   - `docs/research/rate_limit_analysis.md` ([GitHub](link))
   ```

5. **Handle references properly:**
   - GitHub issues have no separate links field — put reference URLs/paths inline in the comment body
   - If only adding a reference: still create a comment noting what reference was added for posterity

6. **For a comment referencing a document:**
   ```
   mcp__github__add_issue_comment with:
   - owner: "Abhimanyu14Singh"
   - repo: "Concrete-Design"
   - issue_number: [issue number]
   - body: [formatted comment with key insights and file references, links inline]
   ```

7. **For a reference-only note:**
   ```
   mcp__github__add_issue_comment with:
   - owner: "Abhimanyu14Singh"
   - repo: "Concrete-Design"
   - issue_number: [issue number]
   - body: "Added reference: `path/to/document.md` ([View](url))"
   ```

### 3. Searching for Issues

When user wants to find issues:

1. **Gather search criteria:**
   - Query text
   - Label filters (workflow state, area, priority)
   - Open/closed state
   - Date ranges (created, updated)

2. **Execute search:**
   ```
   mcp__github__search_issues with:
   - query: [GitHub search query, e.g. "repo:Abhimanyu14Singh/Concrete-Design is:issue is:open label:ready-for-plan <text>"]
   ```
   (or use `mcp__github__list_issues` with `owner`/`repo`/`labels`/`state` for simple label filtering)

3. **Present results:**
   - Show issue number, title, state (open/closed + workflow label), assignee
   - Group by area label if helpful
   - Include direct links to the issues on GitHub

### 4. Updating Issue Status

When moving issues through the workflow (state is modeled with labels — see Team Workflow above):

1. **Get current status:**
   - Fetch issue details with `mcp__github__issue_read`
   - Show current workflow label (and open/closed) in the progression

2. **Suggest next status:**
   - triage → spec-needed (lacks detail/problem statement)
   - spec-needed → research-needed (once problem/solution outlined)
   - research-needed → research-in-progress (starting research)
   - research-in-progress → research-in-review (optional, can skip to ready-for-plan)
   - research-in-review → ready-for-plan (research approved)
   - ready-for-plan → plan-in-progress (starting to write plan)
   - plan-in-progress → plan-in-review (plan written)
   - plan-in-review → ready-for-dev (plan approved)
   - ready-for-dev → in-dev (work started)
   - in-dev → code-review (PR submitted) → Done (close the issue)

3. **Update with context:**
   ```
   mcp__github__issue_write with:
   - method: "update"
   - owner: "Abhimanyu14Singh"
   - repo: "Concrete-Design"
   - issue_number: [issue number]
   - labels: [the new full label set — add the new state label, drop the previous one]
   # to mark Done, also set state: "closed"
   ```

   Consider adding a comment explaining the status change.

## Important Notes

- Tag users in descriptions and comments using GitHub's `@username` mention format
- Keep issues concise but complete - aim for scannable content
- All issues should include a clear "problem to solve" - if the user asks for an issue and only gives implementation details, you MUST ask "To write a good issue, please explain the problem you're trying to solve from a user perspective"
- Focus on the "what" and "why", include "how" only if well-defined
- Always preserve links to source material as inline markdown links in the body/comments
- Don't create issues from early-stage brainstorming unless requested
- Use proper GitHub-flavored markdown formatting
- Include code references as: `path/to/file.ext:linenum`
- Ask for clarification rather than guessing labels/status
- Remember that GitHub issue bodies support full markdown including code blocks
- remember - you must get a "Problem to solve"!

## Comment Quality Guidelines

When creating comments, focus on extracting the **most valuable information** for a human reader:

- **Key insights over summaries**: What's the "aha" moment or critical understanding?
- **Decisions and tradeoffs**: What approach was chosen and what it enables/prevents
- **Blockers resolved**: What was preventing progress and how it was addressed
- **State changes**: What's different now and what it means for next steps
- **Surprises or discoveries**: Unexpected findings that affect the work

Avoid:
- Mechanical lists of changes without context
- Restating what's obvious from code diffs
- Generic summaries that don't add value

Remember: The goal is to help a future reader (including yourself) quickly understand what matters about this update.

## Labels Reference

Repository: `Abhimanyu14Singh/Concrete-Design`. GitHub identifies labels by name (not numeric IDs), so reference them by name. Confirm a label exists with `mcp__github__get_label` before applying; create any missing ones out-of-band if the workflow requires them.

### Workflow state labels (applied to open issues; "Done" = closed)
- `triage`
- `spec-needed`
- `research-needed`
- `research-in-progress`
- `research-in-review`
- `ready-for-plan`
- `plan-in-progress`
- `plan-in-review`
- `ready-for-dev`
- `in-dev`
- `code-review`
- (Done → close the issue; Backlog/Todo → `backlog` / `todo`; Duplicate/Canceled → close with `duplicate` / `wontfix`)

### Area labels
- `frontend` — React/Vite UI under `src/`
- `electron` — Electron main/preload under `electron/`
- `docs` — documentation under `docs/`

### Other labels
- `bug`
- `priority:urgent`, `priority:high`, `priority:medium`, `priority:low`

## Users

Assign and mention collaborators by their GitHub `@username`. List who can be assigned with `mcp__github__list_repository_collaborators` for `Abhimanyu14Singh/Concrete-Design`.
