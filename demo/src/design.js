import { runDesign } from '../../src/engines/index.ts'
import { generateBreakdown } from '../../src/utils/calcBreakdown.ts'
import { generateBreakdownEC2 } from '../../src/utils/calcBreakdownEC2.ts'
import { zoneShearDemands } from '../../src/utils/concreteDesign.ts'
import { capacityLabels } from '../../src/utils/units.ts'
import { continuousCage } from '../../src/utils/curtailment.ts'
import { suggestGroupRebar, isSuggestError } from '../../src/utils/suggestRebar.ts'
import { beamAxialFlexure } from '../../src/utils/axialFlexure.ts'
import { biaxialCheck } from '../../src/utils/biaxial.ts'
import { computeFlexure, getBarArea } from '../../src/utils/concreteDesign.ts'

// The demo's one connection to the real app: it calls runDesign and generateBreakdown
// and does nothing else with the numbers. No re-derivation, no rounding, no fallback —
// if a DCR here disagrees with the app, the demo is not the thing that is wrong.

/** The checks a beam has, in the order the chips read. Torsion and crack width are
 *  per-code: EC2 adds an SLS crack check that ACI has no equivalent for. */
export function checksFor(code) {
  const base = [
    { key: 'flex', label: 'Flexure', of: r => Math.max(r.DCR_flex_pos, r.DCR_flex_neg) },
    { key: 'shear', label: 'Shear', of: r => r.DCR_shear },
    { key: 'torsion', label: 'Torsion', of: r => r.DCR_torsion },
  ]
  return code === 'EN1992-1-1'
    ? [...base, { key: 'crack', label: 'Crack', of: r => r.DCR_crack ?? 0 }]
    : base
}

/**
 * Run every load row of a member and summarise.
 *
 * A member has MANY rows — the ETABS import expands to one per station per combo — and
 * different rows govern different checks. So each check takes the MAX across all rows
 * and remembers WHICH row produced it; nothing here is ever read off row [0] or off a
 * single "representative" row. That mistake has caused three separate bugs in the app,
 * and a demo that repeats it would be showing the wrong beam.
 */
export function designMemberAllRows(member, code) {
  const span = member.span ?? 20
  const rows = member.loads.map(load => ({ load, result: runDesign(member.section, member.material, member.rebar, load, span, code) }))

  // The biaxial check joins the list only for a member that actually has a minor-axis
  // moment. Appending it unconditionally would put a chip reading 0.00 on 174 of 175
  // members — a dead control that teaches people to ignore the row it sits in.
  const hasBiaxial = rows.some(r => r.result.NM_util !== undefined)
  const checkDefs = hasBiaxial
    ? [...checksFor(code), { key: 'biaxial', label: 'Biaxial', of: r => r.NM_util ?? 0 }]
    : checksFor(code)

  const checks = checkDefs.map(c => {
    let best = rows[0], dcr = -Infinity
    for (const row of rows) {
      const v = c.of(row.result)
      if (v > dcr) { dcr = v; best = row }
    }
    return { ...c, dcr: dcr === -Infinity ? 0 : dcr, row: best }
  })

  // The member's headline DCR is the worst check, and the row that produced it is the
  // one the Calc Sheet opens on — so "why is this beam red" is one click, not a hunt.
  const governing = checks.reduce((a, b) => (b.dcr > a.dcr ? b : a), checks[0])

  // Warnings are per-row too; collapse to one of each so the panel is readable, but
  // keep the count, because "12 rows say this" is different from "one row does".
  const seen = new Map()
  for (const { load, result } of rows) {
    for (const w of result.warnings || []) {
      const rec = seen.get(w.code + w.message)
      if (rec) rec.count++
      else seen.set(w.code + w.message, { ...w, count: 1, first: load })
    }
  }

  return { member, code, span, rows, checks, governing, dcr: governing ? governing.dcr : 0, warnings: [...seen.values()] }
}

