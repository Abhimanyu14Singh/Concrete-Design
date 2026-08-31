import { stationLoadCases } from '../../src/adapters/etabs/index.ts'

// The demo's model: an ETABS-scale frame, in the app's own Member and DesignGroup
// shapes, fed to the app's own engine. Six hand-written beams carry the specific cases
// worth looking at (a failure, zoned links, a torsion-governed spandrel); the rest is
// generated so the shell is exercised at the size a real import arrives at, not at the
// size that makes a screenshot look tidy.
//
// Scale is not free of consequence and it is worth stating what it costs: the whole set
// runs eagerly through the engine on every render of the main window's model memo. That
// is affordable — ~8,000 rows design in under 40 ms — which is why the member list can
// carry live DCRs at all. If it ever stops being affordable, the fix is a cache keyed on
// member identity, not a cheaper number in the list.

// ── force shapes ────────────────────────────────────────────────────────────────

// A continuous-beam force envelope: parabolic moment through three fixed points
// (−Mneg at each end, +Mpos at midspan) with the shear read off as its derivative.
//
//   M(ξ) = A + Bξ + Cξ²,  ξ = x/L,  M(0) = −Mi, M(1) = −Mj, M(½) = +Mpos
//
// A UDL on a fixed-ended span is the Mi = Mj = 2·Mpos case, so leaving the three free
// lets a member be written as sagging-, hogging- or balance-governed without inventing
// a load pattern for it. Torsion runs linearly from ±T at the ends to zero at midspan,
// which is the spandrel shape.
function envelope(combo, L, Mi, Mpos, Mj, T = 0, n = 10) {
  const B = 4 * Mpos + 3 * Mi + Mj
  const C = -2 * Mi - 2 * Mj - 4 * Mpos
  const stations = []
  for (let k = 0; k <= n; k++) {
    const xi = k / n
    stations.push({
      x: +(xi * L).toFixed(2),
      M: +(-Mi + B * xi + C * xi * xi).toFixed(2),
      V: +((B + 2 * C * xi) / L).toFixed(2),
      T: +(T * (1 - 2 * xi)).toFixed(2),
    })
  }
  return { combo, stations }
}

// Deterministic jitter. Math.random() would make every reload a different building and
// every screenshot a different number, which is exactly what you do not want when the
// point is to compare two versions of a screen. Hash the member's own id instead: same
// model every time, but not a suspiciously uniform one.
function hash(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 10000) / 10000        // 0 … 1
}
const jitter = (id, salt, spread) => 1 + (hash(id + salt) - 0.5) * 2 * spread

const STEEL = { fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1.0 }

/** Build a member and expand its station forces into per-station load rows — the same
 *  expansion the ETABS import does, so the Loads panel shows what the real app shows:
 *  many rows per member, each a separate check. */
function beam(m) {
  return { ...m, memberType: 'beam', loads: stationLoadCases(m.stationForces, undefined, m.span) }
}

/**
 * Same as beam(), then attaches axial and MINOR-AXIS moment to every row.
 *
 * It has to be a second pass rather than more arguments to envelope(), because
 * StationForce carries no minor-axis moment and stationLoadCases emits no Mux/Muy —
 * both are shaped for the ETABS import, which is major-axis only. Rather than widen the
 * app's import types for one demo member, the rows are decorated here after the same
 * expansion every other beam goes through, so B7 still has one row per station per combo
 * and still bins into tie zones by `x` like everything else.
 *
 * `axial[i]` and `muyPeak[i]` index the combos in stationForces order. Muy follows
 * 4ξ(1−ξ) — the simple-span parabola, zero at the columns and peak at midspan — because
 * the facade load spans horizontally between the supports. Mux is the row's own
 * major-axis magnitude, so the contour is fed the two moments that genuinely coexist at
 * that station rather than two separate maxima that never occur together.
 */
function biaxialBeam(m) {
  const span = m.span
  const byCombo = new Map(m.stationForces.map((cf, i) => [cf.combo, i]))
  const loads = stationLoadCases(m.stationForces, undefined, span).map(l => {
    const i = byCombo.get(l.label.replace(/\s*@.*$/, '')) ?? 0
    const xi = span > 0 ? (l.x ?? 0) / span : 0
    const Muy = +((m.muyPeak[i] ?? 0) * 4 * xi * (1 - xi)).toFixed(2)
    return {
      ...l,
      Pu: m.axial[i] ?? 0,
      Mux: Math.max(l.Mu_pos, l.Mu_neg),
      Muy,
    }
  })
  const { axial: _a, muyPeak: _p, ...rest } = m
  return { ...rest, memberType: 'beam', loads }
}

