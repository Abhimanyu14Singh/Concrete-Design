# S-Concrete

A structural reinforced concrete design web application built with **React + TypeScript + Vite** — beams and columns.

Supports **ACI 318-19**, **ACI 318-14**, and **EN 1992-1-1 (Eurocode 2)** with step-by-step calculation sheets, DCR dashboards, section detailing views, and a plugin-ready engine architecture.

> **Important:** All calculations must be independently verified by a licensed engineer before use in any real project.

---

## Overview

S-Concrete provides a complete beam design workflow — from geometry and material input through code checks, detailing, and visual output. Switch between ACI and Eurocode 2 at any time using the design code selector in the header. Results update instantly.

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
- **Multi-story column stacks** (`src/utils/columnStack.ts`) + a **Stacks** tab in the Map view — groups columns by plan location into vertical stacks and reports, per story, Pu / ρ / φPn / DCR, plus capacity-vs-elevation data (axial demand against φPn,max at reference steel ratios). Stacks are derived on the fly from the members, so older project files are unaffected.
- **Quantity takeoffs** (`src/utils/takeoff.ts`) + a **Takeoff** tab — gross concrete volume (yd³), rebar tonnage, and per-GFA intensities (lb steel per yd³, psf), rolled up for beams and columns. Reuses the savings report's steel-weight model so takeoff and savings never disagree.
- **Formula-traceable Excel export** (`src/utils/export/excelExport.ts`) — the per-member worksheets write **live spreadsheet formulas** for the axial / geometry chain (Ag, ρg, φPn,max, the per-load-case axial DCR), so those cells recompute when an input is edited. P-M, flexure, shear, and torsion capacities come from the engine and are written as labelled values.
- **ETABS group push-back** (`src/adapters/etabs/pushGroups.ts`, `tools/EtabsHelper`) — push the app's design groups back into ETABS as named groups with their member frames assigned. The pure mapping/summary helpers build the `{name, frameNames}[]` payload from `project.modelMap`; the live transport runs through the .NET sidecar.
- **S-Concrete .SCO / .SCRS batch** (`src/utils/sco/`) — generate S-Concrete `.SCO` files for the design groups (beams as **Member Type 1**, rectangular columns through the byte-validated **Type 3** writer, ported 1:1 from `Column_Design_DW/sco_writer.py`), run the **BatchReporter** from the Electron main process, and pull per-member pass/fail and utilisations from the `.SCRS` report. ACI is wired; **EC2 beams** use a separate S-Concrete-2026-format writer (`src/utils/sco/scoWriterEC2.ts`) that injects the app's inputs (section, materials, cover, stirrups, longitudinal bars, crack-width limit, forces) into a real sample template, with crack width (EN 1992-1-1 §7.3.4) handled in-file via the SLS quasi-permanent load row.
  - **Validation boundary** — the `.SCO` / `.SCRS` round-trip and the EC2 field mapping are by inspection of reference files and must be confirmed against a real S-Concrete run on Windows. The rotating-NA biaxial engine is golden-vector validated independently of this.

### Design Code Selector
Switch between ACI 318-19, ACI 318-14, and EN 1992-1-1 (Eurocode 2, UK National Annex with α_cc = 0.85) from the header without losing project data.

