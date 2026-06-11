# S-Concrete

A structural reinforced concrete design web application built with **React + TypeScript + Vite** — beams, columns, and special structural shear walls.

Supports **ACI 318-19**, **ACI 318-25** (shear walls), and **EN 1992-1-1 (Eurocode 2)** with step-by-step calculation sheets, DCR dashboards, section detailing views, and a plugin-ready engine architecture.

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
| ACI 318-25 (walls) | §18.10.5 P-M | §18.10.4 | — | §11.6, §18.10.2.2, §18.10.6 | — |
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
- Crack width w_k (§7.3.4) for bottom, top, and side faces; accepts per-face limits, M_qp/Mu ratio, and kt factor

**ACI 318-19 / EC2 column design**
- Rectangular and circular columns with full P-M interaction diagrams (strain compatibility)
- Biaxial bending (Bresler / EC2 §5.8.9 exponent method), tied and spiral configurations
- Column shear including axial-load enhancement; tie spacing detailing checks

**ACI 318-25 special structural wall design**
- Distributed vertical/horizontal web reinforcement, 1 or 2 curtains
- Minimum reinforcement ratios ρl, ρt (§11.6) and bar spacing limits (§18.10.2.2)
- In-plane shear Vn = Acv(αc·λ·√f'c + ρt·fyt) with hw/lw-dependent αc and the 10·Acv·√f'c cap (§18.10.4)
- P-M interaction by strain compatibility over distributed web steel + boundary bars (§18.10.5)
- Special boundary zone (SBZ) triggers: strain-based c-limit (§18.10.6.2) and 0.2f'c stress check (§18.10.6.3)
- SBZ design: zone length lbe, confinement Ash, tie spacing ≤ min(6db, 6") (§18.10.6.4)
- Plan-view SVG graphics showing web bars, SBZ zones, and confinement ties

### Design Code Selector
Switch between ACI 318-19, ACI 318-14, and EN 1992-1-1 from the header without losing project data.

### Step-by-Step Calculation Sheet
"Show Calculations" opens a modal with every check displayed as:
`equation → substitution → result`

Covers all EC2 checks including V+T interaction, negative flexure, and top/side face crack widths.

### SI / Imperial Unit Toggle
Display units can be toggled between SI and imperial at any time. Project data is stored internally in imperial units; conversions are applied on display.

### Metric Rebar Support
Bar sizes use a signed encoding: positive values are US customary bars (e.g. `5` = #5), negative values are metric bars (e.g. `-16` = Ø16 mm).

### Crack Control Inputs (EC2)
Per-face crack width limits, quasi-permanent moment ratio M_qp/Mu, and kt factor are configurable inputs for EC2 crack width calculations.

### DCR Dashboard
Bar charts showing Demand/Capacity Ratios for all members and load cases. Status indicators: OK / Warning / NG.

### Multiple Load Cases
Each member supports multiple load cases; all are checked independently.

### Save / Open Project Files
Projects are saved and opened as JSON files for portability and version control.

### Section Detailing Views
SVG cross-section and elevation views showing rebar layout and spacing.

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
  adapters/                 # Placeholder adapters (ETABS, SAP2000 import)
  utils/
    wallDesign.ts           # ACI 318-25 shear wall engine (shear, P-M, SBZ)
    calcBreakdown.ts        # ACI step-by-step calculation sheet generator
    calcBreakdownEC2.ts     # EC2 step-by-step calculation sheet generator
    calcBreakdownWall.ts    # ACI 318-25 wall calculation sheet generator
    units.ts                # SI / imperial conversion utilities
    rebar.ts                # Bar designation helpers (US customary + metric)
  contexts/
    UnitsContext.tsx         # React context for active unit system
  types/                    # TypeScript interfaces (beam, column, wall, common)
  components/
    Dashboard/              # Project overview, member table, DCR chart
    Results/                # Per-member DCR bars, summary table, calc modal
    Detailing/              # SVG section, elevation, wall plan, P-M diagram views
    SectionInput/           # Member editor (geometry, materials, loads)
  App.tsx                   # Layout, state, code-selector
electron/
  main.cjs                  # Electron main process
```

### Plugin-Ready Design
`src/engines/` and `src/adapters/` are structured to accept additional design engines and import adapters (ETABS, SAP2000) without modifying the core UI or existing engines. Beam, column, and shear wall engines are implemented today.

---

## Design Codes Supported

- **ACI 318-19** — Building Code Requirements for Structural Concrete (beams, columns)
- **ACI 318-14** — Previous edition (same clause structure)
- **ACI 318-25** — Special structural walls (§11.6, §18.10)
- **EN 1992-1-1:2004 (Eurocode 2)** — Design of Concrete Structures, Part 1-1 (beams, columns)