// ── the six worth looking at ────────────────────────────────────────────────────

const FEATURED = [
  beam({
    id: 'B1',
    label: 'B1 — L2 · Grid A / 1–3',
    span: 24,
    material: { fc: 4000, ...STEEL },
    section: { type: 'rectangular_beam', b: 16, h: 24, coverClear: 1.5, stirrupDia: 4 },
    rebar: {
      topBars: [{ numBars: 3, barSize: 8 }],
      botBars: [{ numBars: 4, barSize: 8 }],
      ties: { barSize: 4, spacing: 6, legs: 2 },
    },
    stationForces: [
      envelope('1.2D+1.6L', 24, 186, 128, 172, 9),
      envelope('1.4D', 24, 142, 98, 131, 6),
      envelope('1.2D+1.0E+0.5L', 24, 205, 96, 198, 14),
    ],
  }),
  beam({
    id: 'B2',
    label: 'B2 — L2 · Grid B / 2–4',
    span: 30,
    material: { fc: 5000, ...STEEL },
    section: { type: 'rectangular_beam', b: 14, h: 28, coverClear: 1.5, stirrupDia: 4 },
    rebar: {
      topBars: [{ numBars: 3, barSize: 9 }],
      botBars: [{ numBars: 5, barSize: 9 }],
      ties: { barSize: 4, spacing: 5, legs: 2 },
    },
    stationForces: [
      envelope('1.2D+1.6L', 30, 264, 196, 251, 12),
      envelope('1.4D', 30, 201, 149, 191, 8),
      envelope('1.2D+1.0E+0.5L', 30, 288, 141, 279, 19),
    ],
  }),
  // Deliberately under-sized: the member the workspace should light up red, and the one
  // worth detaching the Calc Sheet for.
  beam({
    id: 'B3',
    label: 'B3 — L2 · Grid C / 1–2 (transfer)',
    span: 22,
    material: { fc: 4000, ...STEEL },
    section: { type: 'rectangular_beam', b: 14, h: 20, coverClear: 1.5, stirrupDia: 4 },
    rebar: {
      topBars: [{ numBars: 2, barSize: 7 }],
      botBars: [{ numBars: 3, barSize: 7 }],
      ties: { barSize: 3, spacing: 10, legs: 2 },
    },
    stationForces: [
      envelope('1.2D+1.6L', 22, 214, 158, 209, 16),
      envelope('1.2D+1.0E+0.5L', 22, 246, 121, 238, 24),
    ],
  }),
  // Zoned stirrups: tight at the ends, open through the middle third. Shear capacity is
  // read at the spacing of the zone each station sits in — so the governing shear row
  // here is NOT simply the largest Vu.
  beam({
    id: 'B4',
    label: 'B4 — L2 · Grid D / 3–5 (zoned links)',
    span: 32,
    material: { fc: 5000, ...STEEL },
    section: { type: 'rectangular_beam', b: 18, h: 30, coverClear: 1.5, stirrupDia: 4 },
    rebar: {
      topBars: [{ numBars: 4, barSize: 9 }],
      botBars: [{ numBars: 5, barSize: 9 }],
      ties: { barSize: 4, spacing: 4, legs: 2 },
      tieZones: [{ spacing: 4 }, { spacing: 12 }, { spacing: 4 }],
    },
    stationForces: [
      envelope('1.2D+1.6L', 32, 318, 232, 305, 11),
      envelope('1.4D', 32, 242, 177, 232, 7),
      envelope('1.2D+1.0E+0.5L', 32, 351, 168, 340, 18),
    ],
  }),
  beam({
    id: 'B5',
    label: 'B5 — L2 · Grid A / 4–5 (short)',
    span: 18,
    material: { fc: 4000, ...STEEL },
    section: { type: 'rectangular_beam', b: 12, h: 20, coverClear: 1.5, stirrupDia: 3 },
    rebar: {
      topBars: [{ numBars: 2, barSize: 6 }],
      botBars: [{ numBars: 3, barSize: 6 }],
      ties: { barSize: 3, spacing: 7, legs: 2 },
    },
    stationForces: [
      envelope('1.2D+1.6L', 18, 84, 61, 79, 4),
      envelope('1.4D', 18, 64, 47, 60, 3),
    ],
  }),
  // A spandrel carries real torsion — the member whose torsion chip bites.
  beam({
    id: 'B6',
    label: 'B6 — L2 · Grid E / 1–3 (spandrel)',
    span: 26,
    material: { fc: 4000, ...STEEL },
    section: { type: 'rectangular_beam', b: 12, h: 26, coverClear: 2, stirrupDia: 4 },
    rebar: {
      topBars: [{ numBars: 3, barSize: 8 }],
      botBars: [{ numBars: 3, barSize: 8 }],
      sideBars: [{ numBars: 2, barSize: 4 }],
      ties: { barSize: 4, spacing: 6, legs: 2 },
    },
    stationForces: [
      envelope('1.2D+1.6L', 26, 172, 118, 165, 38),
      envelope('1.2D+1.0E+0.5L', 26, 191, 92, 186, 47),
    ],
  }),
  // A collector, and the only member here that is NOT in pure uniaxial bending.
  //
  // A perimeter beam on the diaphragm's load path does three things at once: it drags
  // the floor's inertial force back into the frame (AXIAL, and it reverses sign with the
  // direction of shaking), it carries its own strip of slab (MAJOR-axis bending), and it
  // spans horizontally between columns under wind on the facade it supports (MINOR-axis
  // bending). That combination is why the P-M and biaxial checks exist, and nothing else
  // in this model exercises them — every other beam has Pu = 0 and no Muy, so both
  // sections stay dormant and their charts are unreachable.
  //
  // Nearly square on purpose. A 20x24 has comparable capacity about both axes, so the
  // Bresler contour is a real trade-off rather than a formality: on a 12x30 the minor
  // axis is so weak that any Muy worth drawing would simply fail it.
  biaxialBeam({
    id: 'B7',
    label: 'B7 — L2 · Grid A / 5–6 (collector, biaxial)',
    span: 26,
    material: { fc: 5000, ...STEEL },
    section: { type: 'rectangular_beam', b: 20, h: 24, coverClear: 1.5, stirrupDia: 4 },
    rebar: {
      topBars: [{ numBars: 4, barSize: 9 }],
      botBars: [{ numBars: 4, barSize: 9 }],
      sideBars: [{ numBars: 2, barSize: 5 }],
      ties: { barSize: 4, spacing: 6, legs: 2 },
    },
    stationForces: [
      // Gravity only: no collector force, no wind — the row that shows what the beam
      // does on an ordinary day, and the one where the biaxial section is absent.
      envelope('1.2D+1.6L', 26, 148, 104, 142, 6),
      // Seismic, pushing: the diaphragm drags 96 kips of compression through it.
      envelope('1.2D+1.0E+0.5L', 26, 166, 82, 160, 11),
      // Seismic, pulling: same magnitude in TENSION. Worth its own row because tension
      // reduces the moment capacity instead of raising it — the P-M curve is not
      // symmetric about P = 0, and this is the row that shows it.
      envelope('0.9D+1.0E', 26, 121, 58, 117, 9),
    ],
    // Per-combo axial (kips, + compression) and peak minor-axis moment (kip-ft).
    // Muy is parabolic — zero at the columns, peak at midspan — because the facade
    // load spans horizontally between them; the axial is constant along the member.
    axial: [0, 96, -74],
    muyPeak: [0, 190, 172],
  }),
]