### Step-by-Step Calculation Sheet
"Show Calculations" opens a modal with every check displayed as:
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
A top-level **Map** tab (Dashboard | Map | Member) shows a persistent plan-view snapshot of the imported ETABS model:
- **Story selector** and three color modes — DCR, Group, or Section. Frames that haven't been imported as design members render dashed.
- **Navigation** — wheel zoom, drag to pan, and a fit-to-view button.
- **Selection** — click a beam, shift-click to add to the selection, or drag a lasso to multi-select. Click and lasso are properly independent — a lasso drag on the canvas background no longer clears a frame click.
- **Rich hover tooltip** — hovering a beam shows Flex DCR and Shear DCR (color-coded) plus Top/Bottom bars and stirrup string. Import or design errors surface in the tooltip instead of silently skipping.
- **V/M diagram overlays** — toolbar toggle cycles through Off / M Diagram / V Diagram. Each beam draws a filled polygon perpendicular to its axis scaled to the per-station envelope (max |M| or |V| across all combos). A legend chip appears in the bottom-right corner when overlays are active.
- **Design groups** — create, rename, or dissolve groups from the current map selection. Each group gets a color chip and a worst-DCR badge.
- **Group deletion — two modes** — **Dissolve** removes the group but keeps its member beams (they fall back to Ungrouped); **Delete + beams** deletes the group *and* permanently removes its member beams from the project. Both require confirmation; the destructive "delete the N beams too" path warns that it cannot be undone.
- **Per-member group editing** — beyond the group-edit map clicks, each member in a group row has **+ Add** / **− Remove** chips for fine-grained single-member management without touching the map selection.
- **Suggest all groups** — the group panel's **✨ Suggest all groups** button runs the rebar suggester (below) across every group with designed beams in one pass, applying each result and reporting an `ok/total` summary (e.g. "Suggested 5/7 groups · 2 need larger sections"). Groups with no designed beams are skipped.
- **Group-edit mode** — click **Edit** on a group to enter group-edit mode (blue banner above canvas). Clicking any beam in the map toggles it into or out of the active group without changing the map selection. Per-frame **+ Add** / **− Remove** chip buttons appear in the group panel for fine-grained single-member management.
- **Group rebar** — edit a rebar template for a group (bars + stirrup zones) using fully typeable numeric inputs and click **Apply** to fan the layout out to every member in the group.
- **Hotspot overlays** — three reinforcement-intensity color modes in the toolbar alongside DCR/Group/Section: **Steel %** (ρ = As/(b·d), with a Top/Bot face toggle), **Stirrups** (provided Av/s in in²/ft, governing zone), and **lb/ft** (total steel weight intensity). All three render on a continuous blue→green→yellow→red ramp with a gradient legend (min/max auto-scaled to the visible story); the hover tooltip shows the metric value, and in lb/ft mode the longitudinal/stirrup split, e.g. `23.4 lb/ft (L 16.1 + S 7.3)`.
- **Beam inspect card** — a 🔍 **Inspect** toolbar toggle; with it on, clicking a designed beam opens a single combined floating card (it replaces the old separate hover tooltip and click card). It shows an enlarged SVG section sketch with top, bottom, and side (skin) bar dots inside the stirrup outline; rebar callouts (top / bottom / side / stirrup strings) and the total steel `lb/ft` with its longitudinal + stirrup split; M and V envelope sparklines along the span; a **Flex+ / Flex− / Shear** DCR table evaluated at the three 1/3-span zones (**End L / Mid / End R**, each re-run through the design engine on its own station-force envelope); and a whole-member **Envelope** DCR summary row.
- **Right-click context menu** — right-clicking a designed beam offers **Navigate to Design**, **Move to group** (submenu of existing groups), **Hide beam**, and **Delete beam**. Hidden beams persist as `project.hiddenMemberIds`.
- **Story visibility chips** — a floor chip row above the plan; click a chip to hide/show that floor (persisted as `project.hiddenStories`), with a **Show all** reset.
- **Group exclusivity** — adding a member to a group removes it from all other groups, whether via the group panel, a map click in group-edit mode, or the context-menu move.
- **Group statistics** — each group row has an expandable ▸ stats row showing mean ± std for Flex+ / Flex− / Shear DCR plus mean ρ top/bot across the group's members.
- **Resizable sidebar** — drag the right edge of the member sidebar (clamped 160–480 px); full member names display with CSS ellipsis instead of 12-character truncation.
- **Tabbed right panel** — Groups | Auto-Group | Savings (the latter two are described below).

### Auto-Group (demand clustering)
The **Map → Auto-Group** tab suggests design groups automatically from analysis demands:

0. A **Pool** toggle chooses the demand pool: **By family** (default) or **All beams**. **By family** partitions beams into section families (next step). **All beams** clusters *every* beam across the model as a single demand pool, ignoring section family — useful when you want a fixed number of detailing groups regardless of section size. It works with the **Total groups (model)** budget and respects per-family k. Switching the toggle resets the family selection.
1. Beams are partitioned into **section families** — same b×h and materials (`familyKey`) — so a 14×24 never groups with an 18×30 (skipped in **All beams** pool mode).
2. A **Cluster by** selector chooses which demand metric drives the histogram, bins, and per-group value: **Governing** (the blended, family-normalized demand below), **M⁺** (positive moment), **M⁻** (negative moment), or **Shear**. The moment/shear metrics cluster on raw values (shown as kip-ft / kips); **Governing** clusters on a normalized 0–1 score (shown as %). Switching the metric recomputes the suggestion live.
3. For the **Governing** metric, every beam gets a **family-normalized governing demand**: max of Mu⁺, Mu⁻, and Vu, each divided by the family-wide maximum of that quantity (so heavy-shear beams don't disappear into a light-moment bin). Demands come from the imported envelope load case, with a station-forces fallback.
4. The 1-D demand values are clustered with **Jenks natural breaks** (variance-minimizing dynamic program, O(k·n²)) or **quantile breaks** — selectable in the panel. With k = **Auto**, k = 2…5 is tried and scored by **goodness-of-variance fit** (GVF = 1 − SDAM/SDCM); the search stops early once GVF ≥ 0.85.
5. Each family gets a **histogram** of the selected metric with **draggable break sliders** for manual tuning; hovering a bin highlights its frames on the map.
6. The tab is **reference-only**: suggestions render as a map overlay (toggled via the **Auto-G** color-mode button, session-local) and update live with every slider/algorithm/metric change. Design groups only change when you click **Commit as Design Groups**, which creates groups tagged `source: 'auto'`. Re-committing replaces previous auto-groups but never touches manually created groups.

### Savings Analytics
The **Map → Savings** tab quantifies potential rebar savings against a project-wide **target DCR** slider (persisted as `targetDCR` in the project file):

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

### Collapsible Grouped Sidebar
The members list is organised into collapsible sections — one per design group plus an **Ungrouped** section. Each section header shows a color dot, member count, and a collapse chevron; double-click a header to rename the group inline. Collapse state is persisted in `localStorage`. When sidebar items are collapsed, a per-type color dot still indicates membership at a glance.

### Multiple Load Cases
Each member supports multiple load cases; all are checked independently.

### Save / Open Project Files
Projects are saved and opened as JSON files for portability and version control.

### Section Detailing Views
SVG cross-section and elevation views showing rebar layout and spacing. Beam elevations support zoned stirrups — three distinct spacings over thirds of the span.

### ETABS Import
"⇪ ETABS" in the header opens a 4-step wizard with two model sources:

- **ETABS Active Instance** — one click attaches to the model currently open in ETABS. The desktop app ships a bundled .NET sidecar (`EtabsHelper.exe`, built from `tools/EtabsHelper/`) that connects through the ETABS .NET API (`ETABSv1.dll`, loaded by reflection — no COM registration, no scripts, no extra installs). Requirements: the **Windows desktop app**, ETABS v20+ installed, a model open, and the **analysis already run**. The sidecar calls `SetPresentUnits(kip_ft_F)` at connect time so `GetTableForDisplayArray` always returns kip-ft regardless of the model's GUI display settings; a `getUnits` handler exposes the active `eUnits` integer for verification. The renderer's `eUnitsToFactors()` maps all 16 ETABS unit systems and falls back to the Program Control string if the enum call is unavailable. Geometry, sections (exact b×h from the concrete-rectangular definitions), materials, ETABS groups, and per-station P/V2/M3/T forces are all pulled from ETABS database tables.
- **Sample model (demo)** — built-in 2-story model to try the workflow without ETABS.
2. **Filter** — choose story, beam frame properties (sections + materials preview), ETABS groups, and which load combinations to import. This step also picks the **SLS quasi-permanent combo** used for EC2 §7.3.4 crack-width checks; the choice is stored project-wide so every beam's M_qp resolves from that combo's station-force envelope. The selected SLS combo's forces are always fetched even if it was not selected for design import.
3. **Rebar defaults** — typical top/bottom steel percentages and three stirrup-zone spacings; bar sizes/counts are auto-selected per section. A **wizard-local Design code** dropdown (ACI 318-19 / EN 1992-1-1) and **Units** toggle (Imperial / SI) tailor this step — they change the rebar size lists (US customary vs metric bars) and the stirrup-spacing units (in vs mm) shown here **without** altering the global project design code or unit settings.
4. **Plan map** — beams drawn from their I/J node coordinates, color-coded by DCR (green < 0.7 → red ≥ 1.0). Beams auto-group by story · section by default; the wizard's **"Design groups from ETABS"** picker lets you opt specific ETABS group names in — beams in a selected group mirror that name as their design group, the rest fall back to story · section. Shift-click to merge custom groups and batch-adjust bars. Double-click a beam to import and open it with shear/moment diagrams (envelope of imported combos with φVn / φMn capacity overlays) and editable rebar.

Imported members keep their ETABS link (frame name, story, groups, node coordinates) and station forces, and the shear check is evaluated per stirrup zone against the max |V| within each third of the span.

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

[Node.js 18+](https://nodejs.org/en/download) — free, one-time install (~70 MB).

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
- **Windows** — `release/S-Concrete Design Setup x.x.x.exe`
- **macOS** — `release/S-Concrete Design-x.x.x.dmg`
- **Linux** — `release/S-Concrete Design-x.x.x.AppImage`

Once installed, the app runs with no Node.js or browser required.

### Option C — Static web build

```bash
npm install
npm run build
# Serve the dist/ folder from any static host (Netlify, GitHub Pages, nginx, etc.)
```

### Development commands

```bash
npm run dev           # Hot-reload dev server
npm test              # Run unit tests (Vitest)
npm run test:watch    # Watch mode
npm run electron:dev  # Electron dev mode with hot-reload
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
                            #   rebar seeding, member/group mapping
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
  contexts/
    UnitsContext.tsx         # React context for active unit system
  types/                    # TypeScript interfaces (beam, column, common)
  components/
    Dashboard/              # Project overview, member table, DCR chart
    ModelMap/               # Map tab: SVG plan canvas (MapCanvas), group panel,
                            #   group rebar editor, AutoGroupPanel + HistogramPanel
                            #   (demand clustering UI), SavingsPanel, colorRamp.ts
                            #   (continuous hotspot ramp; ModelMapView composes them)
    EtabsImport/            # 4-step ETABS import wizard
    Results/                # Per-member DCR bars, summary table, calc modal
    Detailing/              # SVG section, elevation, P-M diagram, interaction views
    SectionInput/           # Member editor (geometry, materials, loads)
  App.tsx                   # Layout, state, code-selector
electron/
  main.cjs                  # Electron main process
  etabsBridge.cjs           # spawns the .NET sidecar, JSON-lines over stdio
tools/
  EtabsHelper/              # C# sidecar: attaches to running ETABS via the
                            #   .NET API (ETABSv1.dll by reflection, no COM)
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
