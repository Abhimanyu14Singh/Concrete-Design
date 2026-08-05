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
- **Calc Sheet drift.** `calcBreakdownEC2.ts` re-derives values for display. When
  you change an engine formula, update the Calc Sheet too, or the panel and the
  calc will disagree.