/**
 * The chart inputs for one row — the P-M surface and the biaxial contour.
 *
 * Computed from the SAME routines the sheet's numbers came from, so the picture and the
 * utilisation printed beside it cannot drift. Both are undefined unless the row actually
 * carries the load that makes them meaningful (axial for P-M, a minor-axis moment for the
 * contour), which is how the Calc Sheet knows whether to offer an icon at all.
 */
export function chartsFor(design, load) {
  const { member, span } = design
  const As = g => (g || []).reduce((t, x) => t + x.numBars * getBarArea(x.barSize), 0)
  const flex0 = computeFlexure(
    member.section, member.material, As(member.rebar.topBars), As(member.rebar.botBars), span,
    member.rebar.topBars?.[0]?.barSize ?? 8, member.rebar.botBars?.[0]?.barSize ?? 8,
    member.rebar.topBars, member.rebar.botBars, member.rebar.layerClearSpacing ?? 1.0,
  )
  return {
    // ALWAYS built, including at Pu = 0. The interaction surface is a property of the
    // section and its cage, not of the load — a beam carrying no axial still has one, and
    // it is worth seeing: it shows how much axial the member could take and how close
    // pure bending sits to the balance point. At Pu = 0 the demand marker simply lands on
    // the P = 0 axis, which is the honest picture rather than a missing chart.
    pm: beamAxialFlexure(
      member.section, member.material, member.rebar, span, 'pos',
      flex0.phi_Mn_pos, load.Pu ?? 0, load.Mu_pos,
    ),
    // The HOGGING surface, so the N-vs-M window can draw the beam's whole envelope
    // rather than one quadrant of it. It is a genuinely different curve: sagging is
    // resisted by the bottom cage with the flange in compression, hogging by the top
    // cage with only the web — on a T-beam the two are not close, and the supports are
    // where the hogging one governs. The app's own DesignResults.interaction carries
    // only the sagging branch, which is why this is built here rather than read off it.
    pmNeg: beamAxialFlexure(
      member.section, member.material, member.rebar, span, 'neg',
      flex0.phi_Mn_neg, load.Pu ?? 0, load.Mu_neg,
    ),
    // Every OTHER load row as a demand dot. One marker says where the selected row sits;
    // the cloud says whether it is the outlier or the middle of the pack — which is the
    // question the "a member has many rows" rule exists to keep in front of people. They
    // are clickable, so the window is also a way to move the selection.
    // The label is the row's IDENTITY only — `combo_station`, e.g. `1.2D+1.6L_2.6`.
    //
    // Deliberately no forces in it, and no units. The values used to be baked in here as
    // "… kip-ft, … kips", which is a wrong label the moment anyone switches to mm·kN:
    // design.js has no access to the unit system, so anything it formats is frozen
    // imperial. The chart has `useUnits` already — it draws the axes with it — so it
    // appends the converted M and P itself and this stays a name. Same rule as the rest
    // of the demo (see format.js).
    pmRows: design.rows.map(({ load: l }) => ({
      id: l.id,
      label: `${l.label.replace(/\s*@.*$/, '')}_${(l.x ?? 0).toFixed(1)}`,
      Pu: l.Pu ?? 0, Mu: l.Mu_pos, Mu_neg: l.Mu_neg,
    })),
    biaxial: biaxialCheck(member.section, member.material, member.rebar, load, span),
  }
}

/** The Calc Sheet for one row, from the app's own breakdown generator. */
export function breakdownFor(design, load) {
  const { member, span, code } = design
  const zoneVu = member.stationForces ? zoneShearDemands(member.stationForces, span) : undefined
  // The two generators do not take the same tail: only the ACI one reads per-third
  // shear demands, and the EC2 one wants the SLS combo name and cotθ instead.
  return code === 'EN1992-1-1'
    ? generateBreakdownEC2(member.section, member.material, member.rebar, load, span, member.crackParams, load.id, 2.5)
    : generateBreakdown(member.section, member.material, member.rebar, load, span, zoneVu)
}

/**
 * Everything the Force Diagram needs, as plain numbers — it has to cross a
 * structured-clone boundary, so no functions and no engine objects.
 *
 * The capacity side is the interesting half. φMn is one number for the member, but φVn
 * is NOT: with zoned links the engine reads capacity at the spacing of the zone the
 * station sits in, so the diagram gets one level per third and draws a step. Each
 * level is the MINIMUM φVn among the rows in that zone — the depth `d` differs between
 * a sagging and a hogging row, so a zone can hold two slightly different capacities and
 * the envelope must take the lower.
 */