// ── the rest of the building ────────────────────────────────────────────────────

// A real grid, and every beam's span read OFF it.
//
// This matters more than it looks. The plan view and the design have to be the same
// building: if spans came from a per-role constant while the plan drew beams between
// grid lines, a 30 ft girder would appear as a 22 ft line and the whole view would be a
// decoration rather than a model. So the grid is defined first and the span is derived,
// which also gives the more realistic result that a girder and an infill beam sharing a
// bay share a span.
const BAY_X = [30, 24, 30, 22, 30, 24, 30]   // gridlines 1→2 … 7→8 (ft)
const BAY_Y = [24, 30, 24, 30, 24]           // gridlines A→B … E→F (ft)

const cumulative = bays => bays.reduce((acc, w) => [...acc, acc[acc.length - 1] + w], [0])
const GX = cumulative(BAY_X)                 // x of gridlines 1…8
const GY = cumulative(BAY_Y)                 // y of gridlines A…F
const XLINES = ['A', 'B', 'C', 'D', 'E', 'F']
const LEVELS = ['L2', 'L3', 'L4', 'R']
const STORY_Z = { L1: 0, L2: 14, L3: 28, L4: 42, R: 56 }

// Each beam gets a ROLE, and the role picks the section, the cage and the load
// intensity — roughly how a real job arrives: a handful of repeated types, not 174
// unique members. `ref` is the span the quoted moments belong to; anything else scales.
const ROLES = {
  girder:   { ref: 30, fc: 5000, sec: { type: 'rectangular_beam', b: 14, h: 28 },
              top: [{ numBars: 3, barSize: 9 }], bot: [{ numBars: 5, barSize: 9 }],
              ties: { barSize: 4, spacing: 6, legs: 2 }, M: [252, 184, 240], T: 10 },
  filler:   { ref: 24, fc: 4000, sec: { type: 'rectangular_beam', b: 14, h: 24 },
              top: [{ numBars: 3, barSize: 8 }], bot: [{ numBars: 4, barSize: 8 }],
              ties: { barSize: 3, spacing: 7, legs: 2 }, M: [138, 96, 132], T: 5 },
  spandrel: { ref: 26, fc: 4000, sec: { type: 'rectangular_beam', b: 14, h: 28 },
              top: [{ numBars: 3, barSize: 8 }], bot: [{ numBars: 3, barSize: 8 }],
              side: [{ numBars: 2, barSize: 4 }],
              ties: { barSize: 4, spacing: 6, legs: 2 }, M: [168, 114, 162], T: 34 },
  // The roof carries less and is detailed lighter — its own group, not a lightly-loaded
  // member of the typical one.
  roof:     { ref: 26, fc: 4000, sec: { type: 'rectangular_beam', b: 14, h: 22 },
              top: [{ numBars: 3, barSize: 7 }], bot: [{ numBars: 4, barSize: 7 }],
              ties: { barSize: 3, spacing: 10, legs: 2 }, M: [104, 74, 99], T: 4 },
}

