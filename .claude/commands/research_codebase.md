---
description: Document codebase as-is with docs directory for historical context
model: opus
---

# Research Codebase

You are tasked with conducting comprehensive research across the codebase to answer user questions by spawning parallel sub-agents and synthesizing their findings.

## CRITICAL: YOUR ONLY JOB IS TO DOCUMENT AND EXPLAIN THE CODEBASE AS IT EXISTS TODAY
- DO NOT suggest improvements or changes unless the user explicitly asks for them
- DO NOT perform root cause analysis unless the user explicitly asks for them
- DO NOT propose future enhancements unless the user explicitly asks for them
- DO NOT critique the implementation or identify problems
- DO NOT recommend refactoring, optimization, or architectural changes
- ONLY describe what exists, where it exists, how it works, and how components interact
- You are creating a technical map/documentation of the existing system

## Initial Setup:

When this command is invoked, respond with:
```
I'm ready to research the codebase. Please provide your research question or area of interest, and I'll analyze it thoroughly by exploring relevant components and connections.
```

Then wait for the user's research query.

## Steps to follow after receiving the research query:

1. **Read any directly mentioned files first:**
   - If the user mentions specific files (tickets, docs, JSON), read them FULLY first
   - **IMPORTANT**: Use the Read tool WITHOUT limit/offset parameters to read entire files
   - **CRITICAL**: Read these files yourself in the main context before spawning any sub-tasks
   - This ensures you have full context before decomposing the research

2. **Analyze and decompose the research question:**
   - Break down the user's query into composable research areas
   - Take time to ultrathink about the underlying patterns, connections, and architectural implications the user might be seeking
   - Identify specific components, patterns, or concepts to investigate
   - Create a research plan using TodoWrite to track all subtasks
   - Consider which directories, files, or architectural patterns are relevant

3. **Spawn parallel sub-agent tasks for comprehensive research:**
   - Create multiple Task agents to research different aspects concurrently
   - Use the built-in agents via the Task tool to do specific research tasks:

   **For codebase research:**
   - Use the **Explore** agent to find WHERE files and components live (locate intent)
   - Use the **Explore** agent to understand HOW specific code works, without critiquing it (analyze intent)
   - Use the **Explore** agent to find examples of existing patterns, without evaluating them (find-patterns intent)

   **IMPORTANT**: All agents are documentarians, not critics. They will describe what exists without suggesting improvements or identifying issues.

   **For docs/ directory (historical context):**
   - Use the **Explore** or **general-purpose** agent over `docs/` to discover what documents exist about the topic
   - Use the **Explore** or **general-purpose** agent over `docs/` to extract key insights from specific documents (only the most relevant ones)

   **For web research (only if user explicitly asks):**
   - Use **WebSearch** directly, or a **general-purpose** agent, for external documentation and resources
   - IF you use web research, instruct it to return LINKS with the findings, and please INCLUDE those links in your final report

   **For GitHub Issues (if relevant):**
   - Use the GitHub MCP tools (`mcp__github__issue_read`) to get full details of a specific issue
   - Use the GitHub MCP tools (`mcp__github__search_issues` / `mcp__github__list_issues`) to find related issues or historical context

   The key is to use these agents intelligently:
   - Start with locate-intent searches to find what exists
   - Then use analyze-intent searches on the most promising findings to document how they work
   - Run multiple agents in parallel when they're searching for different things
   - Each agent knows its job - just tell it what you're looking for
   - Remind agents they are documenting, not evaluating or improving

4. **Wait for all sub-agents to complete and synthesize findings:**
   - IMPORTANT: Wait for ALL sub-agent tasks to complete before proceeding
   - Compile all sub-agent results (both codebase and docs/ findings)
   - Prioritize live codebase findings as primary source of truth
   - Use docs/ findings as supplementary historical context
   - Connect findings across different components
   - Include specific file paths and line numbers for reference
   - Verify all docs/ paths are correct
   - Highlight patterns, connections, and architectural decisions
   - Answer the user's specific questions with concrete evidence

5. **Gather metadata for the research document:**
   - Gather all relevant metadata with Bash (e.g. `git rev-parse HEAD` for the commit hash, `git branch --show-current` for the branch, `date` for the timestamp, and the repository name `Abhimanyu14Singh/Concrete-Design`)
   - Filename: `docs/research/YYYY-MM-DD-ISSUE-description.md`
     - Format: `YYYY-MM-DD-ISSUE-description.md` where:
       - YYYY-MM-DD is today's date
       - ISSUE is the GitHub issue number prefixed with `#` (omit if no issue)
       - description is a brief kebab-case description of the research topic
     - Examples:
       - With issue: `2025-01-08-#123-parent-child-tracking.md`
       - Without issue: `2025-01-08-authentication-flow.md`

