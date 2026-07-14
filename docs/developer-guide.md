# Developer guide — editing the backend & adding a design code

This guide is for a developer (no AI assistant required) who needs to **read the
engineering backend, change a calculation, sanity-check it, and add a new design
code**. It assumes basic familiarity with TypeScript and a terminal.

---

## 1. One-time setup

```bash
# Node 18+ (https://nodejs.org). Then, from the repo root:
npm install
```

That's it — there is no database, no backend server, no build step to run before
editing. The "backend" (all the engineering math) is plain TypeScript functions
under `src/`.

---

## 2. Where the backend lives (the mental model)

Data flows in one direction: **types → engine → dispatcher → UI**. You almost
never touch the UI to change a calculation.

```
src/
  types/                 # The data shapes. Start here to understand a feature.
    index.ts             #   DesignCode, SectionDimensions, RebarLayout, LoadCase,
                         #   DesignResults  ← the inputs/outputs of every check
  engines/               # THE BACKEND — pure calculation functions
    aci/aciColumn.ts     #   ACI 318 column: P-M, shear, torsion, slenderness, detailing
    aci/aciColumnBiaxial.ts  # rotating-NA biaxial solver
    ec2/ec2Beam.ts       #   Eurocode 2 beam
    ec2/ec2Column.ts     #   Eurocode 2 column
    column/index.ts      #   ColumnDesignEngine (registry wrapper)
    beam/index.ts        #   BeamDesignEngine (registry wrapper)
    index.ts             #   runDesign(...)  ← the dispatcher everything calls
    registry.ts          #   register/getEngine by memberType
    types.ts             #   DesignEngine interface (the contract)
  utils/
    concreteDesign.ts    #   ACI beam math + bar tables (getBarArea/getBarDiam, beta1)
    calcBreakdown*.ts    #   "Show Calculations" step-by-step sheets (display only)
    sco/                 #   S-Concrete .SCO/.SCRS: writers + per-group envelope batch
                         #   (scoBatch), .SCRS parser, run client (display/verify only)
    sconcreteMemberResult.ts #  summarises a member's persisted .SCRS result (verify card)
  components/            # React UI — reads results, never computes them
```

> **Note — the S-Concrete "Verify" flow is external, not an engine.** The Map view's
> ② Verify panel (`components/ModelMap/GroupActionsPanel.tsx`) generates `.SCO`
> files for the design groups, and the Electron main process
> (`electron/sconcreteBridge.cjs`) drives S-Concrete's BatchReporter through a
> bundled native sidecar (`tools/SConcreteHelper/` → `SConcreteHelper.exe`, Windows
> UI Automation — **no Python**) and reads the `.SCRS` back. This is a *verification*
> round-trip against a separate desktop tool — it does **not** feed `runDesign` and
> is desktop-only. Results are persisted on the project (`sconcreteResults` /
> `sconcreteRanAt`) and only displayed. Columns
> import from ETABS as first-class members (`memberType: 'column'`,
> `rectangular_column`); their design forces are entered post-import via
> `components/ModelMap/ColumnForceGrid.tsx`, not by the engine.

**The single most important function** is `runDesign(...)` in
`src/engines/index.ts`. Every result in the app comes from it:

```ts
runDesign(section, material, rebar, load, span?, code?, crack?) → DesignResults
```

It looks at `section.type` and `code` and routes to the right engine function
(beam vs column, ACI vs EC2). If you want to know how any number is computed,
open `engines/index.ts`, see which function it routes to, and read that function.

`DesignResults` (in `types/index.ts`) is the flat object every engine returns —
DCRs, capacities, warnings, status. The UI just renders these fields.

---

## 3. The edit → sanity-check loop (no AI needed)

Edit a function, then run the four checks below. They are fast (seconds) and are
exactly what CI runs.

```bash
npx tsc -b            # 1. Types — catches wrong shapes / typos. Must print nothing.
npm test              # 2. Logic — Vitest unit tests (~700). Must say "passed".
npm run lint          # 3. Style — ESLint. (See note below.)
npm run build         # 4. Production build (tsc + vite). Must end "✓ built".
```

A change is "good" when **tsc is clean, the tests pass, and the build succeeds**.

> **Lint note:** `npm run lint` currently reports a handful of *pre-existing*
> warnings in older UI files (unused vars in effect hooks). Those are not from
> your change. The rule of thumb: run `npx eslint <the file you edited>` and make
> sure *that file* is clean.

### See it running

```bash
npm run dev           # http://localhost:5173 — hot-reloads as you save
```

Type some loads into a member and watch the DCRs update — that is `runDesign`
firing live.

### Run just the test you care about (fast iteration)

```bash
npx vitest run src/engines/aci/__tests__/aciColumn.test.ts   # one file
npx vitest                                                    # watch mode (re-runs on save)
```

### Where tests live, and how to write one

Tests sit next to the code in `__tests__/` folders and end in `.test.ts`. A test
just calls the function and asserts the number — no mocking, no setup:

```ts
import { describe, it, expect } from 'vitest';
import { designColumnACI } from '../aciColumn';

it('a lightly loaded 20x20 column is OK', () => {
  const r = designColumnACI(section, material, rebar, load, /* span */ 12);
  expect(r.DCR_PM).toBeLessThan(1);
  expect(r.status).toBe('OK');
});
```

This is also how you **verify a fix**: write the input you think is wrong, assert
the answer you expect, run `npx vitest run <file>`. If it fails, your fix or your
expectation is wrong — iterate until green.

---

## 4. Worked example: change a single calculation

Say the column shear φ-factor is wrong. Steps a developer takes alone:

1. Open `src/engines/aci/aciColumn.ts`, find `aciColumnShear(...)` (search the
   file for `phi = 0.75`).
