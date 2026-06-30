# Column_Design_DW → Concrete-Design merge — change summary

This document records the merge of the standalone **Column_Design_DW** Python/Dash
column tool into this TypeScript/React/Electron app, plus the removal of the
shear-wall feature. It is organised by area; each entry notes the key files and
the validation status.

**Validation legend**
- **golden-vector validated** — the TS port is checked 1:1 against the calibrated
  Python engine run headless on Linux (byte/numeric fixtures committed under
  `parity/` and `__tests__/fixtures/`).
- **needs Windows confirmation** — the logic is unit-tested for structure/inputs,
  but the live round-trip (ETABS or S-Concrete on Windows) can only be exercised
  on that platform. This is the same boundary the source repo carries.

---

## Design engine — biaxial columns

The rotating neutral-axis biaxial moment solver was ported from the Python tool
and wired in as the primary P-M method for rectangular biaxial columns; the
Bresler reciprocal method remains the fallback for layouts that don't map.

- Files: `src/engines/aci/aciColumnBiaxial.ts` (solver), `src/engines/aci/aciColumn.ts`
  (`designColumnACI` integration), `src/engines/aci/__tests__/columnParity.test.ts`.
- Status: **golden-vector validated** (parity tightened to `moment_res_util` within
  0.02 across the 10 calibration cases).
- Commits: `1d8a6fd` (port the solver), `05080cf` (wire into `designColumnACI` +
  tighten parity).
- Follow-up gap closure (`84fe351`): column **torsion** (axial-dependent φTcr +
  closed-hoop φTn + V&T utilisation, ACI §22.7) and **slenderness** flag (Euler
  Ncr, `|Pu| > 0.75·Ncr`, ACI §6.6.4.4.2), plus the §25.2.3 clear-spacing
  detailing warning — all in `src/engines/aci/aciColumn.ts`, ported from
  design_engine.py and unit-tested. Audited gaps deliberately NOT ported: column
  import FROM ETABS (live table reads are Windows-only) and circular-column .SCO
  (needs a Member-Type-4 circular sample).

## Automatic column design

Inverse design for columns — the signature `auto_size` / `auto_design` capability
of the Python tool — now backs the **✨ Suggest** button for column groups.

- **Auto-design** (`src/utils/suggestColumnRebar.ts`): lightest symmetric cage
  (longitudinal + ties) meeting the group's worst demand at the target DCR with
  ρg held in ACI §10.6.1's 1–8% band. P-M/axial are independent of the ties, so
  the search is decoupled (cage first, ties second) and each candidate is
  re-verified through the engine.
- **Auto-size section** (`src/utils/autoSizeColumn.ts`): when no cage fits within
  ρ ≤ 8%, recommend a minimum section via the ACI §22.4.2 axial sizing.
- **Splice length** (`src/utils/spliceLength.ts`): ACI §25.5 compression and
  tension (Class A/B) laps, surfaced in the column calc sheet.
- Status: pure functions, **verified against the validated engine** in tests.
- Commits: `8c9bf98` (auto-design), `6d5ad50` (splice + auto-size).

## Quantity takeoffs and multi-story stacks

- **Takeoffs** (`src/utils/takeoff.ts`, `TakeoffPanel`): gross concrete volume,
  rebar tonnage, and per-GFA intensities for beams and columns; a **Takeoff** tab
  in the Map view. Commit `64e558b`.
- **Multi-story stacks** (`src/utils/columnStack.ts`, `ColumnStacksPanel`): group
  columns by plan location, per-story Pu/ρ/φPn/DCR, and capacity-vs-elevation
  data; a **Stacks** tab. Derived on the fly — no project-file change. Commit
  `e37588c`.
- **Formula-traceable Excel** (`src/utils/export/excelExport.ts`): per-member
  sheets write live spreadsheet formulas for the axial/geometry chain (Ag, ρ,
  φPn,max, DCR_axial) so the workbook recomputes on edit. Commit `0ce29e1`.
- Status: pure, unit-tested.

## ETABS group push-back

Push the app's design groups back into the ETABS model as named groups with their
member frames assigned, via the bundled .NET sidecar.

- Files: `src/adapters/etabs/pushGroups.ts`, `src/adapters/etabs/comClient.ts`,
  `tools/EtabsHelper/Program.cs` (`setGroupAssign`), `electron/etabsBridge.cjs`,
  `src/components/ModelMap/GroupActionsPanel.tsx`.
- Status: payload-building unit-tested; the live ETABS assignment **needs Windows
  confirmation**.
- Commits: `d1e0f0e` (sidecar + bridge + adapter), `b15e4a2` (group-actions UI).

## S-Concrete .SCO / .SCRS batch

Generate S-Concrete `.SCO` files for the design groups, run the BatchReporter, and
pull per-member results from the `.SCRS`.

- **Writers** (`src/utils/sco/scoWriter.ts`): byte-validated rectangular-column
  writer (Member Type 3, 1:1 with `sco_writer.py`) and a beam writer (Member Type
  1). `.SCRS` parser in `scrsParser.ts`. Commits `3a6b5ac`, `0ef43ef`, `c745db1`.
- **Batch orchestration** (`src/utils/sco/scoBatch.ts`): `buildGroupScoFiles`
  dispatches by code/section; `buildScoFilesByGroup` / `collectGroupScoFiles`
  scope a run to the user's design groups (union, de-duplicated, with a no-groups
  fallback). The run mechanism (`electron/sconcreteBridge.cjs`) mirrors the column
  repo's — write `.SCO`s → `python run_batch_reporter.py <dir> --title --engineer`
  → read `SConcreteResults.SCRS` — and additionally waits for exit and returns the
  parsed results. Commits `a33a83c`, `3a7e00e`, `e4bf49f`, `68ae69c`.