6. **Generate research document:**
   - Use the metadata gathered in step 4
   - Structure the document with YAML frontmatter followed by content:
     ```markdown
     ---
     date: [Current date and time with timezone in ISO format]
     researcher: [Researcher name]
     git_commit: [Current commit hash]
     branch: [Current branch name]
     repository: Abhimanyu14Singh/Concrete-Design
     topic: "[User's Question/Topic]"
     tags: [research, codebase, relevant-component-names]
     status: complete
     last_updated: [Current date in YYYY-MM-DD format]
     last_updated_by: [Researcher name]
     ---

     # Research: [User's Question/Topic]

     **Date**: [Current date and time with timezone from step 4]
     **Researcher**: [Researcher name]
     **Git Commit**: [Current commit hash from step 4]
     **Branch**: [Current branch name from step 4]
     **Repository**: Abhimanyu14Singh/Concrete-Design

     ## Research Question
     [Original user query]

     ## Summary
     [High-level documentation of what was found, answering the user's question by describing what exists]

     ## Detailed Findings

     ### [Component/Area 1]
     - Description of what exists ([file.ext:line](link))
     - How it connects to other components
     - Current implementation details (without evaluation)

     ### [Component/Area 2]
     ...

     ## Code References
     - `path/to/file.py:123` - Description of what's there
     - `another/file.ts:45-67` - Description of the code block

     ## Architecture Documentation
     [Current patterns, conventions, and design implementations found in the codebase]

     ## Historical Context (from docs/)
     [Relevant insights from the docs/ directory with references]
     - `docs/research/something.md` - Historical decision about X
     - `docs/plans/notes.md` - Past exploration of Y

     ## Related Research
     [Links to other research documents in docs/research/]

     ## Open Questions
     [Any areas that need further investigation]
     ```

7. **Add GitHub permalinks (if applicable):**
   - Check if on the main branch or if the commit is pushed: `git branch --show-current` and `git status`
   - If on main/master or pushed, generate GitHub permalinks:
     - The repository is `Abhimanyu14Singh/Concrete-Design` (owner `Abhimanyu14Singh`, repo `Concrete-Design`)
     - Create permalinks: `https://github.com/Abhimanyu14Singh/Concrete-Design/blob/{commit}/{file}#L{line}`
   - Replace local file references with permalinks in the document

8. **Present findings:**
   - The research document is saved in the repo at `docs/research/`; remember to commit it so the team has access
   - Present a concise summary of findings to the user
   - Include key file references for easy navigation
   - Ask if they have follow-up questions or need clarification

9. **Handle follow-up questions:**
   - If the user has follow-up questions, append to the same research document
   - Update the frontmatter fields `last_updated` and `last_updated_by` to reflect the update
   - Add `last_updated_note: "Added follow-up research for [brief description]"` to frontmatter
   - Add a new section: `## Follow-up Research [timestamp]`
   - Spawn new sub-agents as needed for additional investigation
   - Continue updating the document (and remember to commit the changes)

## Important notes:
- Always use parallel Task agents to maximize efficiency and minimize context usage
- Always run fresh codebase research - never rely solely on existing research documents
- The docs/ directory provides historical context to supplement live findings
- Focus on finding concrete file paths and line numbers for developer reference
- Research documents should be self-contained with all necessary context
- Each sub-agent prompt should be specific and focused on read-only documentation operations
- Document cross-component connections and how systems interact
- Include temporal context (when the research was conducted)
- Link to GitHub when possible for permanent references
- Keep the main agent focused on synthesis, not deep file reading
- Have sub-agents document examples and usage patterns as they exist
- Explore all of the docs/ directory, not just the research subdirectory
- **CRITICAL**: You and all sub-agents are documentarians, not evaluators
- **REMEMBER**: Document what IS, not what SHOULD BE
- **NO RECOMMENDATIONS**: Only describe the current state of the codebase
- **File reading**: Always read mentioned files FULLY (no limit/offset) before spawning sub-tasks
- **Critical ordering**: Follow the numbered steps exactly
  - ALWAYS read mentioned files first before spawning sub-tasks (step 1)
  - ALWAYS wait for all sub-agents to complete before synthesizing (step 4)
  - ALWAYS gather metadata before writing the document (step 5 before step 6)
  - NEVER write the research document with placeholder values
- **Path handling**: Historical context lives under `docs/` (e.g. `docs/research/`, `docs/plans/`, `docs/tickets/`)
  - Always reference docs/ paths exactly as they exist on disk so they are correct for editing and navigation
- **Frontmatter consistency**:
  - Always include frontmatter at the beginning of research documents
  - Keep frontmatter fields consistent across all research documents
  - Update frontmatter when adding follow-up research
  - Use snake_case for multi-word field names (e.g., `last_updated`, `git_commit`)
  - Tags should be relevant to the research topic and components studied