export function forceSeries(design) {
  const { member, span, rows } = design
  const combos = member.stationForces || []

  // Envelope across combos at each station, keyed by x so combos with different
  // station lists still line up.
  //
  // SIGNED, both quantities. Shear used to collapse to max|V| here, which drew a diagram
  // that does not exist: |V| on a normal span is high at both ends and dips to zero near
  // midspan, so every beam came out as a symmetric "V" and the sign — which way the
  // section is being sheared — was gone. The stations carry real signed shear (data.js
  // takes V as dM/dx, so it runs positive at the I-node through zero to negative at the
  // J-node); throwing that away made the panel show an absolute-value plot labelled as a
  // shear diagram. Envelope it the same way the moment already was: min and max across
  // combos at each station, so the band spans what the worst combos actually demand and
  // the zero crossing survives.
  const byX = new Map()
  for (const cf of combos) {
    for (const st of cf.stations) {
      const rec = byX.get(st.x) || { x: st.x, Mlo: 0, Mhi: 0, Vlo: 0, Vhi: 0, Tlo: 0, Thi: 0 }
      rec.Mlo = Math.min(rec.Mlo, st.M)
      rec.Mhi = Math.max(rec.Mhi, st.M)
      rec.Vlo = Math.min(rec.Vlo, st.V)
      rec.Vhi = Math.max(rec.Vhi, st.V)
      // Torsion is signed too, and for the same reason it matters on shear: on a
      // spandrel it runs +T at one end through zero to −T at the other, and collapsing
      // to |T| would draw a symmetric hump that no beam actually has.
      rec.Tlo = Math.min(rec.Tlo, st.T ?? 0)
      rec.Thi = Math.max(rec.Thi, st.T ?? 0)
      byX.set(st.x, rec)
    }
  }
  const stations = [...byX.values()].sort((a, b) => a.x - b.x)

  // Capacities as the MINIMUM across every row, never row[0].
  //
  // φMn+ / φMn− and the torsion threshold do come out constant — they are properties of
  // the section, material and cage, and a spread across rows would itself be a bug — so
  // for those the min is just a cheap assertion that costs nothing.
  //
  // φTn is the one that is NOT constant, and reading it off row[0] was drawing a false
  // line. Torsion capacity scales with At/s, so on a member with rebar.tieZones it steps
  // exactly as φVn does: B4 (links 4/12/4) provides 122.5 kip-ft at the ends and 40.8
  // through the middle third. rows[0] sits at x = 0, i.e. the TIGHTEST zone, so the
  // dashed line was drawn at 122.5 across the whole span — three times the capacity that
  // exists at midspan, on the one member in this model detailed to need zoning. Same
  // class of mistake as reading a summary off row[0], which is why nothing else here
  // does it.
  const capOf = k => (rows.length ? Math.min(...rows.map(r => r.result[k])) : 0)
  const capPos = capOf('phi_Mn_pos')
  const capNeg = capOf('phi_Mn_neg')
  // The threshold BELOW which the code lets you ignore torsion altogether (ACI 22.7.1's
  // φ·λ√f′c·Acp²/Pcp; T_Rd,c in EC2). It earns its own line: without it a diagram whose
  // demand sits under it looks like a torsion check that simply passed, when in fact no
  // torsion design was done at all. That is the difference between "this cage carries it"
  // and "the code says there is nothing to carry", and they are not the same statement.
  const capTcr = capOf('Tu_threshold')
  // Kept for anything reading a single number, but as the WEAKEST zone rather than the
  // first — an understated capacity is a safe default, an overstated one is not.
  const capT = capOf('phi_Tn')

  // One band per third when the member has tie zones; one band over the whole span
  // otherwise, so the same drawing code covers both. Shear AND torsion both step, because
  // both are carried by the links whose spacing the zones change.
  const nz = member.rebar.tieZones ? 3 : 1
  const vZones = []
  const tZones = []
  for (let i = 0; i < nz; i++) {
    const x0 = (span * i) / nz, x1 = (span * (i + 1)) / nz
    const inZone = rows.filter(r => {
      const x = r.load.x
      return x === undefined ? true : x >= x0 - 1e-6 && x <= x1 + 1e-6
    })
    const src = inZone.length ? inZone : rows
    vZones.push({ x0, x1, v: Math.min(...src.map(r => r.result.phi_Vn)) })
    tZones.push({ x0, x1, v: Math.min(...src.map(r => r.result.phi_Tn)) })
  }

  // EC2 has no φ: phi_Mn_* / phi_Vn hold γ-factored DESIGN RESISTANCES (M_Rd, V_Rd),
  // so the diagram must not label them with a reduction factor that is not there.
  // capacityLabels() is the app's own answer to this — reuse it rather than branch.
  const cap = capacityLabels(design.code)

  return {
    span,
    combos: combos.length,
    capLabels: { M: cap.Mn, V: cap.Vn, T: cap.Tn, Tcr: cap.Tcr },
    stations,
    Mmin: Math.min(0, ...stations.map(s => s.Mlo)),
    Mmax: Math.max(0, ...stations.map(s => s.Mhi)),
    Vmin: Math.min(0, ...stations.map(s => s.Vlo)),
    Vmax: Math.max(0, ...stations.map(s => s.Vhi)),
    Tmin: Math.min(0, ...stations.map(s => s.Tlo)),
    Tmax: Math.max(0, ...stations.map(s => s.Thi)),
    capPos, capNeg, capT, capTcr, vZones, tZones,
  }
}

