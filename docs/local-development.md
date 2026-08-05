# Local development on Windows — edit, see it live, ship an installer

The slow loop is: change something → push → wait for GitHub Actions → download the
installer → install it → look at it. That is several minutes per tweak.

This is the fast loop:

```
Claude Code in your terminal  →  saves a file  →  browser reloads instantly
```

No push, no Actions run, no install. You only build an installer when a change is
actually ready to hand to someone.

- **Repo:** `C:\Users\abhimanyu.singh\Documents\GitHub\Concrete-Design`
- **Everything below runs from that folder.**

---

## 1. One-time setup

### 1.1 Install the prerequisites

| Tool | Needed for | Install |
|---|---|---|
| **Node.js 22 LTS** | everything | <https://nodejs.org> — take the LTS installer |
| **Git** | pulling / pushing | <https://git-scm.com/download/win> |
| **Claude Code** | the terminal assistant | `npm install -g @anthropic-ai/claude-code` |
| **.NET SDK 6+** | *only* for a full installer | <https://dotnet.microsoft.com/download> |

The .NET SDK builds the two sidecar `.exe`s that talk to ETABS and S-Concrete. You
do **not** need it for browser development — skip it until you build an installer.

Close and reopen your terminal after installing, so `node`, `git` and `claude` are
on `PATH`. Check:

```powershell
node -v      # v22.x.x
git --version
claude --version
```

### 1.2 Get the code and install dependencies

Open **PowerShell** and run:

```powershell
cd C:\Users\abhimanyu.singh\Documents\GitHub\Concrete-Design

git fetch origin
git checkout claude/intelligent-sagan-ur1hkl
git pull

npm ci
```

`npm ci` takes a few minutes the first time. It installs exactly the versions in
`package-lock.json`, so you get the same tree CI uses.

> **Why this branch?** All the recent work — the doubly-reinforced M_Rd fix, the
> governing-DCR chips, the zoned-shear fix — is on
> `claude/intelligent-sagan-ur1hkl`, not on `main`.

### 1.3 Start Claude Code

```powershell
claude
```

First run asks you to sign in through the browser. After that, `claude` in this
folder gives you the same assistant you have been using on the web — except it
edits the files on your own disk, and you can see the result immediately.

---

## 2. The daily loop

Use **two terminals**, both in the repo folder.

**Terminal 1 — the app** (leave it running all day):

```powershell
npm run dev
```

Then open <http://localhost:5173>. Vite watches your files: when a file is saved
the browser updates in well under a second, keeping the page state.

**Terminal 2 — Claude Code:**

```powershell
claude
```

Now just ask, in plain language:

```
> the shear DCR chip is too small, make it match the flexure chip
> add a column for the governing load case to the All Load Cases table
> why is beam 6634 showing NG when every check passes?
```

Claude edits the file, Vite reloads, you look at the browser. Repeat. Nothing is
pushed anywhere until you say so.

### Seeing the desktop app instead of the browser

Most UI work is identical in both, so the browser is usually the right choice —
it reloads faster and has better devtools. But ETABS import, S-Concrete batches
and the pop-out Group Dashboard are **Electron-only** (they need the desktop
shell). For those:

```powershell
npm run dev:desktop
```

That starts Vite, waits for it, then opens the desktop app against it — with the
same hot reload. `Ctrl-C` stops both.

> ETABS import still needs the sidecar `.exe`s, which only exist after
> `npm run build:helper` (requires the .NET SDK).

### Checking your work

```powershell
npm run gate     # typecheck + all unit tests + production build
```

Run this before you commit. It is exactly what I run before every push, and it is
what catches a mistake before CI does. Faster subsets while iterating:

```powershell
npm test                 # unit tests only
npx vitest run src/engines/ec2   # just the EC2 engine tests
```

> `npm run lint` currently reports ~68 pre-existing problems on a clean checkout,
> so it is not a pass/fail signal. If you run it, compare against what it said
> *before* your change rather than expecting zero.

### Committing and pushing

Ask Claude ("commit this and push"), or do it yourself:

```powershell
git add -A
git commit -m "Shear chip sizing"
git push
```

---

## 3. Building the Windows installer

When a batch of changes is ready:

```powershell
.\scripts\build-installer.ps1
```

This runs the same steps as the GitHub Actions workflow — dependencies, .NET
sidecars, Vite build, then electron-builder/NSIS — and prints the path of the
finished file:

```
release\S-Dashboard Setup 0.1.1.exe
```

(The GitHub release page shows the same file as `S-Dashboard.Setup.0.1.1.exe` —
GitHub swaps spaces for dots in download links. Same installer.)

Double-click it to install. Expect roughly 3–6 minutes; the first run is slower
because Electron's binaries are downloaded and cached.

Useful switches:

```powershell
.\scripts\build-installer.ps1 -SkipGate      # skip typecheck/tests (faster)
.\scripts\build-installer.ps1 -Reinstall     # force a clean npm ci
.\scripts\build-installer.ps1 -SkipHelpers   # no .NET SDK — see the warning below
```

> ⚠️ **`-SkipHelpers` produces a crippled installer.** electron-builder does *not*
> fail when the sidecars are missing — it just logs `file source doesn't exist`
> and packages anyway. The app installs and the UI works, but **ETABS import and
> S-Concrete verification will not work**. Fine for showing someone a UI change;
> never hand it to someone who needs ETABS. Without `-SkipHelpers` the script
> stops early and tells you to install the .NET SDK, precisely so this cannot
> happen by accident.
>
> One wrinkle: `-SkipHelpers` skips *rebuilding* them, it does not remove them. If
> an earlier build left `build-helper\` on disk, those older binaries get packaged
> as-is. The script tells you which of the two happened; delete those folders if
> you want a genuinely helper-free build.

If PowerShell refuses to run the script:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-installer.ps1
```

### When to still use GitHub Actions

The local build is for you. Keep using the Actions build when you want a
**shareable, reproducible** installer — it builds from a clean checkout on a
clean machine and publishes a release others can download. Push your branch and
run the *Build Windows Installer* workflow as before.

---

## 4. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `'NODE_ENV' is not recognized...` | Old `electron:dev` script. `git pull` — it is fixed to be Windows-safe. |
| `Port 5173 is already in use` | Another Vite is running. Close that terminal, or `npm run dev -- --port 5174` (browser only — the desktop app expects 5173). |
| Desktop window is blank/white | Vite was not up yet. Use `npm run dev:desktop`, which waits for it. |
| `claude` not found | Reopen the terminal after `npm install -g`, or run `npm config get prefix` and confirm that folder is on `PATH`. |
| `dotnet` not found during install build | .NET SDK missing or terminal not reopened. Install it, or use `-SkipHelpers` (read the warning above). |
| Build fails right after `git pull` | Dependencies changed: `npm ci`. |
| ETABS import does nothing in the desktop app | Sidecars not built: `npm run build:helper`. Requires the .NET SDK, and ETABS must be running. |
| Tests fail but the app looks fine | Read the failure — it is usually a real regression. Paste it to Claude in Terminal 2. |

---

## 5. Cheat sheet

```powershell
npm run dev            # browser at http://localhost:5173  (main loop)
npm run dev:desktop    # desktop app + hot reload (ETABS / S-Concrete work)
claude                 # the assistant, in this repo

npm run gate           # typecheck + tests + build   (before committing)
npm test               # unit tests only

.\scripts\build-installer.ps1   # the Windows installer -> release\*.exe
```

See also: [`developer-guide.md`](developer-guide.md) for how the design engines are
laid out and how to add a design code.
