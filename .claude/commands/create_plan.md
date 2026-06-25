---
description: Create detailed implementation plans through interactive research and iteration
argument-hint: "[ticket/issue reference or file path, e.g. docs/tickets/123.md]"
model: opus
---

# Implementation Plan

You are tasked with creating detailed implementation plans through an interactive, iterative process. You should be skeptical, thorough, and work collaboratively with the user to produce high-quality technical specifications.

## Initial Response

When this command is invoked:

1. **Check if parameters were provided**:
   - If a file path or ticket reference was provided as a parameter, skip the default message
   - Immediately read any provided files FULLY
   - Begin the research process

2. **If no parameters provided**, respond with:
```
I'll help you create a detailed implementation plan. Let me start by understanding what we're building.

Please provide:
1. The task/ticket description (or reference to a ticket file)
2. Any relevant context, constraints, or specific requirements
3. Links to related research or previous implementations

I'll analyze this information and work with you to create a comprehensive plan.

Tip: You can also invoke this command with a ticket file directly: `/create_plan docs/tickets/123.md`
For deeper analysis, try: `/create_plan think deeply about docs/tickets/123.md`
```

Then wait for the user's input.

## Process Steps

### Step 1: Context Gathering & Initial Analysis

1. **Read all mentioned files immediately and FULLY**:
   - Ticket/issue files (e.g., `docs/tickets/123.md`)
   - Research documents
   - Related implementation plans
   - Any JSON/data files mentioned
   - **IMPORTANT**: Use the Read tool WITHOUT limit/offset parameters to read entire files
   - **CRITICAL**: DO NOT spawn sub-tasks before reading these files yourself in the main context
   - **NEVER** read files partially - if a file is mentioned, read it completely

