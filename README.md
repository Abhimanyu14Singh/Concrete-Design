# S-Concrete

A structural reinforced concrete design web application built with **React + TypeScript + Vite** — beams and columns.

Supports **ACI 318-19**, **ACI 318-14**, and **EN 1992-1-1 (Eurocode 2)** with step-by-step calculation sheets, DCR dashboards, section detailing views, and a plugin-ready engine architecture.

> **Important:** All calculations must be independently verified by a licensed engineer before use in any real project.

---

## Overview

S-Concrete provides a complete concrete design workflow — from geometry and material input through code checks, detailing, and visual output. A slim **Import → Design → Verify** workflow ribbon sits under the header on every screen and carries the design code selector; switch between ACI and Eurocode 2 at any time and results update instantly.

---

## Features

### Design Codes Supported

| Code | Flexure | Shear | Torsion | Detailing | Crack Width |
|------|---------|-------|---------|-----------|-------------|
| ACI 318-19 | §22.2 | §22.5 | §22.7 | §9.6–9.7 | — |
| ACI 318-14 | §22.2 | §22.5 | §22.7 | §9.6–9.7 | — |
| EN 1992-1-1 (EC2) | §6.1 M_Rd | §6.2 V_Rd,c/s/max | §6.3 T_Rd | §9.2 | §7.3.4 |

**ACI 318-19 beam design**
- Rectangular stress block, T-beam and L-beam flanges
- Tension and compression reinforcement; φ factor per strain regime
- Size-effect shear (Table 22.5.5.1), stirrup contribution, minimum stirrup check
- Cracking torsion, neglect threshold, space-truss torsion capacity
- Detailing checks per §9.6–9.7

**EN 1992-1-1 (Eurocode 2) beam design**
- Positive and negative flexure — M_Rd⁺ and M_Rd⁻ (§6.1)
- V_Rd,c (concrete contribution), V_Rd,s (stirrups), V_Rd,max (crushing limit) (§6.2)
- Torsion capacity T_Rd and combined V+T interaction per §6.3.2(5)
- Detailing checks per §9.2
- Crack width w_k (§7.3.4) for bottom, top, and side faces; accepts per-face limits, M_qp/Mu ratio, and kt factor. The quasi-permanent moment M_qp can be resolved automatically from a **project-wide SLS combination** (see below) instead of the ratio fallback
- UK National Annex value α_cc = 0.85 is applied for the concrete design strength (base EN 1992-1-1 uses 1.0)

**ACI 318-19 / EC2 column design**
- Rectangular and circular columns with full P-M interaction diagrams (strain compatibility)
- Biaxial bending (Bresler / EC2 §5.8.9 exponent method), tied and spiral configurations
- Column shear including axial-load enhancement; tie spacing detailing checks

### Column design — merged from Column_Design_DW
The column workflow gained a full design-and-detailing pipeline ported from the standalone **Column_Design_DW** Python tool and merged into this app. Everything below is implemented today.