/**
 * Per-station envelope of M or V across every combination — what the plan draws as the
 * M / V overlay, one filled polygon per beam — and it is **signed**.
 *
 * This mirrors ModelMapView's own stationEnvelope exactly, and it is a copy only because
 * the app keeps that function module-local. Same shape out — [{x, v}] sorted by station —
 * because MapCanvas's diagramDataById is the app's API and the demo feeds the app's real
 * canvas. If one changes, change the other; that is the price of the copy.
 *
 * At each station the combos span [lo, hi]; the value is whichever end has the larger
 * MAGNITUDE, carrying its sign. Still "the worst demand here", but it also says which way
 * it acts, so the polygon can sit on the correct side of the member.
 *
 * It used to rectify, and that drew two diagrams that do not exist. Hogging over the
 * supports and sagging at midspan landed on the same side, so a continuous span read as
 * three humps and the inflection points — the sign changes an engineer actually reads a
 * moment diagram for — became dips that look like low moment. Shear was worse: |V| is
 * high at both ends and passes through zero near midspan, so every beam in the model came
 * out as the same symmetric "V" and which way the section is sheared was gone before it
 * was drawn. The Force Diagram panel already envelopes signed for this reason.
 */
export function stationEnvelope(stationForces, type) {
  const byX = new Map()
  for (const cf of stationForces || []) {
    for (const s of cf.stations) {
      const val = type === 'M' ? s.M : s.V
      const rec = byX.get(s.x) || { lo: 0, hi: 0 }
      rec.lo = Math.min(rec.lo, val)
      rec.hi = Math.max(rec.hi, val)
      byX.set(s.x, rec)
    }
  }
  return [...byX.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([x, r]) => ({ x, v: -r.lo > r.hi ? r.lo : r.hi }))
}


/**
 * The three per-member maps every summary view wants, off one pass of the designs.
 *
 * Lifted out of App so a FROZEN model version can build the same maps at push time that
 * the live model builds on every render — the Group Dashboard reads one shape whether it
 * is describing what is on screen now or a snapshot taken three pushes ago.
 */