const roleFor = (level, lineIdx, bay) =>
  level === 'R' ? 'roof'
    : (lineIdx === 0 || lineIdx === XLINES.length - 1) ? 'spandrel'
      : bay % 3 === 0 ? 'filler' : 'girder'

function generated() {
  const out = []
  for (let li = 0; li < LEVELS.length; li++) {
    const level = LEVELS[li]
    for (let xi = 0; xi < XLINES.length; xi++) {
      const line = XLINES[xi]
      for (let bay = 1; bay <= BAY_X.length; bay++) {
        const id = `${level}-${line}${bay}`
        const R = ROLES[roleFor(level, xi, bay)]
        const span = BAY_X[bay - 1]
        // Moment on a UDL span goes as L², so a bay 25% longer is not 25% worse. The
        // jitter on top is deterministic (hashed from the id), keeping the building the
        // same on every reload without making it suspiciously uniform.
        const k = (span / R.ref) ** 2 * jitter(id, 'load', 0.16) * (level === 'R' ? 0.82 : 1 - li * 0.04)
        out.push(beam({
          id,
          label: `${id} — ${level} · Grid ${line} / ${bay}–${bay + 1}`,
          span,
          role: roleFor(level, xi, bay),
          level,
          // Plan geometry: the bay this beam spans, on this storey.
          pt1: { x: GX[bay - 1], y: GY[xi], z: STORY_Z[level] },
          pt2: { x: GX[bay],     y: GY[xi], z: STORY_Z[level] },
          material: { fc: R.fc, ...STEEL },
          section: { ...R.sec, coverClear: R.side ? 2 : 1.5, stirrupDia: R.ties.barSize },
          // Deep-copied per member, not shared with the role template: two beams
          // pointing at ONE cage object alias each other the moment anything edits in
          // place, and it is also what a naive clone-guard chokes on.
          rebar: {
            topBars: R.top.map(g => ({ ...g })),
            botBars: R.bot.map(g => ({ ...g })),
            ...(R.side ? { sideBars: R.side.map(g => ({ ...g })) } : {}),
            ties: { ...R.ties },
          },
          stationForces: [
            envelope('1.2D+1.6L', span, R.M[0] * k, R.M[1] * k, R.M[2] * k, R.T * k),
            envelope('1.4D', span, R.M[0] * k * 0.76, R.M[1] * k * 0.76, R.M[2] * k * 0.76, R.T * k * 0.7),
            envelope('1.2D+1.0E+0.5L', span, R.M[0] * k * 1.1, R.M[1] * k * 0.72, R.M[2] * k * 1.08, R.T * k * 1.35),
          ],
        }))
      }
    }
  }
  return out
}

