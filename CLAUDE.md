# S-Dashboard — working notes for Claude Code

Reinforced-concrete design app (ACI 318-19 + EN 1992-1-1). React 19 + TypeScript +
Vite, packaged as an Electron desktop app. Workflow the app serves:
**ETABS import → design → group dashboard → S-Concrete verification**.

New to local setup? See [`docs/local-development.md`](docs/local-development.md).

## Commands

```bash
npm run dev            # browser dev server → http://localhost:5173
npm run dev:desktop    # Electron + hot reload (ETABS / S-Concrete features)
npm run gate           # tsc -b && vitest run && vite build  ← run before committing
npm test               # unit tests only
npx vitest run src/engines/ec2      # one area, fast
```

`npm run gate` is the bar for "done". A >500 kB chunk warning from the build is
expected and benign.

Windows installer: `.\scripts\build-installer.ps1` (mirrors the CI workflow).

## Layout

| Path | What lives there |
|---|---|
| `src/engines/` | Design engines. `ec2/ec2Beam.ts`, `ec2/ec2Column.ts`, and `index.ts` (`runDesign` dispatches by code). |
| `src/utils/concreteDesign.ts` | The ACI 318 beam engine. |
| `src/utils/calcBreakdown*.ts` | The step-by-step Calc Sheet. **Must agree with the engine.** |
| `src/components/Results/` | Member design panel (`MemberResults.tsx`). |
| `src/components/Dashboard/` | Dashboard tab + in-map Group Dashboard + `dashboardShared.tsx`. |
| `src/components/ModelMap/` | Plan view, grouping, the map canvas. |
| `src/adapters/etabs/` | ETABS import, station forces → load cases. |
| `src/utils/sco/` | S-Concrete `.SCO` writers and `.SCRS` parsing. |
| `electron/` | Main process, preload, ETABS + S-Concrete bridges. |
| `electron/usageLog.cjs` + `src/utils/usage.ts` | The local usage log. See [`docs/usage-log.md`](docs/usage-log.md). |
| `tools/` | .NET sidecars (`EtabsHelper`, `SConcreteHelper`). |

## Conventions

- **Units:** engines work in **imperial internally** (in, psi, kips, kip-ft). The
  EC2 engine converts to SI at its boundary and back out. Display formatting goes
  through `useUnits()` / `fmt` — never hand-format a number with units.
- **EC2 has no φ.** `phi_Mn_*` / `phi_Vn` hold γ-factored *design resistances*
  (M_Rd, V_Rd). Do not apply a second reduction factor.
- **Engine vs display.** Engines always return true DCRs and warnings. Engineer
  overrides ("Reviewed") are a **display layer** (`src/utils/overrides.ts`) —
  never suppress a result inside an engine.
- **Every engine change needs a test.** Prefer a hand-checked or S-CONCRETE-checked
  number over a snapshot.

## Gotchas that have bitten before

- **A member has MANY load rows.** ETABS import expands to one `LoadCase` per
  station per combo (`stationLoadCases`). Different rows govern different checks —
  so any summary must take the **max across all rows per check**, never row `[0]`
  or a single "representative" row. This has caused three separate bugs.
- **Governing ≠ selected.** Check chips show the governing DCR across all rows;
  the Calc Sheet shows the *selected* row. If you change one, keep them consistent
  (expanding a check jumps the selection to that check's governing row).
- **Zoned stirrups.** With `rebar.tieZones`, shear capacity is evaluated at the
  spacing of the zone the demand sits in (`LoadCase.x`). Detailing limits
  (`s_max`, ρw) and torsion still use the worst/loosest zone.
- **`transform: scale` breaks `position: fixed`.** `App.tsx` wraps content in a
  zoom transform, which makes it the containing block for fixed descendants. Any
  popover/menu/dropdown **must portal to `document.body`** (see `Dropdown.tsx`) or
  it will render in the wrong place at non-100% Display Scale.
- **`.scdb` compatibility is a contract, not a hope.** `FILE_VERSION` is
  `MAJOR.MINOR`. MINOR = purely additive, and both directions must keep working:
  every spread in `saveLoad.ts` is open, so a newer file's unknown fields survive
  load → save in an older build. Adding an optional field → bump MINOR and note it
  in the history block. Changing what an existing field MEANS, or adding a design
  code an older build can't run → bump MAJOR, which older builds refuse. Migration
  branches on FIELD PRESENCE, never on the version. Freeze a fixture per version in
  `src/utils/__tests__/fixtures/projects/` and never edit an old one.
- **Calc Sheet drift.** `calcBreakdownEC2.ts` re-derives values for display. When
  you change an engine formula, update the Calc Sheet too, or the panel and the
  calc will disagree. The ACI sheet has a second flavour of this: `a` has **three**
  derivations (singly / doubly / flange-split) and the sheet must print the one that
  ran — `computeFlexure` returns `mode_pos` / `mode_neg` so it can.
- **A flange only counts when it's in compression.** T/L beams are flanged in
  SAGGING only; hogging puts the flange in tension and the section is a plain
  rectangle of width `bw`. `computeFlexure` takes an explicit `flangeInComp` flag —
  running the flange split for hogging inflated `a` by a whole `hf`.
- **There are TWO Suggest sweeps.** `WorkspaceView.runSuggestAll` drives the shared
  `createSweep` in `workspace/design.js`; `ModelMapView.runSuggestAllGroups`
  re-implements the same loop for the map's group list. They already differ — the map's
  keeps only the FIRST error and says nothing about torsion. Change one and you have
  changed half the app; both must emit `suggest.sweep` (they carry `from: 'workspace' |
  'map'` so the log can tell them apart).
- **Every `SuggestError` return needs a `kind`.** It is what lets a sweep be counted by
  reason instead of by prose (`suggest.sweep.reasons`). A return added without one lands
  in the `unclassified` bucket, and `suggestSweepStats.test.ts` fails when that bucket is
  non-empty.
- **The usage log must never carry model data.** `track()` takes counts, durations,
  enums and booleans — never a project, member, group or file name, and never a review
  note. IPC arguments are dropped unless a channel opts in via `DESCRIBERS` in
  `usageLog.cjs`. Paths leak client names, so `scrub()` reduces them to `<path.edb>`;
  its patterns allow SPACES inside segments on purpose (`C:\Jobs\Acme Tower\…`) — a
  `\S`-based pattern stops at the first space and publishes the rest. Anything added to
  the log needs a case in `usageLog.test.ts`.
- **`instrumentIpc` must run before the first `ipcMain.handle`.** It wraps the registrar,
  so a handler registered ahead of it is never instrumented. It is the second statement
  in `main.cjs` for that reason.
- **εt is measured at `dt`, not `d`.** §21.2.2 reads the strain in the *extreme*
  tension layer; `d` is the group centroid. And the φ transition band is
  `εty → εty + 0.003` (`phiFlexure`), which moves with the grade — Grade 60's
  0.002/0.005 is not a constant.