export function summaryMaps(designs) {
  const resultById = {}, dcrById = {}, modeById = {}
  for (const d of designs) {
    const id = d.member.id
    resultById[id] = d.governing.row.result
    dcrById[id] = d.dcr
    // Worst per MODE across ALL rows — not the governing row's — or a chip reads green
    // while a different station pushes that mode over.
    const worst = f => d.rows.reduce((a, r) => Math.max(a, f(r.result) || 0), 0)
    modeById[id] = {
      flexPos: worst(r => r.DCR_flex_pos), flexNeg: worst(r => r.DCR_flex_neg),
      // VT_util folded into shear, torsion its own mode — matching modeDCRs() in the app.
      // Between them these four account for every term worstOf() takes the max of, which
      // is what the DCR column reports.
      shear: worst(r => Math.max(r.DCR_shear, r.VT_util ?? 0)),
      torsion: worst(r => r.DCR_torsion),
      wk: worst(r => r.DCR_crack ?? 0),
    }
  }
  return { resultById, dcrById, modeById }
}

// ── presentation helpers ────────────────────────────────────────────────────────
// The app's three-tone status, kept in one place so chips, list rows, the section
// drawing and the calc footer can never disagree about what 0.94 means.
export const NEAR_CAPACITY = 0.9

export function dcrTone(d) {
  if (!isFinite(d) || d <= 0) return 'none'
  return d > 1 ? 'fail' : d > NEAR_CAPACITY ? 'warn' : 'ok'
}

export const fmtDcr = d => (isFinite(d) ? d.toFixed(2) : '—')

/**
 * What is actually detailed in each L/3 region — the three cages the Elevation draws.
 *
 * Straight out of the app's own model (SectionCard's L/3 pop-out): top steel governs at
 * the SUPPORTS and may be curtailed through mid-span; bottom steel governs at MID-SPAN
 * and may be curtailed toward the supports. So the two faces are reduced in opposite
 * thirds, which is the whole reason a single cage drawn across the span is the wrong
 * picture.
 *
 * A group's explicit cages win where set; otherwise the bottom falls back to
 * continuousCage() — the app's ~continuous cage, floored at code As,min — which is what
 * the ⚑ bottom curtailment flag stands for.
 */
export function regionsFor(design, group) {
  const { topBars, botBars } = design.member.rebar
  const asMin = design.governing.row.result.As_min || 0
  const area = bars => (bars || []).reduce((n, b) => n + Math.max(0, b.numBars), 0)

  const explicitEndBot = group && group.endThirdBotBars && group.endThirdBotBars.length
    ? group.endThirdBotBars : null
  const reduced = continuousCage(botBars, asMin)
  // Only call it curtailed if it actually takes steel out; continuousCage returns the
  // full cage when there is nothing to remove.
  const endBot = explicitEndBot || (area(reduced) < area(botBars) ? reduced : botBars)
  const midTop = group && group.midThirdTopBars && group.midThirdTopBars.length
    ? group.midThirdTopBars : topBars
  const oppTop = group && group.oppositeTopBars && group.oppositeTopBars.length
    ? group.oppositeTopBars : topBars

  return [
    { title: 'Mark End', top: topBars, bot: endBot },   // support: top full, bottom curtailed
    { title: 'Middle ⅓', top: midTop, bot: botBars }, // mid-span: top curtailed, bottom full
    { title: 'Opp. End', top: oppTop, bot: endBot },    // support: top reduced, bottom curtailed
  ]
}

/**
 * Auto-size every group's cage — the app's ✨ Suggest, run over the whole model.
 *
 * A straight port of ModelMapView.runSuggestAllGroups: for each group with designed
 * beams, invert the capacity checks for a cage that lands at or under the target DCR,
 * then apply that ONE cage to the group template and to every member in it — which is
 * the point of a group, and why this is not the same as auto-sizing each beam.
 *
 * Resolves everything before applying anything. A partial failure then leaves the model
 * untouched for the groups that failed instead of half-applying a sweep, and the caller
 * gets one state update rather than one per group.
 *
 * `floors` are the "use this bar size or larger" minimums the size dialog collects; they
 * narrow the ladder Suggest searches. Undefined means no floor, which is the
 * unconstrained search and the app's default.
 *
 * @returns { rebarByGroup: Map, note: string } — the note is the app's own wording.
 */
