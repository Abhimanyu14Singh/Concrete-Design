---
description: Generate comprehensive PR descriptions following repository templates
---

# Generate PR Description

You are tasked with generating a comprehensive pull request description following the repository's standard template.

## Steps to follow:

1. **Read the PR description template:**
   - First, check if `docs/pr_description.md` exists
   - If it doesn't exist, inform the user there is no PR description template and they should create one at `docs/pr_description.md` (or proceed with a sensible default set of sections: problem solved, user-facing changes, implementation, how to verify, changelog)
   - Read the template carefully to understand all sections and requirements

2. **Identify the PR to describe:**
   - Check if the current branch has an associated PR using the GitHub MCP tools (e.g. `mcp__github__list_pull_requests` filtered by `head`, or `mcp__github__pull_request_read`) against the `Abhimanyu14Singh/Concrete-Design` repo
   - If no PR exists for the current branch, or if on main/master, list open PRs with `mcp__github__list_pull_requests`
   - Ask the user which PR they want to describe

3. **Check for existing description:**
   - Check if `docs/prs/{number}_description.md` already exists
   - If it exists, read it and inform the user you'll be updating it
   - Consider what has changed since the last description was written

4. **Gather comprehensive PR information:**
   - Get the full PR diff and metadata via the GitHub MCP tools: `mcp__github__pull_request_read` (use its diff/files mode for the diff, and read modes for title, state, base branch, and commits) against the `Abhimanyu14Singh/Concrete-Design` repo
   - Use `mcp__github__list_commits` or the PR read tool's commits mode to get the commit history
   - Note the base branch from the PR metadata

5. **Analyze the changes thoroughly:** (ultrathink about the code changes, their architectural implications, and potential impacts)
   - Read through the entire diff carefully
   - For context, read any files that are referenced but not shown in the diff
   - Understand the purpose and impact of each change
   - Identify user-facing changes vs internal implementation details
   - Look for breaking changes or migration requirements

6. **Handle verification requirements:**
   - Look for any checklist items in the "How to verify it" section of the template
   - For each verification step:
     - If it's a command you can run (like `npm test`, `npm run lint`, or `npm run build`), run it
     - If it passes, mark the checkbox as checked: `- [x]`
     - If it fails, keep it unchecked and note what failed: `- [ ]` with explanation
     - If it requires manual testing (UI interactions, external services), leave unchecked and note for user
   - Document any verification steps you couldn't complete

7. **Generate the description:**
   - Fill out each section from the template thoroughly:
     - Answer each question/section based on your analysis
     - Be specific about problems solved and changes made
     - Focus on user impact where relevant
     - Include technical details in appropriate sections
     - Write a concise changelog entry
   - Ensure all checklist items are addressed (checked or explained)

8. **Save the description:**
   - Write the completed description to `docs/prs/{number}_description.md`
   - This file is saved in the repo; remind the user to commit it
   - Show the user the generated description

9. **Update the PR:**
   - Update the PR description directly with `mcp__github__update_pull_request` (set the `body` to the contents of `docs/prs/{number}_description.md`) against the `Abhimanyu14Singh/Concrete-Design` repo
   - Confirm the update was successful
   - If any verification steps remain unchecked, remind the user to complete them before merging

## Important notes:
- This command works across different repositories - always read the local template
- Be thorough but concise - descriptions should be scannable
- Focus on the "why" as much as the "what"
- Include any breaking changes or migration notes prominently
- If the PR touches multiple components, organize the description accordingly
- Always attempt to run verification commands when possible
- Clearly communicate which verification steps need manual testing