const GENERATED = generated()

// The six study beams sit on their own storey, laid end to end. They are not part of the
// regular frame — that is the point of them — so giving them a level of their own keeps
// them visible in plan without pretending they belong to a bay.
let studyX = 0
for (const m of FEATURED) {
  m.level = 'L1'
  m.pt1 = { x: studyX, y: GY[0], z: STORY_Z.L1 }
  studyX += m.span
  m.pt2 = { x: studyX, y: GY[0], z: STORY_Z.L1 }
}

/** The section-property name a member draws under. One function, so the plan's frames
 *  and each member's own ETABS link can never name the same beam two different things.
 *
 *  Named by SIZE, in the B<b>X<h> form an ETABS frame-section property actually uses.
 *  It used to name by shape — 'T-girder' / 'L-spandrel' / 'Rect' — which stopped saying
 *  anything the moment every section became rectangular: colouring the plan by Section,
 *  and auto-grouping on it, would have collapsed to one bin over all 174 members.
 *
 *  A side effect worth knowing: girders and spandrels both had a 14in web, so with the
 *  flanges gone they are the same 14x28 section and share one name. That is not a bug —
 *  stripped of its flange a girder IS its web — but it does mean the two roles no longer
 *  separate by section. They still separate by role, which is what GROUPS bins on. */
function sectionNameOf(m) {
  const s = m.section
  return `B${Math.round(s.b)}X${Math.round(s.h)}`
}

// Every member carries the ETABS link a real import writes. This is not decoration:
// auto-grouping reads `etabs.frameName` to light a proposed bin up on the plan, and
// `etabs.pt1/pt2` for the member's true length. Without it the wizard still clusters,
// but it clusters on span-only lengths and highlights nothing — a silent degradation
// rather than a loud failure, which is the worst kind to leave lying around.
for (const m of [...FEATURED, ...GENERATED]) {
  m.etabs = {
    frameName: m.id,
    story: m.level,
    groups: [],
    pt1: m.pt1,
    pt2: m.pt2,
    sectionName: sectionNameOf(m),
  }
}

export const MEMBERS = [...FEATURED, ...GENERATED]

// ── the columns ─────────────────────────────────────────────────────────────────
// A vertical frame at every grid intersection, one lift per storey.
//
// These are CONTEXT, not members: never designed, never selectable, never grouped —
// MapCanvas draws them with pointerEvents:'none' and no data-framename, so they stay out
// of picking, lasso and grouping entirely. They also only render in 3D, because in plan a
// column projects to a single point and 48 dots scattered over the beams is noise.
//
// They earn their place the moment you tilt the view: without them the 3D model is four
// unconnected rafts of beams floating one above another, and it is genuinely hard to tell
// which storey you are looking at. With them it reads as a building.
const COLUMN_LIFTS = [['L1', 'L2'], ['L2', 'L3'], ['L3', 'L4'], ['L4', 'R']]

const COLUMNS = COLUMN_LIFTS.flatMap(([below, level]) =>
  GX.flatMap((x, i) =>
    GY.map((y, j) => ({
      id: `C${i + 1}${XLINES[j]}-${level}`,
      story: level,
      sectionName: 'COL',
      pt1: { x, y, z: STORY_Z[below] },
      pt2: { x, y, z: STORY_Z[level] },
    }))))

// ── the plan ────────────────────────────────────────────────────────────────────
// The app's own ModelMap shape, so MapCanvas can draw it unmodified. Every frame
// carries `memberId`, which is what links a line on the plan to a designed beam — no
// frame here is un-linked, because everything in this model was "imported".
// ── slabs and core walls ────────────────────────────────────────────────────────
// Context, not members: nothing here is designed, and MapCanvas draws it behind the
// beams and out of picking entirely. It exists so the plan reads as a floor rather than
// a raft of lines — and so the element filters have something to filter.
//
// One floor plate per storey plus a lift/stair core between grids 3–4 / C–D. L1 gets
// neither: it is the study strip, not a floor.
const WALL_T = 1   // ft, nominal core wall thickness