2. Change the value.
3. Add/adjust a test in `src/engines/aci/__tests__/` that pins the expected `phi_Vn`.
4. `npx vitest run src/engines/aci/__tests__/` → green.
5. `npx tsc -b && npm run build` → clean.

Nothing else in the app needs touching — the UI reads `phi_Vn` from the result.

---

## 5. Adding a new design code

There are two cases. Pick the one that matches.

### Case A — a new *edition* that reuses existing formulas
(e.g. you want "ACI 318-22" and it computes the same as 318-19)

1. **Add the code string** to the `DesignCode` union in **two** files:
   `src/types/index.ts` and `src/types/common.ts`
   ```ts
   export type DesignCode = 'ACI318-19' | 'ACI318-14' | 'EN1992-1-1' | 'ACI318-22';
   ```
2. **List it as supported** in the engine wrappers
   (`src/engines/beam/index.ts` and `src/engines/column/index.ts`):
   ```ts
   readonly supportedCodes = ['ACI318-19', 'ACI318-14', 'ACI318-22', 'EN1992-1-1'];
   ```
3. **Show it in the picker** — add it to the options array in `src/App.tsx`
   (search for `'ACI318-19', 'ACI318-14'`).
4. **Give it a colour** (optional) in `src/theme.ts` → `codeAccent()` / `codeBg()`.
5. Sanity-check (§3). Because `runDesign` defaults non-EC2 codes to the ACI path,
   the new edition already computes — no engine code needed.

### Case B — a genuinely new code with different formulas
(e.g. "CSA A23.3" with its own flexure/shear equations) — follow the **EC2 beam**
example, which is the cleanest template in the repo.

1. **Add the code string** to `DesignCode` (both files, as in Case A).

2. **Write the engine function.** Create `src/engines/csa/csaBeam.ts` (mirror
   `src/engines/ec2/ec2Beam.ts`). It must have this exact signature and return a
   fully-populated `DesignResults`:
   ```ts
   export function designBeamCSA(
     section: SectionDimensions, material: MaterialProps,
     rebar: RebarLayout, load: LoadCase, span = 20,
   ): DesignResults {
     // ...your CSA math, using getBarArea/getBarDiam/beta1 from utils/concreteDesign...
     return { /* every DesignResults field — copy the shape from ec2Beam.ts */ };
   }
   ```
   Use the helpers in `src/utils/concreteDesign.ts` (bar tables, β₁, etc.) so you
   don't re-derive primitives.

3. **Route it** in `src/engines/index.ts` → `runDesign()`:
   ```ts
   import { designBeamCSA } from './csa/csaBeam';
   // inside runDesign, before the default ACI return:
   if (code === 'CSA-A23.3') return designBeamCSA(section, material, rebar, load, span);
   ```
   For a column, add `designColumnCSA` and route it in the `if (isColumn)` block
   of `runDesign` next to `designColumnACI` / `designColumnEC2`.

4. **List + show it** — `supportedCodes` (engine wrappers), the `App.tsx` picker,
   and `codeAccent()` (§A steps 2–4).

5. **Step-by-step sheet (optional but expected).** Create
   `src/utils/calcBreakdownCSA.ts` (mirror `calcBreakdownEC2.ts`) returning
   `CalcSection[]`, then route it in
   `src/components/Results/CalcBreakdownModal.tsx` (the `isEC2 ? … : …` ternary).

6. **Code-specific inputs (only if needed).** EC2 adds crack-width inputs via
   `CrackControlParams` + a `MemberEditor` block gated on `code === 'EN1992-1-1'`.
   Follow that pattern if your code needs extra inputs.

7. **Write a test** — the gold standard here is a *golden-vector* test: run a
   trusted reference (a verified spreadsheet, a textbook example, or a calibrated
   tool) for a handful of cases, paste the expected numbers into a `.test.ts`, and
   assert your engine matches within tolerance. See
   `src/engines/aci/__tests__/columnParity.test.ts` for the pattern used to
   validate the column engine 1:1 against the Python tool.

8. **Sanity-check** (§3): `npx tsc -b && npm test && npm run build`.

### Checklist for "a new code is fully wired"
- [ ] string in `DesignCode` (×2 files) · [ ] engine function returns `DesignResults`
- [ ] routed in `runDesign` · [ ] in `supportedCodes` · [ ] in the `App.tsx` picker
- [ ] (opt) calc-breakdown sheet + modal route · [ ] a test · [ ] tsc/test/build green

---

## 6. Quick reference

| I want to… | Open / run |
|---|---|
| Understand a result field | `src/types/index.ts` (`DesignResults`) |
| See how a number is computed | `src/engines/index.ts` → the routed engine fn |
| Change ACI beam math | `src/utils/concreteDesign.ts` |
| Change ACI column math | `src/engines/aci/aciColumn.ts` |
| Change EC2 math | `src/engines/ec2/ec2Beam.ts`, `ec2Column.ts` |
| Change the workflow ribbon / sidebar chips | `src/App.tsx` |
| Change the map toolbar / ①Design–②Verify panel | `src/components/ModelMap/ModelMapView.tsx` |
| Change the S-Concrete `.SCO`/`.SCRS` batch | `src/utils/sco/scoBatch.ts` + `electron/sconcreteBridge.cjs` |
| Add a code | §5 above |
| Verify a change | `npx tsc -b && npm test && npm run build` |
| Try one test | `npx vitest run <path/to/file.test.ts>` |
| See it live | `npm run dev` |

> Reminder from the README: every calculation must be independently verified by a
> licensed engineer before use on a real project. The tests guard against
> regressions; they are not a substitute for engineering review.