- **EC2 beams & columns** (`src/utils/sco/scoWriterEC2.ts`): the EC2 file is the
  richer S-Concrete **2026** format (SI; `Codes 14`, `Bar Type 8`). The writer
  injects the app's inputs into real sample templates (`templates/ec2Beam.sco`
  and `templates/ec2Column.sco`, imported via Vite `?raw`, CRLF preserved).
  - **Beams** (`Member Type 2`): section/materials/cover/stirrups/longitudinal
    bars/crack-width limit/forces. Forces map Nf=−Pu, Tf=Tu, Vfz=Vu, Mfy=moment
    (sagging + hogging rows); crack width (EN 1992-1-1 §7.3.4) is handled in-file
    with the SLS quasi-permanent combo the user selected as a `SustFactor`-
    weighted load row. Commit `99382c8`.
  - **Columns** (`Member Type 3`, rectangular): `Cm bcol/hcol/Cover`, the
    `Nzcol/Nycol` cage, `DVert/DHorz` bar indices, `NClegsZ/Y` + `Stie`, and
    biaxial forces (Nf=−Pu, Mfy=Mux, Mfz=Muy, Vfz=Vu). `Slender` is forced 0
    because the app supplies already-amplified design forces (short-column
    check). Circular columns are deferred (no EC2 circular sample).
- Status: writers and orchestration are unit-tested (forces verified by parsing
  the emitted files). The `.SCO`/`.SCRS` round-trip and the EC2 field mapping
  (derived from a single sample) **need Windows S-Concrete confirmation**.

## Per-group .SCO envelope + re-run loop

Two extraction modes now back the Map → Groups **S-Concrete batch** action,
matching the "filter → group → design → extract groups as individual files → run
the batch → read the summary" workflow:

- **One .SCO per group (envelope)** — `buildGroupEnvelopeScoFiles` in
  `src/utils/sco/scoBatch.ts`. Each design group becomes a SINGLE `.SCO` carrying
  the group's representative section/rebar and EVERY member's load cases pooled
  into the Sectional Loads table (each row tagged with its source member in the
  Comment column, so the governing case is traceable). S-Concrete checks the one
  group section against the group's full force envelope and the batch summary
  reports the governing case per group — the "8 groups → 8 files" workflow. The
  representative is the group's **modal section**; a geometrically mixed group is
  flagged in the UI, off-type members are dropped and reported, and the group's
  `rebar` template (when set) overrides the member rebar. Falls back to one file
  per member when no groups are defined. This replaces the old one-file-per-member
  default for grouped runs.
- **Re-run an existing folder** — `rerun` handler in `electron/sconcreteBridge.cjs`
  + `rerunScoBatch` client + the **↻ Re-run existing folder** button. Re-runs
  BatchReporter on the `.SCO` files already in the output folder WITHOUT
  regenerating them, so manual tweaks the user made (in S-Concrete or a text
  editor) are preserved, then reads the fresh `.SCRS` back. Closes the
  tweak → re-run → read loop.
- Status: pure logic unit-tested (`scoGroupEnvelope.test.ts`,
  `sconcreteClient.test.ts` — forces verified by parsing the emitted files); the
  live round-trip needs Windows S-Concrete as before.

## 3D model view

The Map tab has a **2D / 3D** toggle. The 3D view (`Map3DCanvas.tsx`) projects the
ETABS node coordinates — every frame's `pt1`/`pt2` carry a real elevation `z` — with
a plain orthographic camera: **drag to orbit, wheel to zoom**, plus Iso / Top /
Front / Side presets. Members render as lines colored exactly like the plan canvas
(DCR / group / section / metric / auto-group), and translucent quads mark each
story's floor elevation so columns read as the vertical members between them. The
coloring is shared with the 2D canvas via `frameColor.ts` (extracted from MapCanvas
and unit-tested), so the two views cannot drift. No WebGL / new dependencies — just
SVG, reusing the existing canvas stack.

- Status: shared color logic unit-tested (`frameColor.test.ts`); rendering is the
  existing SVG path. Works for beams and columns (any imported 3D frame).

## Shear-wall removal

The app no longer designs shear walls; the feature was removed end to end.

- Deleted: `types/wall.ts`, `utils/wallDesign.ts`, `utils/calcBreakdownWall.ts`,
  `components/Detailing/WallSectionView.tsx`, and the wall tests.
- Types: dropped SectionType `shear_wall`, MemberType `wall`, DesignCode
  `ACI318-25`, `WallRebarLayout`, the wall `SectionDimensions` fields (lw/hw/tw),
  `Member.wallRebar`, and every wall result field.
- Consumers cleaned to beam/column only (MemberEditor, MemberResults, Dashboard,
  CalcBreakdownModal, pdfExport, takeoff, sampleData, App, theme). The `.SCO`
  `Wa …` template fields and EC2 "thin-wall" torsion terminology are unrelated to
  shear-wall design and were left intact.
- Status: tsc + production build clean; full suite green (wall-only tests removed).
- Commit: `6e99891`.

---

## Claude Code commands

The uploaded `ClaudeCommands/` set was relocated to `.claude/commands/` and adapted
to this repo (thoughts/ → docs/, custom sub-agents → Explore, Linear → GitHub
Issues, make → npm). Commits `bb4c87b`, `bed1085`, `73673cb`.
