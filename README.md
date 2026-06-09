# S-Concrete Design

Reinforced concrete design application per **ACI 318-19**, similar to Altair S-Concrete.
Covers beams (rectangular, T-beam, L-beam) and columns (rectangular, circular).

---

## Features

- **Flexure** — rectangular stress block, T-beam flange, tension/compression reinforcement, φ factor per strain
- **Shear** — ACI 318-19 size-effect method (Table 22.5.5.1), stirrup contribution, minimum stirrup check
- **Torsion** — cracking torsion, neglect threshold, space truss capacity
- **Columns** — P-M interaction diagram, biaxial check
- **DCR dashboard** — per-member Demand/Capacity Ratio bars and status (OK / Warning / NG)
- **Section detailing** — SVG cross-section and elevation views with bar layout
- **Calculation breakdown** — step-by-step ACI code equations with substituted values

---

## Option A — Run in browser (needs Node.js once)

**Prerequisites:** [Node.js 18+](https://nodejs.org/en/download) (free, one-time install ~70 MB)

```bash
# 1. Clone
git clone https://github.com/Abhimanyu14Singh/Concrete-Design.git
cd Concrete-Design

# 2. Install dependencies (one-time, ~30 seconds)
npm install

# 3. Start
npm run dev
# → Open http://localhost:5173 in your browser
```

---

## Option B — Desktop app, no browser needed (Electron)

**Prerequisites:** Node.js 18+ (same as above — needed only to build)

```bash
npm install
npm run electron:build
```

This produces an installer in the `release/` folder:
- **Windows** → `release/S-Concrete Design Setup x.x.x.exe`  (double-click to install, then launch from Start Menu)
- **macOS**   → `release/S-Concrete Design-x.x.x.dmg`
- **Linux**   → `release/S-Concrete Design-x.x.x.AppImage` (mark executable: `chmod +x *.AppImage && ./S-Concrete*.AppImage`)

Once installed, the app runs with **zero prerequisites** — no Node.js, no browser, no internet.

---

## Option C — Static web build (host anywhere)

```bash
npm install
npm run build
# Serve the dist/ folder from any static host (Netlify, GitHub Pages, nginx, etc.)
```

---

## Development

```bash
npm run dev          # Hot-reload dev server
npm test             # Run 40 unit tests (Vitest)
npm run test:watch   # Watch mode
npm run electron:dev # Electron in dev mode (hot-reload)
```

---

## Architecture

```
src/
  types/           # TypeScript interfaces (Member, Section, Load, Results)
  utils/
    concreteDesign.ts   # ACI 318-19 design engine (pure functions)
    calcBreakdown.ts    # Step-by-step calculation generator
    sampleData.ts       # Pre-loaded sample project
    __tests__/          # 40 Vitest unit tests
  components/
    Dashboard/          # Project overview, member table, DCR chart
    Results/            # Per-member DCR bars, summary table, calc modal
    Detailing/          # SVG section view, elevation view, P-M diagram
    SectionInput/       # Member editor (geometry, materials, loads)
    common/             # StatusBadge, DCRBar
  App.tsx              # Layout, routing, state
electron/
  main.cjs             # Electron main process
```

---

## Honest status

This is a **well-structured prototype**, not a certified production tool. Gaps to close before production use:

| Gap | Status |
|-----|--------|
| Unit tests for design engine | ✅ 40 tests passing |
| Input validation & error boundaries | ⚠ Partial |
| Save / load project files | ❌ Not yet |
| PDF / Excel report export | ❌ Not yet |
| Biaxial column design (full) | ⚠ Interaction diagram only |
| Wall design | ❌ Not yet |
| Seismic detailing (ACI 318-19 Ch. 18) | ❌ Not yet |
| Accessibility (WCAG) | ❌ Not yet |
| Professional PE review of engine | ❌ Required before real use |

> **Important:** All calculations should be independently verified by a licensed engineer before use in any real project.