const rectPts = (x0, y0, x1, y1, z) =>
  [{ x: x0, y: y0, z }, { x: x1, y: y0, z }, { x: x1, y: y1, z }, { x: x0, y: y1, z }]

export const WALLS = LEVELS.flatMap(lvl => {
  const z = STORY_Z[lvl]
  const cx0 = GX[2], cx1 = GX[3], cy0 = GY[2], cy1 = GY[3]
  return [
    { id: `slab-${lvl}`, story: lvl, kind: 'slab', sectionName: 'Slab 8"',
      points: rectPts(GX[0], GY[0], GX[GX.length - 1], GY[GY.length - 1], z) },
    { id: `core-${lvl}-S`, story: lvl, kind: 'wall', sectionName: 'Core 12"',
      points: rectPts(cx0, cy0, cx1, cy0 + WALL_T, z) },
    { id: `core-${lvl}-N`, story: lvl, kind: 'wall', sectionName: 'Core 12"',
      points: rectPts(cx0, cy1 - WALL_T, cx1, cy1, z) },
    { id: `core-${lvl}-W`, story: lvl, kind: 'wall', sectionName: 'Core 12"',
      points: rectPts(cx0, cy0, cx0 + WALL_T, cy1, z) },
    { id: `core-${lvl}-E`, story: lvl, kind: 'wall', sectionName: 'Core 12"',
      points: rectPts(cx1 - WALL_T, cy0, cx1, cy1, z) },
  ]
})

export const MODEL_MAP = {
  source: 'mock',
  modelName: 'Demo frame — A–F / 1–8, four levels',
  importedAt: '2026-08-06T00:00:00.000Z',
  stories: ['R', 'L4', 'L3', 'L2', 'L1'],
  frames: MEMBERS.map(m => ({
    frameName: m.id,
    story: m.level || 'L1',
    sectionName: sectionNameOf(m),
    pt1: m.pt1,
    pt2: m.pt2,
    memberId: m.id,
  })),
  columns: COLUMNS,
  walls: WALLS,
  grids: [
    ...GX.map((x, i) => ({
      id: `g-${i + 1}`, label: String(i + 1),
      p1: { x, y: GY[0] - 12, z: 0 }, p2: { x, y: GY[GY.length - 1] + 12, z: 0 },
    })),
    ...GY.map((y, i) => ({
      id: `g-${XLINES[i]}`, label: XLINES[i],
      p1: { x: GX[0] - 12, y, z: 0 }, p2: { x: GX[GX.length - 1] + 12, y, z: 0 },
    })),
  ],
}

// ── design groups ───────────────────────────────────────────────────────────────
// A group is a set of beams designed together against one cage and the group envelope,
// which is how the app works and how the left rail is organised. The featured six sit in
// their own group precisely because they are NOT alike — that is what makes a group
// dashboard interesting to look at.

const byRoleLevel = new Map()
for (const m of MEMBERS) {
  if (!m.role) continue
  const key = `${m.role}|${m.level}`
  if (!byRoleLevel.has(key)) byRoleLevel.set(key, [])
  byRoleLevel.get(key).push(m.id)
}

const ROLE_NAME = { girder: 'Girders', filler: 'Infill beams', spandrel: 'Spandrels', roof: 'Roof beams' }
// Group colours: the app's CATEGORICAL palette, which deliberately contains NO status
// hues — a coloured group must never read as a pass/fail result.
const CATEGORICAL = ['#2563eb', '#7c3aed', '#0d9488', '#db2777', '#4f46e5', '#0891b2', '#c026d3', '#0369a1']

export const GROUPS = [
  {
    id: 'G-featured',
    label: 'Study beams',
    memberIds: FEATURED.map(m => m.id),
    color: CATEGORICAL[0],
    source: 'manual',
  },
  ...[...byRoleLevel.entries()].map(([key, memberIds], i) => {
    const [role, level] = key.split('|')
    return {
      id: `G-${role}-${level}`,
      label: `${level} ${ROLE_NAME[role]}`,
      memberIds,
      color: CATEGORICAL[(i + 1) % CATEGORICAL.length],
      source: 'auto',
    }
  }),
]