2. **Spawn initial research tasks to gather context**:
   Before asking the user any questions, use the Task tool to spawn agents to research in parallel:

   - Spawn the **Explore** agent (read-only code search) to locate all files related to the ticket/task
   - Spawn the **Explore** agent to analyze how the current implementation works
   - If relevant, spawn the **Explore** (or `general-purpose`) agent over `docs/` to find any existing research/plan documents about this feature
   - If a GitHub Issue is mentioned, look it up via the GitHub MCP tools (`mcp__github__issue_read` / `mcp__github__list_issues`) to get full details

   These agents will:
   - Find relevant source files, configs, and tests
   - Identify the specific directories to focus on (e.g., if the UI is mentioned, they'll focus on `src/components/`)
   - Trace data flow and key functions
   - Return detailed explanations with file:line references

3. **Read all files identified by research tasks**:
   - After research tasks complete, read ALL files they identified as relevant
   - Read them FULLY into the main context
   - This ensures you have complete understanding before proceeding

4. **Analyze and verify understanding**:
   - Cross-reference the ticket requirements with actual code
   - Identify any discrepancies or misunderstandings
   - Note assumptions that need verification
   - Determine true scope based on codebase reality

5. **Present informed understanding and focused questions**:
   ```
   Based on the ticket and my research of the codebase, I understand we need to [accurate summary].

   I've found that:
   - [Current implementation detail with file:line reference]
   - [Relevant pattern or constraint discovered]
   - [Potential complexity or edge case identified]

   Questions that my research couldn't answer:
   - [Specific technical question that requires human judgment]
   - [Business logic clarification]
   - [Design preference that affects implementation]
   ```

   Only ask questions that you genuinely cannot answer through code investigation.

### Step 2: Research & Discovery

After getting initial clarifications:

1. **If the user corrects any misunderstanding**:
   - DO NOT just accept the correction
   - Spawn new research tasks to verify the correct information
   - Read the specific files/directories they mention
   - Only proceed once you've verified the facts yourself

2. **Create a research todo list** using TodoWrite to track exploration tasks

3. **Spawn parallel sub-tasks for comprehensive research**:
   - Use the Task tool to spawn multiple agents to research different aspects concurrently
   - Tailor each spawn's prompt to the type of research:

   **For deeper investigation (spawn the Explore agent):**
   - Locate more specific files (e.g., "find all files that handle [specific component]")
   - Analyze implementation details (e.g., "analyze how [system] works")
   - Find similar features we can model after (existing patterns to reuse)

   **For historical context (spawn the Explore or `general-purpose` agent over `docs/`):**
   - Find any research, plans, or decisions about this area
   - Extract key insights from the most relevant documents

   **For related issues:**
   - Search GitHub Issues via the GitHub MCP tools (`mcp__github__search_issues` / `mcp__github__list_issues`) to find similar issues or past implementations

   Each agent knows how to:
   - Find the right files and code patterns
   - Identify conventions and patterns to follow
   - Look for integration points and dependencies
   - Return specific file:line references
   - Find tests and examples

3. **Wait for ALL sub-tasks to complete** before proceeding

4. **Present findings and design options**:
   ```
   Based on my research, here's what I found:

   **Current State:**
   - [Key discovery about existing code]
   - [Pattern or convention to follow]

   **Design Options:**
   1. [Option A] - [pros/cons]
   2. [Option B] - [pros/cons]

   **Open Questions:**
   - [Technical uncertainty]
   - [Design decision needed]

   Which approach aligns best with your vision?
   ```

### Step 3: Plan Structure Development

Once aligned on approach:

1. **Create initial plan outline**:
   ```
   Here's my proposed plan structure:

   ## Overview
   [1-2 sentence summary]

   ## Implementation Phases:
   1. [Phase name] - [what it accomplishes]
   2. [Phase name] - [what it accomplishes]
   3. [Phase name] - [what it accomplishes]

   Does this phasing make sense? Should I adjust the order or granularity?
   ```

2. **Get feedback on structure** before writing details

### Step 4: Detailed Plan Writing

After structure approval:

1. **Write the plan** to `docs/plans/YYYY-MM-DD-issue-XXX-description.md`
   - Format: `YYYY-MM-DD-issue-XXX-description.md` where:
     - YYYY-MM-DD is today's date
     - issue-XXX is the GitHub Issue number (omit if no issue)
     - description is a brief kebab-case description
   - Examples:
     - With issue: `2025-01-08-issue-148-parent-child-tracking.md`
     - Without issue: `2025-01-08-improve-error-handling.md`
2. **Use this template structure**:

````markdown
# [Feature/Task Name] Implementation Plan

## Overview

[Brief description of what we're implementing and why]

## Current State Analysis

[What exists now, what's missing, key constraints discovered]

## Desired End State

[A Specification of the desired end state after this plan is complete, and how to verify it]

### Key Discoveries:
- [Important finding with file:line reference]
- [Pattern to follow]
- [Constraint to work within]

## What We're NOT Doing

[Explicitly list out-of-scope items to prevent scope creep]

## Implementation Approach

[High-level strategy and reasoning]

## Phase 1: [Descriptive Name]

### Overview
[What this phase accomplishes]

### Changes Required:

#### 1. [Component/File Group]
**File**: `path/to/file.ext`
**Changes**: [Summary of changes]

```[language]
// Specific code to add/modify
```

### Success Criteria:

#### Automated Verification:
- [ ] Unit tests pass: `npm test`
- [ ] Type checking and build pass: `npm run build`
- [ ] Linting passes: `npm run lint`

#### Manual Verification:
- [ ] Feature works as expected when tested via UI
- [ ] Performance is acceptable under load
- [ ] Edge case handling verified manually
- [ ] No regressions in related features

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: [Descriptive Name]

[Similar structure with both automated and manual success criteria...]

---

## Testing Strategy

### Unit Tests:
- [What to test]
- [Key edge cases]

### Integration Tests:
- [End-to-end scenarios]

### Manual Testing Steps:
1. [Specific step to verify feature]
2. [Another verification step]
3. [Edge case to test manually]

## Performance Considerations

[Any performance implications or optimizations needed]

## Migration Notes

[If applicable, how to handle existing data/systems]

## References

- Original issue: `docs/tickets/XXX.md` (or GitHub Issue #XXX)
- Related research: `docs/research/[relevant].md`
- Similar implementation: `[file:line]`
````

### Step 5: Save and Review

1. **Save the plan in the repo**:
   - The plan is saved under `docs/plans/` in this repository
   - There is no external sync tool — remember to commit the new plan file to version control (GitHub) so it is tracked and shareable

2. **Present the draft plan location**:
   ```
   I've created the initial implementation plan at:
   `docs/plans/YYYY-MM-DD-issue-XXX-description.md`

   Please review it and let me know:
   - Are the phases properly scoped?
   - Are the success criteria specific enough?
   - Any technical details that need adjustment?
   - Missing edge cases or considerations?
   ```

3. **Iterate based on feedback** - be ready to:
   - Add missing phases
   - Adjust technical approach
   - Clarify success criteria (both automated and manual)
   - Add/remove scope items
   - After making changes, remember to commit the updated plan file

4. **Continue refining** until the user is satisfied

## Important Guidelines

1. **Be Skeptical**:
   - Question vague requirements
   - Identify potential issues early
   - Ask "why" and "what about"
   - Don't assume - verify with code

2. **Be Interactive**:
   - Don't write the full plan in one shot
   - Get buy-in at each major step
   - Allow course corrections
   - Work collaboratively

3. **Be Thorough**:
   - Read all context files COMPLETELY before planning
   - Research actual code patterns using parallel sub-tasks
   - Include specific file paths and line numbers
   - Write measurable success criteria with clear automated vs manual distinction
   - automated steps should use the repo's npm scripts whenever possible - for example `npm test`, `npm run lint`, and `npm run build`

4. **Be Practical**:
   - Focus on incremental, testable changes
   - Consider migration and rollback
   - Think about edge cases
   - Include "what we're NOT doing"

5. **Track Progress**:
   - Use TodoWrite to track planning tasks
   - Update todos as you complete research
   - Mark planning tasks complete when done

6. **No Open Questions in Final Plan**:
   - If you encounter open questions during planning, STOP
   - Research or ask for clarification immediately
   - Do NOT write the plan with unresolved questions
   - The implementation plan must be complete and actionable
   - Every decision must be made before finalizing the plan

## Success Criteria Guidelines

**Always separate success criteria into two categories:**

1. **Automated Verification** (can be run by execution agents):
   - Commands that can be run: `npm test`, `npm run lint`, `npm run build`, etc.
   - Specific files that should exist
   - Code compilation/type checking
   - Automated test suites

2. **Manual Verification** (requires human testing):
   - UI/UX functionality
   - Performance under real conditions
   - Edge cases that are hard to automate
   - User acceptance criteria

**Format example:**
```markdown
### Success Criteria:

#### Automated Verification:
- [ ] All unit tests pass: `npm test`
- [ ] No linting errors: `npm run lint`
- [ ] Type checking and build succeed: `npm run build`

#### Manual Verification:
- [ ] New feature appears correctly in the UI
- [ ] Performance is acceptable with 1000+ items
- [ ] Error messages are user-friendly
- [ ] Feature works correctly across the supported window sizes
```

## Common Patterns

### For Engine / Calculation Changes:
- Start with the data model / types (`src/types/`)
- Update the core calculation logic (`src/engines/`)
- Wire through adapters/utilities (`src/adapters/`, `src/utils/`)
- Surface results in the UI (`src/components/`)
- Cover with Vitest tests

### For New Features:
- Research existing patterns first
- Start with data model / types
- Build core logic (engines/adapters)
- Add Electron integration if needed (`electron/`)
- Implement UI last

### For Refactoring:
- Document current behavior
- Plan incremental changes
- Maintain backwards compatibility
- Include a migration strategy for any persisted/serialized data

## Sub-task Spawning Best Practices

When spawning research sub-tasks:

1. **Spawn multiple tasks in parallel** for efficiency
2. **Each task should be focused** on a specific area
3. **Provide detailed instructions** including:
   - Exactly what to search for
   - Which directories to focus on
   - What information to extract
   - Expected output format
4. **Be EXTREMELY specific about directories**:
   - If the work concerns the UI, specify `src/components/`
   - If it concerns calculation logic, specify `src/engines/`
   - If it concerns the desktop shell, specify `electron/`; for the ETABS helper, `tools/EtabsHelper/`
   - Use precise paths instead of generic terms like "UI" or "backend"
   - Include the full path context in your prompts
5. **Use the read-only Explore agent** for code search
6. **Request specific file:line references** in responses
7. **Wait for all tasks to complete** before synthesizing
8. **Verify sub-task results**:
   - If a sub-task returns unexpected results, spawn follow-up tasks
   - Cross-check findings against the actual codebase
   - Don't accept results that seem incorrect

Example of spawning multiple Explore agents concurrently (one Task tool call each, sent together):
- Explore: "Find the data model / types involved"
- Explore: "Analyze how the relevant engine logic works"
- Explore: "Investigate the related UI components in src/components/"
- Explore: "Find existing Vitest test patterns for this area"

## Example Interaction Flow

```
User: /create_plan
Assistant: I'll help you create a detailed implementation plan...

User: We need to add biaxial bending support to the column engine. See docs/tickets/148.md
Assistant: Let me read that ticket file completely first...

[Reads file fully]

Based on the ticket, I understand we need to extend the column design engine in src/engines/ to handle biaxial bending. Before I start planning, I have some questions...

[Interactive process continues...]
```
