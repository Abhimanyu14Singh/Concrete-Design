---
description: Debug issues by investigating logs, app state, and git history
---

# Debug

You are tasked with helping debug issues during manual testing or implementation. This command allows you to investigate problems by examining logs, runtime/app state, and git history without editing files. Think of this as a way to bootstrap a debugging session without using the primary window's context.

## Initial Response

When invoked WITH a plan/issue file:
```
I'll help debug issues with [file name]. Let me understand the current state.

What specific problem are you encountering?
- What were you trying to test/implement?
- What went wrong?
- Any error messages?

I'll investigate the logs, app state, and git state to help figure out what's happening.
```

When invoked WITHOUT parameters:
```
I'll help debug your current issue.

Please describe what's going wrong:
- What are you working on?
- What specific problem occurred?
- When did it last work?

I can investigate logs, app state, and recent changes to help identify the issue.
```

## Environment Information

This is a TypeScript + React 19 + Vite + Electron app. There is no daemon or database; runtime evidence comes from dev-server output, the Electron main process, and the browser/renderer console.

You have access to these key locations and tools:

**Logs / output**:
- Vite dev server output: the terminal running `npm run dev` (compile errors, HMR failures, import resolution issues)
- Electron main process output: the terminal running `npm run electron:dev` (main-process and `electron/etabsBridge.cjs` errors)
- Renderer console: the Electron/browser DevTools console (open with F12 / Ctrl+Shift+I) — React errors, `console.error`/`console.log` calls, unhandled promise rejections. This is outside your direct reach; ask the user to copy relevant output.
- The C# ETABS helper under `tools/EtabsHelper/` writes its own stdout/stderr when invoked via the Electron bridge.

**App / runtime state**:
- There is no database. State lives in React (e.g. `src/contexts/`) and any persisted files the app writes.
- Reproduce by running `npm run dev` (browser) or `npm run electron:dev` (desktop) and exercising the failing flow.

**Git State**:
- Check current branch, recent commits, uncommitted changes
- Similar to how `commit` and `describe_pr` commands work

**Build / test status**:
- Type/build errors: `npm run build` (runs `tsc -b && vite build`)
- Lint: `npm run lint`
- Tests: `npm test` (Vitest)

## Process Steps

### Step 1: Understand the Problem

After the user describes the issue:

1. **Read any provided context** (plan or issue file):
   - Understand what they're implementing/testing
   - Note which phase or step they're on
   - Identify expected vs actual behavior

2. **Quick state check**:
   - Current git branch and recent commits
   - Any uncommitted changes
   - When the issue started occurring

### Step 2: Investigate the Issue

Spawn parallel Task agents for efficient investigation:

```
Task 1 - Reproduce via build/test/lint:
Surface compile-time and test errors:
1. Run `npm run build` (tsc -b && vite build) and capture type/build errors
2. Run `npm test` (Vitest) and capture failing tests and stack traces
3. Run `npm run lint` and capture relevant warnings/errors
4. Tie failures to the files and symbols involved in the problem
Return: Key errors/failures with file:line references
```

```
Task 2 - Locate and analyze the relevant code:
Use the built-in Explore agent to map the failing area:
1. Locate the components/engines/adapters/utils involved (src/components/, src/engines/, src/adapters/, src/utils/, src/types/, electron/, tools/EtabsHelper/)
2. Trace the data/control flow through the relevant code paths
3. Note state sources (e.g. React contexts in src/contexts/) and any console.error/console.log instrumentation
4. Look for recent edits or TODOs near the failure
Return: Relevant files, flow summary, and likely failure points
```

```
Task 3 - Git and File State:
Understand what changed recently:
1. Check git status and current branch
2. Look at recent commits: git log --oneline -10
3. Check uncommitted changes: git diff
4. Verify expected files exist
5. Look for any file permission issues
Return: Git state and any file issues
```

### Step 3: Present Findings

Based on the investigation, present a focused debug report:

```markdown
## Debug Report

### What's Wrong
[Clear statement of the issue based on evidence]

### Evidence Found

**From Build/Test/Lint** (`npm run build`, `npm test`, `npm run lint`):
- [Error/failure with file:line]
- [Pattern or repeated issue]

**From the Code**:
- [Relevant file:line and what it does]
- [Likely failure point]

**From Git/Files**:
- [Recent changes that might be related]
- [File state issues]

### Root Cause
[Most likely explanation based on evidence]

### Next Steps

1. **Try This First**:
   ```bash
   [Specific command or action]
   ```

2. **If That Doesn't Work**:
   - Reproduce in the app: `npm run dev` (browser) or `npm run electron:dev` (desktop)
   - Check the renderer DevTools console (F12 / Ctrl+Shift+I) for React/runtime errors
   - Check the terminal output of the Vite dev server and Electron main process

### Can't Access?
Some issues might be outside my reach:
- Renderer/DevTools console errors (F12 in the app)
- Electron main process / `tools/EtabsHelper/` runtime state
- System-level issues

Would you like me to investigate something specific further?
```

## Important Notes

- **Focus on manual testing scenarios** - This is for debugging during implementation
- **Always require problem description** - Can't debug without knowing what's wrong
- **Read files completely** - No limit/offset when reading context
- **Think like `commit` or `describe_pr`** - Understand git state and changes
- **Guide back to user** - Some issues (browser console, MCP internals) are outside reach
- **No file editing** - Pure investigation only

## Quick Reference

**Build / Test / Lint**:
```bash
npm run build   # tsc -b && vite build (type/build errors)
npm test        # Vitest
npm run lint    # ESLint
```

**Run the App**:
```bash
npm run dev          # Vite dev server (browser)
npm run electron:dev # Electron desktop app
```

**Git State**:
```bash
git status
git log --oneline -10
git diff
```

Remember: This command helps you investigate without burning the primary window's context. Perfect for when you hit an issue during manual testing and need to dig into build/test output, the code, or git state.