export function suggestAllGroups(groups, members, code, barFamily, floors, targetDCR = NEAR_CAPACITY) {
  const byId = new Map(members.map(m => [m.id, m]))
  const rebarByGroup = new Map()
  // Per-GROUP, not one `firstError` for the sweep. A single message named whichever
  // group failed first, so someone looking at "L2 Spandrels" was told about a beam in
  // "Study beams" — a different group, a different section, and no way to tell whether
  // their own group had even been attempted. Keyed by id so the caller can put each
  // reason on the group it belongs to.
  const errorByGroup = new Map()
  let ok = 0, torsionGoverned = 0
  // The worst torsion the accepted cages leave behind. Suggest sizes links for torsion
  // (φT_n climbs on A_b/s per leg, which is a different ladder from shear's legs·A_b/s),
  // and this is the number that says so — without it "Suggested 7/11" is silent about
  // the check the user asked the question about.
  let worstTorsAfter = 0

  for (const g of groups) {
    const inGroup = g.memberIds.map(id => byId.get(id)).filter(Boolean)
    // Skip empty groups silently — they are not a failure, there is just nothing to size.
    if (!inGroup.some(m => m.memberType === 'beam' && m.loads.length > 0)) continue
    const r = suggestGroupRebar(inGroup, code, targetDCR, floors, barFamily)
    if (isSuggestError(r)) {
      errorByGroup.set(g.id, { label: g.label, kind: r.kind, at: r.at, error: r.error })
      continue
    }
    ok++
    rebarByGroup.set(g.id, r.rebar)

    // Suggest now sizes the links on torsion as well as shear — they climb different
    // ladders out of the same catalogue (φV_s ∝ legs·A_b/s, φT_n ∝ A_b/s alone), so the
    // cheapest shear answer used to buy capacity with legs and leave torsion untouched.
    // A group it cannot satisfy comes back as an ERROR now rather than a quietly
    // torsion-governed cage, so this counter should stay at zero; it is kept as a
    // tripwire: a suggested cage silently worse than the one it replaced is the one
    // outcome worth naming, so count those and say so.
    const after = inGroup.map(m => designMemberAllRows({ ...m, rebar: r.rebar }, code))
    const worst = after.reduce((a, d) => (d.dcr > a.dcr ? d : a), after[0])
    for (const d of after) {
      worstTorsAfter = Math.max(worstTorsAfter, d.checks.find(c => c.key === 'torsion').dcr)
    }
    if (worst && worst.governing && worst.governing.key === 'torsion' && worst.dcr > targetDCR + 1e-9) {
      torsionGoverned++
    }
  }

  const fail = errorByGroup.size
  const total = ok + fail
  // Two kinds of failure, and they call for different things from the reader. A SECTION
  // limit (ACI §22.7.7.1 / EC2 §6.3.2) caps the diagonal compression in the concrete: no
  // cage satisfies it, so the answer is a bigger beam and saying "unresolved" invites
  // someone to go looking for reinforcement that does not exist. Anything else is a cage
  // the search could not find, which IS worth another look.
  const sectionLimited = [...errorByGroup.values()].filter(e => e.kind === 'section-limit')
  const other = [...errorByGroup.values()].filter(e => e.kind !== 'section-limit')
  const names = list => list.map(e => e.label).join(', ')

  let note
  if (total === 0) {
    note = 'No groups with designed beams to suggest.'
  } else {
    note = `Suggested ${ok}/${total} groups`
    // Say what happened to TORSION, because that is the check the links were sized
    // against and the one a reader cannot infer from "7/11".
    if (ok > 0) note += ` · torsion ≤ ${worstTorsAfter.toFixed(2)} on every cage applied`
    if (sectionLimited.length) {
      note += ` · ${sectionLimited.length} need a BIGGER SECTION (${names(sectionLimited)})`
        + ' — combined shear + torsion is over the cross-section limit there, so no'
        + ' arrangement of links or bars will do it'
    }
    if (other.length) note += ` · ${other.length} unresolved (${names(other)}) — ${other[0].error}`
  }
  if (torsionGoverned > 0) {
    note += ` · ${torsionGoverned} still governed by torsion`
  }
  return { rebarByGroup, errorByGroup, note }
}