- **Rotating neutral-axis biaxial solver** (`src/engines/aci/aciColumnBiaxial.ts`) — the primary P-M method for rectangular biaxial columns. Given a factored axial load Pu and a resultant-moment direction θ = atan2(|M2|, |M3|), nested bisection (outer on neutral-axis depth c, inner on the NA angle) returns the design resultant-moment capacity φMr on the interaction surface, capturing the M3↔M2 coupling Bresler cannot. Ported 1:1 from the Python tool's `_biaxial_phi_mrtht` and validated against golden vectors; the **Bresler reciprocal** load method (`aciBiaxialCheck`) remains the fallback. Wired into `designColumnACI`.
- **Column auto-design** (`src/utils/suggestColumnRebar.ts`) — the **✨ Suggest** button now sizes columns too: it picks the lightest symmetric cage (longitudinal bars + ties) meeting the group's worst demand at the target DCR while holding ρg inside the 1–8% band (ACI §10.6.1). The search is decoupled — lightest longitudinal cage passing P-M / axial, then lightest ties passing shear — and every candidate is re-verified through the engine.
- **Auto-size section recommendation** (`src/utils/autoSizeColumn.ts`) — when no cage fits the current section, recommends a minimum gross section from the ACI §22.4.2 short-column axial capacity (φPn = φ·α·[0.85·f'c·(Ag − Ast) + fy·Ast]), rounded up to even inches. An axial-demand starting size that the caller enlarges when the design is P-M-governed.
- **Lap / development splice length** (`src/utils/spliceLength.ts`) — ACI §25.5 compression laps (§25.5.5.1) and tension laps (§25.5.2.1, with ld per the §25.4.2.3 simplified expression, Class A / B), shown in the column calc sheet.
- **Multi-story column stacks** (`src/utils/columnStack.ts`) — the Map view's **Analyze ▾ → Column stacks** view groups columns by plan location into vertical stacks and reports, per story, Pu / ρ / φPn / DCR, plus capacity-vs-elevation data (axial demand against φPn,max at reference steel ratios). Stacks are derived on the fly from the members, so older project files are unaffected.
- **Quantity takeoffs** (`src/utils/takeoff.ts`) — the Map view's **Analyze ▾ → Takeoff** view reports gross concrete volume (yd³), rebar tonnage, and per-GFA intensities (lb steel per yd³, psf), rolled up for beams and columns. Reuses the savings report's steel-weight model so takeoff and savings never disagree.
- **Formula-traceable Excel export** (`src/utils/export/excelExport.ts`) — the per-member worksheets write **live spreadsheet formulas** for the axial / geometry chain (Ag, ρg, φPn,max, the per-load-case axial DCR), so those cells recompute when an input is edited. P-M, flexure, shear, and torsion capacities come from the engine and are written as labelled values.
- **ETABS group push-back** (`src/adapters/etabs/pushGroups.ts`, `tools/EtabsHelper`) — push the app's design groups back into ETABS as named groups with their member frames assigned. The pure mapping/summary helpers build the `{name, frameNames}[]` payload from `project.modelMap`; the live transport runs through the .NET sidecar.
- **S-Concrete .SCO / .SCRS batch** (`src/utils/sco/`) — generate S-Concrete `.SCO` files for the design groups (beams as **Member Type 1**, rectangular columns through the byte-validated **Type 3** writer, ported 1:1 from `Column_Design_DW/sco_writer.py`), drive **BatchReporter** via a bundled native sidecar (`SConcreteHelper.exe` — Windows UI Automation, **no Python**) from the Electron main process, and pull per-member pass/fail and utilisations from the `.SCRS` report. ACI is wired; **EC2** uses a separate S-Concrete-2026-format writer (`src/utils/sco/scoWriterEC2.ts`) for both **beams** (Member Type 2) and rectangular **columns** (Member Type 3), injecting the app's inputs (section, materials, cover, stirrups, longitudinal cage, forces) into real sample templates. For beams, crack width (EN 1992-1-1 §7.3.4) is handled in-file via the SLS quasi-permanent load row; columns carry biaxial loads (Nf / Mfy / Mfz) and force the short-column check (Slender 0, since the app supplies amplified forces).
  - **Per-group envelope** — a batch run emits **one `.SCO` per (design group × member type)**: the group's representative section/rebar carrying every member's load cases pooled into the Sectional Loads table, so S-Concrete checks each group section against its full force envelope. For **EC2 beams two files** are written per group — a ULS `<Group>.SCO` and a crack-width `<Group>_crack.SCO` (SLS quasi-permanent) — while ACI beams and all columns emit a single file. See `src/utils/sco/scoBatch.ts` (`buildGroupEnvelopeScoFiles`).
  - **Verify loop** — results are persisted on the project and surfaced both as a map colour mode and on each member's results view (see **S-Concrete Verification** under Features).
  - **Validation boundary** — the `.SCO` / `.SCRS` round-trip and the EC2 field mapping are by inspection of reference files and must be confirmed against a real S-Concrete run on Windows. The rotating-NA biaxial engine is golden-vector validated independently of this.

### Workflow Ribbon
A slim, always-visible **Import → Design → Verify** ribbon sits directly under the header on every screen, so the three-stage workflow (and the S-Concrete verification step in particular) is reachable from any tab. Each stage is a clickable, progress-aware chip that turns green with a ✓ once its step is done:

- **① Import** — opens the ETABS import wizard; done once a model has been imported (`project.modelMap` exists).
- **② Design** — jumps to the Map tab to group members and detail rebar; done once design groups exist.
- **③ Verify** — jumps to the Map tab's S-Concrete panel; done once a batch has produced persisted results (`project.sconcreteResults`).

The **design code selector lives in this ribbon** (it moved out of the header), because the chosen code drives the generated `.SCO` handed to S-Concrete. Selecting **EN 1992-1-1** also switches the display to SI units.

### Design Code Selector
Switch between ACI 318-19, ACI 318-14, and EN 1992-1-1 (Eurocode 2, UK National Annex with α_cc = 0.85) from the workflow ribbon without losing project data.

### Member Results — Progressive Disclosure
The per-member results view groups its 15–20 DCR rows into collapsible **per-check sections** so it reads as a short summary rather than a wall of numbers. The governing (highest-DCR) check is expanded by default; the rest collapse to a header plus a colour-coded DCR chip that you can click to expand:

- **Beams** — Flexure / Shear / Torsion / Crack Width §7.3.4 (the crack section appears only under EC2).
- **Columns** — Axial / P-M Interaction / Shear / Steel Limits.

The **S-Concrete verification** card (above) and the collapsible **All Load Cases** comparison table are unchanged by this grouping.

### Step-by-Step Calculation Sheet
"∑ Calc Sheet" opens a modal with every check displayed as:
`equation → substitution → result`

Covers all EC2 checks including V+T interaction, negative flexure, and top/side face crack widths.

### SI / Imperial Unit Toggle
Display units can be toggled between SI and imperial at any time. Project data is stored internally in imperial units; conversions are applied on display.

Switching the global unit system to **SI** now updates **all** displayed quantities — moments, forces, areas, and steel weights (lb → kg, lb/ft → kg/m, in² → mm², in → mm) — consistently across **MemberResults**, the **Dashboard**, the **Model Map** (including hotspot overlays and the inspect card), the **Savings** panel, and the step-by-step calculation breakdowns.

### Metric Rebar Support
Bar sizes use a signed encoding: positive values are US customary bars (e.g. `5` = #5), negative values are metric bars (e.g. `-16` = Ø16 mm).

### Crack Control Inputs (EC2)
Per-face crack width limits, quasi-permanent moment ratio M_qp/Mu, and kt factor are configurable inputs for EC2 crack width calculations.

**Project-wide SLS quasi-permanent combination** — rather than entering M_qp per beam, the SLS quasi-permanent combination is chosen **once** in the ETABS import wizard (Step 2) and stored project-wide (`project.slsCombo`). When EC2 is the active code, each beam's §7.3.4 crack-width check auto-resolves its M_qp⁺ / M_qp⁻ from that combo's per-station signed-moment envelope (kip-ft) — no per-beam setup. If no project SLS combo is set, the check falls back to the legacy per-member SLS load case, then to the M_qp/Mu ratio. A **per-member override** picker remains for one-off cases. Side / skin reinforcement (which drives the side-face crack check) is set in the Member editor under **"Side Bars"**.

### Skin / Face Reinforcement
Minimum skin (side / face) reinforcement is handled automatically:

- **On import**, beams that require it are given the code-minimum skin reinforcement per **EC2 §7.3.3** (when EC2 is active) or **ACI §9.7.2.3** (deep-beam side-face bars) so imported members start compliant.
- A **Dashboard button** applies the minimum skin reinforcement to any beams still flagged for it, in one click. Skin bars drive the EC2 side-face crack-width check and are also editable per member under **"Side Bars"**.

### DCR Dashboard
Bar charts showing Demand/Capacity Ratios for all members and load cases. Status indicators: OK / Warning / NG.

**Split workspace** — the Dashboard is laid out as two panes: the left pane lists members grouped by design group; selecting a member loads its inline editor and results in the right pane. A **Skin reinforcement** action applies the code-minimum skin/face reinforcement to flagged beams (see below).

### Model Map
A top-level **Map** tab (Dashboard | Map | Member) shows a persistent snapshot of the imported ETABS model. Both **beams and columns** render (columns draw as square plan markers) and both are groupable and designable. The map is a **rotatable 2D / 3D** view — a **2D/3D toggle** switches between the plan snapshot and an orbitable 3D model (drag to orbit, wheel to zoom).

- **Clustered toolbar** — the old flat row of ~30 buttons is grouped into four clusters:
  - **View** — the 2D/3D toggle and a story dropdown (`All` + each story).
  - **Colour by ▾** — one dropdown replaces the eight individual colour-mode buttons. Options: **DCR**, **Design group**, **Section**, **Steel % (ρ)** (with a Top/Bot face toggle), **Stirrups** (Av/s), **Steel weight** (per-length steel intensity), **Auto-group overlay**, and **S-Concrete pass/fail** (colours members by the last persisted S-Concrete batch result). Frames not imported as design members render dashed.
  - **Overlay** — a Diagram toggle (**Diag / M / V** force-envelope overlay), an **Inspect** (🔍) toggle, and an **Errors** (⚠) toggle.
  - **Model** — the model name / frame count and a **↻ Re-sync** (re-import) button.
- **Navigation** — wheel zoom, drag to pan, and a fit-to-view button.
- **Selection** — click a beam, shift-click to add to the selection, or drag a lasso to multi-select. Click and lasso are properly independent — a lasso drag on the canvas background no longer clears a frame click.
- **Rich hover tooltip** — hovering a beam shows Flex DCR and Shear DCR (color-coded) plus Top/Bottom bars and stirrup string. Import or design errors surface in the tooltip instead of silently skipping.
- **V/M diagram overlays** — the Overlay cluster's Diagram toggle cycles through Diag (off) / M / V. Each beam draws a filled polygon perpendicular to its axis scaled to the per-station envelope (max |M| or |V| across all combos). A legend chip appears in the bottom-right corner when overlays are active.
- **Design groups** — create, rename, or dissolve groups from the current map selection. Each group gets a color chip and a worst-DCR badge.
- **Group deletion — two modes** — **Dissolve** removes the group but keeps its member beams (they fall back to Ungrouped); **Delete + beams** deletes the group *and* permanently removes its member beams from the project. Both require confirmation; the destructive "delete the N beams too" path warns that it cannot be undone.
- **Per-member group editing** — beyond the group-edit map clicks, each member in a group row has **+ Add** / **− Remove** chips for fine-grained single-member management without touching the map selection.
- **Suggest all groups** — the group panel's **✨ Suggest all groups** button runs the rebar suggester (below) across every group with designed beams in one pass, applying each result and reporting an `ok/total` summary (e.g. "Suggested 5/7 groups · 2 need larger sections"). Groups with no designed beams are skipped.
- **Group-edit mode** — click **Edit** on a group to enter group-edit mode (blue banner above canvas). Clicking any beam in the map toggles it into or out of the active group without changing the map selection. Per-frame **+ Add** / **− Remove** chip buttons appear in the group panel for fine-grained single-member management.
- **Group rebar** — edit a rebar template for a group (bars + stirrup zones) using fully typeable numeric inputs and click **Apply** to fan the layout out to every member in the group.
- **Hotspot overlays** — three reinforcement-intensity choices under **Colour by ▾** alongside DCR / Design group / Section: **Steel % (ρ)** (ρ = As/(b·d), with a Top/Bot face toggle), **Stirrups** (provided Av/s in in²/ft, governing zone), and **Steel weight** (total steel weight intensity, lb/ft). All three render on a continuous blue→green→yellow→red ramp with a gradient legend (min/max auto-scaled to the visible story); the hover tooltip shows the metric value, and in steel-weight mode the longitudinal/stirrup split, e.g. `23.4 lb/ft (L 16.1 + S 7.3)`.
- **Beam inspect card** — the Overlay cluster's 🔍 **Inspect** toggle; with it on, clicking a designed beam opens a single combined floating card (it replaces the old separate hover tooltip and click card). It shows an enlarged SVG section sketch with top, bottom, and side (skin) bar dots inside the stirrup outline; rebar callouts (top / bottom / side / stirrup strings) and the total steel `lb/ft` with its longitudinal + stirrup split; M and V envelope sparklines along the span; a **Flex+ / Flex− / Shear** DCR table evaluated at the three 1/3-span zones (**End L / Mid / End R**, each re-run through the design engine on its own station-force envelope); and a whole-member **Envelope** DCR summary row.
- **Right-click context menu** — right-clicking a designed beam offers **Navigate to Design**, **Move to group** (submenu of existing groups), **Hide beam**, and **Delete beam**. Hidden beams persist as `project.hiddenMemberIds`.
- **Story visibility chips** — a floor chip row above the plan; click a chip to hide/show that floor (persisted as `project.hiddenStories`), with a **Show all** reset.
- **Group exclusivity** — adding a member to a group removes it from all other groups, whether via the group panel, a map click in group-edit mode, or the context-menu move.
- **Group statistics** — each group row has an expandable ▸ stats row showing mean ± std for Flex+ / Flex− / Shear DCR plus mean ρ top/bot across the group's members.
- **Resizable sidebar** — drag the right edge of the member sidebar (clamped 160–480 px); full member names display with CSS ellipsis instead of 12-character truncation.
- **Right panel — ① Design → ② Verify** — the main **Design + Verify** tab is split into two labelled sections that mirror the workflow:
  - **① Design** — the group panel (create / rename / dissolve groups, worst-DCR badges), the **group rebar editor** promoted directly under the active group, and — when the active group contains columns — the **column force grid** (see below).
  - **② Verify (S-Concrete)** — the external-tools panel that writes the group `.SCO` files, runs the S-Concrete batch, and pulls the governing result per group (see **S-Concrete Verification** below).
  - The four analytics views moved behind a single **Analyze ▾** picker: **Auto-group**, **Savings**, **Takeoff**, and **Column stacks** (each described below).
- **Column force grid** — when a design group contains columns, the ① Design section shows a compact grid to enter **Pu / Mux / Muy / Vu** for every column member at once (internal units kip, kip-ft), instead of opening each column's load-case modal. Columns imported from ETABS start with zero placeholder forces, and the grid warns while any remain zero.

### Auto-Group (demand clustering)
The **Map → Analyze ▾ → Auto-group** view suggests design groups automatically from analysis demands:

0. A **Pool** toggle chooses the demand pool: **By family** (default) or **All beams**. **By family** partitions beams into section families (next step). **All beams** clusters *every* beam across the model as a single demand pool, ignoring section family — useful when you want a fixed number of detailing groups regardless of section size. It works with the **Total groups (model)** budget and respects per-family k. Switching the toggle resets the family selection.
1. Beams are partitioned into **section families** — same b×h and materials (`familyKey`) — so a 14×24 never groups with an 18×30 (skipped in **All beams** pool mode).
2. A **Cluster by** selector chooses which demand metric drives the histogram, bins, and per-group value: **Governing** (the blended, family-normalized demand below), **M⁺** (positive moment), **M⁻** (negative moment), or **Shear**. The moment/shear metrics cluster on raw values (shown as kip-ft / kips); **Governing** clusters on a normalized 0–1 score (shown as %). Switching the metric recomputes the suggestion live.
3. For the **Governing** metric, every beam gets a **family-normalized governing demand**: max of Mu⁺, Mu⁻, and Vu, each divided by the family-wide maximum of that quantity (so heavy-shear beams don't disappear into a light-moment bin). Demands come from the imported envelope load case, with a station-forces fallback.
4. The 1-D demand values are clustered with **Jenks natural breaks** (variance-minimizing dynamic program, O(k·n²)) or **quantile breaks** — selectable in the panel. With k = **Auto**, k = 2…5 is tried and scored by **goodness-of-variance fit** (GVF = 1 − SDAM/SDCM); the search stops early once GVF ≥ 0.85.
5. Each family gets a **histogram** of the selected metric with **draggable break sliders** for manual tuning; hovering a bin highlights its frames on the map.
6. The view is **reference-only**: suggestions render as a map overlay (toggled via the **Auto-group overlay** option under **Colour by ▾**, session-local) and update live with every slider/algorithm/metric change. Design groups only change when you click **Commit as Design Groups**, which creates groups tagged `source: 'auto'`. Re-committing replaces previous auto-groups but never touches manually created groups.

### Savings Analytics
The **Map → Analyze ▾ → Savings** view quantifies potential rebar savings against a project-wide **target DCR** slider (persisted as `targetDCR` in the project file):

- **Slack per member** — longitudinal: `(As_prov − max(As_req / targetDCR, As_min))⁺` per face, converted to weight via `As (in²) × length (ft) × 3.4 lb/(ft·in²)` (490 lb/ft³ ÷ 144). Stirrup slack compares provided Av/s (governing end zone) against `Av_req / targetDCR`, never below Av,min.
- **Per-group and per-member tables** of potential savings in lb and tons, sorted by slack, with CSV export. Percent savings appear next to the tons figure and as a % column per group.
- **Consolidation advisor** — suggests merging adjacent same-family groups when adopting the heavier group's steel costs less than the detailing simplification is worth, with the steel-cost delta shown.
- **Steel in place** card — total steel currently detailed, split longitudinal vs stirrups with lb/ft averages. Stirrup weight uses the actual hoop perimeter, `2[(bw−2cc) + (h−2cc)]` plus `(legs−2)` interior legs of `(h−2cc)`, averaged over the three stirrup zones.

### One-Click Rebar Suggestion
The **✨ Suggest** button in the group rebar editor picks the lightest *practical* layout meeting the group's worst demand at the project target DCR:

- Longitudinal: #5–#9 bars, ≥ 2 bars/layer, max 2 layers (outer ≥ inner), with a width-fit check (clear spacing ≥ max(1″, db) inside cover + stirrup). The top and bottom faces always share **one common bar size** (the smallest size where both faces have a feasible layout); only the bar counts and layer arrangement may differ between faces. During per-member verification a face is bumped within the common size first, stepping up to the next common size — and recomputing both faces — only when a size is exhausted.
- Stirrups: #4 or #5, 2 then 4 legs, spacings {4, 6, 8, 10, 12} in, zoned end/mid/end with the mid zone one increment more relaxed.
- Candidate areas come from the engine's worst As_req/Av_req across all members and load cases; the winning layout is **re-verified per-member with `runDesign`** (up to 5 retries bumping to the next candidate) so strain-compatibility effects can't sneak a failing layout through.
- The result prefills the editor form for review — nothing is applied until you click **Apply**.

The map geometry (`project.modelMap`) is captured during ETABS import — all beam frames, not just the ones filtered into design members — and is saved with the project file. Group membership resolves live from `project.members` so newly imported members appear in their groups immediately without a re-sync.

### S-Concrete Verification
The **② Verify (S-Concrete)** panel in the Map view closes the design → verify loop: it writes the per-group `.SCO` files, runs S-Concrete's **BatchReporter**, and pulls the resulting `SConcreteResults.SCRS` back into the app. Results are **persisted** on the project (`project.sconcreteResults`, keyed by the member ids each file covers, plus `project.sconcreteRanAt`), so they survive tab switches, colour the Model Map (the **S-Concrete pass/fail** colour mode), and appear on each member's results view.

- **Verification card on the member** — each member's results view shows an **"S-Concrete verification"** card: the persisted `.SCRS` result for that member (status, N-M utilisation, V&T utilisation, and crack for EC2 beam groups) next to the app's own governing DCR, with an **agree / differ** cue and the last-run time. Members that S-Concrete can check are beams and rectangular columns.

- **No Python — a bundled native helper drives BatchReporter** — the batch is run by `SConcreteHelper.exe`, a small .NET sidecar shipped with the app (`tools/SConcreteHelper/`) that drives S-Concrete's **BatchReporter** GUI by Windows UI Automation. There is **no** Python, `pywinauto`, or `run_batch_reporter.py` to install or configure (the old Python path was replaced). The app **auto-detects** S-Concrete under `C:\Program Files (x86)\S-FRAME Software\…\S-CONCRETE\BatchReporter.exe`, and the only setting left is the **output folder**, which auto-defaults to `Documents\S-Concrete Batches` (overridable). No per-run Save dialog.
  - **Run** writes the `.SCO` files into the folder, then the helper drives BatchReporter (set folder → Run Batch → wait for results → optional PDF), which writes the `.SCRS` back into the same folder.
  - **Re-run existing folder** reports on the `.SCO` files already in the folder *without* rewriting them, so hand edits (made in S-Concrete or a text editor) survive.
  - **Open folder** reveals the output folder in the OS file manager.

- **Desktop-only** — all S-Concrete steps require the **Windows desktop app with S-Concrete (S-FRAME Product Suite) installed** (the helper launches BatchReporter locally); in the browser the panel shows a notice that grouping and design work but the batch does not.

- **Validation boundary** — as noted above, the `.SCO` / `.SCRS` round-trip must be confirmed against a real S-Concrete run on Windows.

### Collapsible Grouped Sidebar
The members list is organised into collapsible sections — one per design group plus an **Ungrouped** section. Each section header shows a color dot, member count, and a collapse chevron; double-click a header to rename the group inline. Collapse state is persisted in `localStorage`. When sidebar items are collapsed, a per-type color dot still indicates membership at a glance.

Each design-group header also shows **status count chips** computed from every member's governing check (respecting engineer overrides): a red **`N NG`** chip for inadequate members and an amber **`N⚠`** chip for near-capacity members, so hot groups stand out without expanding them. A single **`+`** next to the **Members** header adds a new member.

### Multiple Load Cases
Each member supports multiple load cases; all are checked independently.

### Save / Open Project Files
Projects are saved and opened as JSON files for portability and version control.

### Section Detailing Views
SVG cross-section and elevation views showing rebar layout and spacing. Beam elevations support zoned stirrups — three distinct spacings over thirds of the span.

### ETABS Import
"⇪ ETABS" in the header (or the **Import** ribbon chip) opens the **Import from ETABS** wizard — a 4-step flow (**Connect → Filter → Rebar Defaults → Review & Import**) that imports **beams, columns, or both**. It has two model sources:

- **ETABS Active Instance** — one click attaches to the model currently open in ETABS. The desktop app ships a bundled .NET sidecar (`EtabsHelper.exe`, built from `tools/EtabsHelper/`) that connects through the ETABS .NET API (`ETABSv1.dll`, loaded by reflection — no COM registration, no scripts, no extra installs). Requirements: the **Windows desktop app**, ETABS v20+ installed, a model open, and the **analysis already run**. The sidecar calls `SetPresentUnits(kip_ft_F)` at connect time so `GetTableForDisplayArray` always returns kip-ft regardless of the model's GUI display settings; a `getUnits` handler exposes the active `eUnits` integer for verification. The renderer's `eUnitsToFactors()` maps all 16 ETABS unit systems and falls back to the Program Control string if the enum call is unavailable. Geometry, sections (exact b×h from the concrete-rectangular definitions), materials, ETABS groups, and per-station P/V2/M3/T forces are all pulled from ETABS database tables.
- **Sample model (demo)** — built-in 2-story model to try the workflow without ETABS.

2. **Filter** — leads with a **scope selector**: **Beams**, **Columns**, or **Beams + Columns** (the Columns / Beams + Columns options are disabled when the active connection can't enumerate columns, i.e. it exposes no `getColumns`). Then choose story, frame properties, ETABS groups, and which load combinations to import; the materials table is folded into an **"Advanced — materials imported with sections"** disclosure. This step also picks the **SLS quasi-permanent combo** used for EC2 §7.3.4 crack-width checks; the choice is stored project-wide so every beam's M_qp resolves from that combo's station-force envelope. The selected SLS combo's forces are always fetched even if it was not selected for design import.
3. **Rebar Defaults** — typical top/bottom steel percentages and three stirrup-zone spacings; bar sizes/counts are auto-selected per section. A **wizard-local Design code** dropdown (ACI 318-19 / EN 1992-1-1) and **Units** toggle (Imperial / SI) tailor this step — they change the rebar size lists (US customary vs metric bars) and the stirrup-spacing units (in vs mm) shown here **without** altering the global project design code or unit settings.
4. **Review & Import** — a plan map of the members drawn from their node coordinates, color-coded by DCR (green < 0.7 → red ≥ 1.0). Beams auto-group by story · section by default; the wizard's **"Design groups from ETABS"** picker lets you opt specific ETABS group names in — members in a selected group mirror that name as their design group, the rest fall back to story · section. Shift-click to merge custom groups and batch-adjust bars. Double-click a beam to import and open it with shear/moment diagrams (envelope of imported combos with φVn / φMn capacity overlays) and editable rebar. The step ends with a **next-steps summary** ("group members → design rebar → run S-Concrete to verify") and, when columns were imported, a **zero-force nudge** reminding you to enter each column's Pu / Mux / Muy in Map → ① Design before running S-Concrete.

Imported members keep their ETABS link (frame name, story, groups, node coordinates) and station forces, and the beam shear check is evaluated per stirrup zone against the max |V| within each third of the span. **Columns** import with their geometry, section (`rectangular_column`), materials, and a starter symmetric cage — they render on the map, are groupable and designable, and start with **zero placeholder design forces** entered post-import via the column force grid (columns-only imports work end to end).

**Source-level filtering** keeps large-model imports fast: before fetching the force table, the selected combos are pushed into ETABS via `SetLoadCombinationsSelectedForDisplay` / `SetLoadCasesSelectedForDisplay` (sidecar `selectCombos` request), so ETABS only serializes the rows you asked for. When exactly **one** ETABS group is selected in the wizard, its name is passed as the `GroupName` argument of `GetTableForDisplayArray`, filtering at the source too. The bridge's `getTable` timeout is 600 s (other calls 120 s) to tolerate very large force tables.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| UI framework | React 19 |
| Language | TypeScript |
| Build tool | Vite |
| Styling | Tailwind CSS |
| Charts | Recharts |
| Desktop (optional) | Electron |

---

## Getting Started

### Prerequisites

[Node.js 22 LTS](https://nodejs.org/en/download) — free, one-time install (~70 MB).
(Electron requires Node ≥ 22.12 and Vite ≥ 20.19; 22 LTS is what CI builds with.)

> **Working on the app day to day?** See
> **[docs/local-development.md](docs/local-development.md)** — the local Windows
> loop: edit with Claude Code in your terminal, see it live in the browser, and
> build the installer yourself instead of waiting on GitHub Actions.

### Option A — Browser (development server)

```bash
git clone https://github.com/Abhimanyu14Singh/Concrete-Design.git
cd Concrete-Design
npm install
npm run dev
# Open http://localhost:5173
```

### Option B — Desktop app (Electron)

```bash
npm install
npm run electron:build
```

Produces an installer in `release/`:
- **Windows** — `release/S-Dashboard Setup x.x.x.exe`
- **macOS** — `release/S-Dashboard-x.x.x.dmg`
- **Linux** — `release/S-Dashboard-x.x.x.AppImage`

On Windows, prefer `.\scripts\build-installer.ps1` — it mirrors the CI build
(including the .NET sidecars that ETABS and S-Concrete need) and fails early if
they would be missing. See [docs/local-development.md](docs/local-development.md).

Once installed, the app runs with no Node.js or browser required.

### Option C — Static web build

```bash
npm install
npm run build
# Serve the dist/ folder from any static host (Netlify, GitHub Pages, nginx, etc.)
```

### Development commands

```bash
npm run dev            # Hot-reload dev server (browser)
npm run dev:desktop    # Electron + hot reload, one command
npm run gate           # Typecheck + all tests + production build
npm test               # Run unit tests (Vitest)
npm run test:watch     # Watch mode
npm run electron:dev   # Electron against an already-running dev server
```

---

## Architecture

```
src/
  engines/
    aci/                    # ACI 318-19 / 318-14 beam design engine
    ec2/
      ec2Beam.ts            # Eurocode 2 beam design engine
    dispatcher.ts           # Routes calculations to the correct engine
  adapters/
    etabs/                  # ETABS import: CSI OAPI client, .xlsx parser, demo model,
                            #   rebar seeding, beam + column member/group mapping
                            #   (getColumns / buildColumnMembers)
  utils/
    calcBreakdown.ts        # ACI step-by-step calculation sheet generator
    calcBreakdownEC2.ts     # EC2 step-by-step calculation sheet generator
    units.ts                # SI / imperial conversion utilities
    rebar.ts                # Bar designation helpers (US customary + metric)
    autoGroup.ts            # Pure functions: familyKey, extractDemands, jenksBreaks,
                            #   quantileBreaks, assignByBreaks, suggestGroups,
                            #   computeSavings, flexSteelRatioPct, stirrupAvPerFt,
                            #   steelWeightPerFt
    suggestRebar.ts         # suggestGroupRebar — lightest practical layout at target DCR
                            #   (common top/bottom bar size), verified per-member with runDesign
    resolveCrack.ts         # resolves EC2 M_qp from the project SLS combo's station-force
                            #   envelope (falls back to per-member SLS case, then M_qp/Mu ratio)
    sconcreteMemberResult.ts # summarises the persisted .SCRS result for one member
                            #   (verification card): status, N-M / V&T util, agree/differ
    sco/                    # S-Concrete .SCO / .SCRS: writers (ACI + EC2), per-group
                            #   envelope batch (scoBatch), .SCRS parser, run client
  contexts/
    UnitsContext.tsx         # React context for active unit system
  types/                    # TypeScript interfaces (beam, column, common)
  components/
    Dashboard/              # Project overview, member table, DCR chart
    ModelMap/               # Map tab (2D/3D): SVG plan canvas (MapCanvas), Map3DCanvas,
                            #   GroupPanel, GroupRebarEditor, ColumnForceGrid (column
                            #   design forces), GroupActionsPanel (② Verify / S-Concrete),
                            #   AutoGroupPanel + HistogramPanel, SavingsPanel, colorRamp.ts
                            #   (continuous hotspot ramp; ModelMapView composes them)
    EtabsImport/            # ETABS import wizard (Connect / Filter / Rebar / Review)
    Results/                # Per-member results: collapsible per-check sections,
                            #   S-Concrete verification card, summary table, calc modal
    Detailing/              # SVG section, elevation, P-M diagram, interaction views
    SectionInput/           # Member editor (geometry, materials, loads)
  App.tsx                   # Layout, state, workflow ribbon + code-selector, sidebar
electron/
  main.cjs                  # Electron main process (native dialogs, folder picker)
  etabsBridge.cjs           # spawns the .NET sidecar, JSON-lines over stdio
  sconcreteBridge.cjs       # writes .SCO files, drives SConcreteHelper.exe, reads .SCRS
tools/
  EtabsHelper/              # C# sidecar: attaches to running ETABS via the
                            #   .NET API (ETABSv1.dll by reflection, no COM)
  SConcreteHelper/          # C# sidecar: drives S-Concrete's BatchReporter by
                            #   Windows UI Automation (no Python / pywinauto)
```

### ETABS Connection Architecture
The renderer's `ComConnection` (and the shared `TableConnection` base in `src/adapters/etabs/tableConnection.ts`) reads everything from ETABS **database tables** (`GetTableForDisplayArray`) — beam connectivity, point coordinates, section definitions, materials, groups, combos, and "Design Forces - Beams" (fallback "Element Forces - Beams"). The sidecar enforces kip-ft units by calling `SetPresentUnits` at connect time; `tableConnection.ts` resolves the active unit system via `fetchUnitsEnum()` (IPC `getUnits`) and maps it through `eUnitsToFactors()`, falling back to the Program Control string for older sidecars. The Electron main process (`electron/etabsBridge.cjs`) spawns the bundled `EtabsHelper.exe` sidecar and proxies `connect` / `getTable` / `getUnits` / `selectCombos` requests over stdio (`getTable` timeout 600 s, others 120 s).

`TableConnection` exposes a `selectCombosAtSource(combos)` hook (no-op for file-based imports) that `ComConnection` overrides to send a best-effort `selectCombos` IPC before fetching forces; the sidecar's `SelectCombos` handler calls `SetLoadCombinationsSelectedForDisplay` and `SetLoadCasesSelectedForDisplay` by reflection. `getTable` accepts an optional `group` parameter forwarded as the `GroupName` argument of `GetTableForDisplayArray` (`""` = all objects); the import wizard passes it when exactly one ETABS group is selected.

The Windows CI build (`.github/workflows/build-windows.yml`) publishes the sidecar with `dotnet publish` (framework-dependent, .NET 6 `RollForward LatestMajor` — the runtime ships with ETABS 21+) and verifies it exists both in `build-helper/` and inside the packaged `resources/etabs-helper/`.

### Plugin-Ready Design
`src/engines/` and `src/adapters/` are structured to accept additional design engines and import adapters (ETABS, SAP2000) without modifying the core UI or existing engines. Beam and column engines are implemented today.

---

## Design Codes Supported

- **ACI 318-19** — Building Code Requirements for Structural Concrete (beams, columns)
- **ACI 318-14** — Previous edition (same clause structure)
- **EN 1992-1-1:2004 (Eurocode 2)** — Design of Concrete Structures, Part 1-1 (beams, columns)
