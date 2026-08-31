import { runDesign } from '../engines/index.ts'
import { generateBreakdown } from '../utils/calcBreakdown.ts'
import { generateBreakdownEC2 } from '../utils/calcBreakdownEC2.ts'
import { zoneShearDemands } from '../utils/concreteDesign.ts'
import { capacityLabels } from '../utils/units.ts'
import { continuousCage } from '../utils/curtailment.ts'
import { resolveCrack } from '../utils/resolveCrack.ts'
import { suggestGroupRebar, isSuggestError } from '../utils/suggestRebar.ts'
import { beamAxialFlexure } from '../utils/axialFlexure.ts'
import { biaxialCheck } from '../utils/biaxial.ts'
import { computeFlexure, getBarArea } from '../utils/concreteDesign.ts'

// The demo's one connection to the real app: it calls runDesign and generateBreakdown
// and does nothing else with the numbers. No re-derivation, no rounding, no fallback —
// if a DCR here disagrees with the app, the demo is not the thing that is wrong.

/** The checks a beam has, in the order the chips read. Torsion and crack width are
 *  per-code: EC2 adds an SLS crack check that ACI has no equivalent for. */
export function checksFor(code, ignoreTorsion) {
  const base = [
    { key: 'flex', label: 'Flexure', of: r => Math.max(r.DCR_flex_pos, r.DCR_flex_neg) },
    { key: 'shear', label: 'Shear', of: r => r.DCR_shear },
    // With "neglect torsion" on, the check is OMITTED rather than shown reading 0.00.
    // Tu has been dropped to zero so the check is not being made, and a chip that always
    // reads zero is a control that teaches people to ignore the row it sits in. Same
    // rule the member panel follows.
    ...(ignoreTorsion ? [] : [{ key: 'torsion', label: 'Torsion', of: r => r.DCR_torsion }]),
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
export function designMemberAllRows(member, code, prefs = {}) {
  const span = member.span ?? 20
  // PROJECT DESIGN PREFERENCES, not optional decoration. `runDesign` takes these
  // POSITIONALLY (…, crack, cotTheta, ignoreTorsion, biaxialAlpha), so a call that stops
  // short of them designs under different rules than the project asked for — silently,
  // with no type error. That is exactly how "neglect torsion" came to be honoured in the
  // member panel, the dashboard and the .SCO writers but NOT in this shell, which is the
  // UI most of the work actually happens in.
  // Crack params come from the app's own resolver, not raw off the member: under EC2 it
  // substitutes the quasi-permanent moments from the project's SLS combo, and without it
  // the panel falls back to `qpFactor × Mu` — a different crack demand from the one the
  // member screen and the .SCO writers use for the same beam.
  const crack = prefs.crack ?? resolveCrack(member, code, prefs.slsCombo)
  const rows = member.loads.map(load => ({
    load,
    result: runDesign(
      member.section, member.material, member.rebar, load, span, code,
      crack, prefs.cotTheta, prefs.ignoreTorsion, prefs.biaxialAlpha,
    ),
  }))

  // The biaxial check joins the list only for a member that actually has a minor-axis
  // moment. Appending it unconditionally would put a chip reading 0.00 on 174 of 175
  // members — a dead control that teaches people to ignore the row it sits in.
  const hasBiaxial = rows.some(r => r.result.NM_util !== undefined)
  const checkDefs = hasBiaxial
    ? [...checksFor(code, prefs.ignoreTorsion), { key: 'biaxial', label: 'Biaxial', of: r => r.NM_util ?? 0 }]
    : checksFor(code, prefs.ignoreTorsion)

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
  //
  // COLLAPSE ON THE CLAUSE AND THE SHAPE OF THE SENTENCE, NOT ON THE SENTENCE.
  // Nearly every message embeds the row's own numbers -- "Shear NG: DCR = 1.23",
  // "Vu 45.2 kips", "at fs = 31 ksi" -- so keying on the literal text deduplicates
  // nothing: an ETABS member carries one row per station per combo, and a single
  // failing clause came back as 50 separate warnings. Blanking the numbers out of the
  // key merges those back into one entry while still keeping genuinely different
  // messages apart ("Top steel ..." stays distinct from "Bottom steel ...").
  const shape = msg => msg.replace(/-?\d[\d,.]*/g, '#')
  const rowDcrOf = r => Math.max(
    r.DCR_flex_pos || 0, r.DCR_flex_neg || 0, r.DCR_shear || 0,
    r.DCR_torsion || 0, r.DCR_crack || 0, r.VT_util || 0,
  )
  const seen = new Map()
  for (const { load, result } of rows) {
    const rowDcr = rowDcrOf(result)
    for (const w of result.warnings || []) {
      const key = w.code + '|' + shape(w.message)
      const rec = seen.get(key)
      if (!rec) { seen.set(key, { ...w, count: 1, first: load, worstDcr: rowDcr }); continue }
      rec.count++
      // An error anywhere outranks a warning everywhere -- the collapsed entry must
      // not present the mildest version of a clause that failed hard on some row.
      if (w.severity === 'error') rec.severity = 'error'
      // Show the WORST row's wording. Keeping the first row's would print "DCR = 1.02"
      // on a member whose worst station reads 1.45.
      if (rowDcr > rec.worstDcr) { rec.message = w.message; rec.worstDcr = rowDcr; rec.first = load }
    }
  }

  // `prefs` travels ON the design, so anything derived from it later (the Calc Sheet,
  // the charts) is built under the SAME rules as the DCRs — rather than each consumer
  // having to remember to thread the project settings through a second time.
  return { member, code, span, rows, checks, governing, dcr: governing ? governing.dcr : 0, warnings: [...seen.values()], prefs }
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
  const { member, span, code, prefs = {} } = design
  const zoneVu = member.stationForces ? zoneShearDemands(member.stationForces, span) : undefined
  // The sheet is a DERIVATION of what the engine computed, so it has to see the same
  // load the engine saw. `runDesign` zeroes Tu itself when the project neglects torsion;
  // the breakdown generators are called directly and do not, so the row is zeroed here
  // instead — otherwise the Calc Sheet prints a torsion section, with a demand and a
  // utilisation, for a project whose panels show no torsion check at all.
  const row = prefs.ignoreTorsion && load.Tu ? { ...load, Tu: 0 } : load
  // The two generators do not take the same tail: only the ACI one reads per-third
  // shear demands, and the EC2 one wants the SLS combo name and cotθ instead.
  return code === 'EN1992-1-1'
    ? generateBreakdownEC2(member.section, member.material, member.rebar, row, span,
        resolveCrack(member, code, prefs.slsCombo) ?? member.crackParams,
        prefs.slsCombo ?? row.id, prefs.cotTheta ?? 2.5)
    : generateBreakdown(member.section, member.material, member.rebar, row, span, zoneVu)
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
export function stationEnvelope(stationForces, type, combo) {
  const src = stationForces || []
  // ONE COMBO: its own stations, in order, untouched. This is a real bending moment
  // diagram — the shape that combination actually produces, hogging over the supports
  // and sagging at midspan, with the inflection points where they really are.
  //
  // The envelope below cannot be that and never could. At a station where one combo
  // gives +M and another −M it keeps whichever is bigger in magnitude, so the curve it
  // draws hops between combos from station to station: every point on it is real, and
  // the line joining them is a load case that does not exist. That is the right picture
  // for "how much does this member have to take anywhere" and the wrong one for reading
  // a diagram, which is why the combo is now selectable.
  if (combo) {
    const cf = src.find(c => c.combo === combo)
    if (!cf) return []
    return [...cf.stations]
      .sort((a, b) => a.x - b.x)
      .map(st => ({ x: st.x, v: type === 'M' ? st.M : st.V }))
  }

  const byX = new Map()
  for (const cf of src) {
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
 * Every combo name in the model, in the order ETABS gave them.
 *
 * A union across members rather than a read of the first one: members imported from
 * different load patterns do not all carry the same combos, and a list taken off
 * `members[0]` would silently hide the combos that only exist elsewhere in the model.
 */
export function comboNames(members) {
  const seen = new Set()
  const out = []
  for (const m of members || []) {
    for (const cf of m.stationForces || []) {
      if (cf.combo && !seen.has(cf.combo)) { seen.add(cf.combo); out.push(cf.combo) }
    }
  }
  return out
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
    // The governing row supplies the CAPACITIES and the status; the warnings come from
    // `d.warnings`, the deduplicated union across EVERY row.
    //
    // A member has many load rows and several checks only run on some of them — §24.3.2
    // crack spacing is gated on a sagging row, §22.7.x on Tu clearing its threshold. So
    // reading the warning list off one row hides whatever the other rows raised, and the
    // dashboard's chips then disagree with a Calc Sheet opened on a different row: the
    // chips would be missing a clause the sheet is showing. `designMemberAllRows` has
    // always computed the union (with a per-warning `count`); it was simply thrown away
    // here in favour of one row's list.
    resultById[id] = { ...d.governing.row.result, warnings: d.warnings }
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
/**
 * The sweep's state machine, shared by the synchronous {@link suggestAllGroups} and the
 * chunked {@link suggestAllGroupsChunked}.
 *
 * Extracted so there is exactly ONE copy of the per-group logic and of the note the
 * caller prints. Two copies of this drifted the moment the torsion counter was added to
 * one of them, which is the whole argument against writing a second driver instead.
 */
function createSweep(members, code, barFamily, floors, targetDCR, prefs) {
  const byId = new Map(members.map(m => [m.id, m]))
  const rebarByGroup = new Map()
  // Per-GROUP, not one `firstError` for the sweep. A single message named whichever
  // group failed first, so someone looking at "L2 Spandrels" was told about a beam in
  // "Study beams" — a different group, a different section, and no way to tell whether
  // their own group had even been attempted. Keyed by id so the caller can put each
  // reason on the group it belongs to.
  const errorByGroup = new Map()
  /** Clause -> how many suggested cages still carry it. */
  const residualCodes = new Map()
  let ok = 0, torsionGoverned = 0
  // Resolved, but only by going past ρmax. Counted apart from `ok` because a sweep that
  // applies these and reports "12/12 suggested" has told the engineer nothing about the
  // one thing that makes them different — see `overReinforced` in utils/suggestRebar.ts.
  let overRein = 0
  // Returned the section's CEILING and it is still short of the target — a different
  // statement from over-reinforced, and the one that means "no cage will do it".
  let below = 0
  // Over a CROSS-SECTION limit — the concrete, not the cage. Named apart because it is
  // the only outcome no amount of reinforcement can change.
  let sectionOver = 0
  // The worst torsion the accepted cages leave behind. Suggest sizes links for torsion
  // (φT_n climbs on A_b/s per leg, which is a different ladder from shear's legs·A_b/s),
  // and this is the number that says so — without it "Suggested 7/11" is silent about
  // the check the user asked the question about.
  let worstTorsAfter = 0

  return {
    /** Size ONE group. Returns true when a cage was applied, false when it was skipped
     *  or failed — the caller uses it only for progress wording. */
    step(g) {
      const inGroup = g.memberIds.map(id => byId.get(id)).filter(Boolean)
      // Skip empty groups silently — they are not a failure, there is just nothing to size.
      if (!inGroup.some(m => m.memberType === 'beam' && m.loads.length > 0)) return false
      // PREFS ALL THE WAY DOWN. `suggestGroupRebar` hands cotTheta and ignoreTorsion
      // straight to `runDesign`, so a call that stops at `barFamily` sizes the cage
      // against DIFFERENT checks from the ones the member panel will run — silently,
      // because both arguments are optional and JS does not complain.
      //
      // Under EC2 that is not a rounding difference. V_Rd,s = (A_sw/s)·z·f_ywd·cot θ is
      // LINEAR in cot θ, and the engine's default is 2.5 (the code maximum). A project
      // set to the S-CONCRETE angle of 1.25 therefore got links sized for exactly twice
      // the shear capacity it actually has: Suggest reported 0.84 and the panel opened
      // at 1.69. At cot θ = 1.0 it reached 2.11. ACI hid it — V_s = A_v·f_yt·d/s has no
      // strut-angle term, so the omission cost nothing there and nothing caught it.
      const r = suggestGroupRebar(inGroup, code, targetDCR, floors, barFamily,
        prefs.cotTheta, prefs.ignoreTorsion, prefs.slsCombo)
      if (isSuggestError(r)) {
        errorByGroup.set(g.id, { label: g.label, kind: r.kind, at: r.at, error: r.error })
        return false
      }
      ok++
      if (r.overReinforced) overRein++
      // One counter for "the cage came back but does not meet the target", whatever the
      // check. Which check it was is on the group's own DCR chips a click away; what the
      // sweep line has to say is that these are not clean passes.
      // Mutually exclusive on purpose: a section-limited group is short too, and
      // counting it twice makes one problem read as two in the summary line. The
      // section limit is the stronger statement — no cage answers it — so it wins.
      if (r.sectionLimit) sectionOver++
      else if (r.belowTarget || r.shearBelowTarget) below++
      // What the engine STILL says about the cage being applied. The search resolves the
      // things a cage can resolve -- strength, link spacing and legs, bar fit across the
      // web, the gap between layers, skin steel -- so anything here is something no cage
      // fixes, and it should reach the reader now rather than on the member panel after
      // the cage has been applied.
      for (const w of r.residualWarnings || []) {
        residualCodes.set(w.code, (residualCodes.get(w.code) || 0) + 1)
      }
      rebarByGroup.set(g.id, r.rebar)

      // Suggest now sizes the links on torsion as well as shear — they climb different
      // ladders out of the same catalogue (φV_s ∝ legs·A_b/s, φT_n ∝ A_b/s alone), so the
      // cheapest shear answer used to buy capacity with legs and leave torsion untouched.
      // A group it cannot satisfy comes back as an ERROR now rather than a quietly
      // torsion-governed cage, so this counter should stay at zero; it is kept as a
      // tripwire: a suggested cage silently worse than the one it replaced is the one
      // outcome worth naming, so count those and say so.
      const after = inGroup.map(m => designMemberAllRows({ ...m, rebar: r.rebar }, code, prefs))
      const worst = after.reduce((a, d) => (d.dcr > a.dcr ? d : a), after[0])
      for (const d of after) {
        // The torsion check is absent entirely when the project neglects torsion.
        const t = d.checks.find(c => c.key === 'torsion')
        if (t) worstTorsAfter = Math.max(worstTorsAfter, t.dcr)
      }
      if (worst && worst.governing && worst.governing.key === 'torsion' && worst.dcr > targetDCR + 1e-9) {
        torsionGoverned++
      }
      return true
    },
    finish() {
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
    // Loudest item in the sentence, because it is the only one that says a cage which
    // LOOKS resolved is not code-compliant.
    if (below > 0) {
      note += ` · ⚠ ${below} STILL SHORT at the section's largest cage — no arrangement`
        + ' of bars will do it, the section has to grow'
    }
    if (sectionOver > 0) {
      note += ` · ⚠ ${sectionOver} over the CROSS-SECTION limit (shear+torsion crushing)`
        + ' — the concrete governs, not the cage'
    }
    if (overRein > 0) {
      note += ` · ⚠ ${overRein} EXCEED ρmax (over-reinforced — carries the moment but`
        + ' fails ductility; enlarge the section)'
    }
    // Everything else the applied cages still carry, named by clause. Sorted by how many
    // cages carry each, and capped at three so the sentence stays a sentence.
    const residualTop = [...residualCodes.entries()].sort((a, b) => b[1] - a[1])
    if (residualTop.length) {
      note += ` · detailing left: ${residualTop.slice(0, 3).map(([c, n]) => `${c}×${n}`).join(', ')}`
        + (residualTop.length > 3 ? ` +${residualTop.length - 3} more` : '')
    }

    /**
     * The same outcome as `note`, counted instead of written.
     *
     * `note` is a sentence for the status bar and it names the groups that failed, which
     * makes it useless for two things at once: it truncates (a sweep with ten failures
     * spends its whole length listing them, and the REASON falls off the end), and the
     * names are the user's own labels, which must not leave the machine. Counting by
     * `kind` fixes both — "7 flexure-ladder, 3 crack-limit" is both shorter and more
     * actionable than ten labels, and it carries nothing private.
     *
     * `reasons` is keyed by SuggestError.kind (see utils/suggestRebar.ts).
     */
    const reasons = {}
    for (const e of errorByGroup.values()) {
      const k = e.kind || 'unclassified'
      reasons[k] = (reasons[k] || 0) + 1
    }
    const stats = {
      attempted: total,
      resolved: ok,
      overReinforced: overRein,
      belowTarget: below,
      sectionLimited: sectionOver,
      failed: fail,
      reasons,
      // Rounded: the log wants the magnitude, not 14 decimal places of it.
      worstTorsionAfter: Math.round(worstTorsAfter * 100) / 100,
      torsionGoverned,
      /** Clause -> number of applied cages that still carry it. Empty on a clean sweep. */
      residual: Object.fromEntries(residualCodes),
    }
      return { rebarByGroup, errorByGroup, note, stats }
    },
  }
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
export function suggestAllGroups(groups, members, code, barFamily, floors, targetDCR = NEAR_CAPACITY, prefs = {}) {
  const sweep = createSweep(members, code, barFamily, floors, targetDCR, prefs)
  for (const g of groups) sweep.step(g)
  return sweep.finish()
}

/**
 * The same sweep, one group per turn of the event loop.
 *
 * Identical arithmetic to {@link suggestAllGroups} — same `createSweep`, same order —
 * but it hands the thread back between groups, which buys two things the synchronous
 * version cannot have: the status bar repaints as it goes, and the sweep can be PAUSED
 * at a group boundary. Pausing between groups rather than inside one is what makes it
 * safe: nothing is applied to the model until `finish()`, so a sweep held at group 7 of
 * 24 has changed nothing at all.
 *
 * `hooks.gate` is awaited between groups (see utils/activity.ts) and `hooks.onProgress`
 * is called with (doneCount, total, groupLabel) before each one.
 */
export async function suggestAllGroupsChunked(
  groups, members, code, barFamily, floors, targetDCR = NEAR_CAPACITY, prefs = {}, hooks = {},
) {
  const sweep = createSweep(members, code, barFamily, floors, targetDCR, prefs)
  const total = groups.length
  for (let i = 0; i < total; i++) {
    const g = groups[i]
    hooks.onProgress?.(i, total, g.label)
    if (hooks.gate) await hooks.gate()
    sweep.step(g)
  }
  hooks.onProgress?.(total, total, null)
  return sweep.finish()
}

/**
 * A cheap structural fingerprint of a model — what tells one revision from the next.
 *
 * Used to decide whether the working model has actually diverged from the newest pushed
 * one. Straight after a push it has not: the push freezes what you have, so listing both
 * would show the same model twice under different names.
 *
 * Reads the three things a revision changes — the SECTIONS, the CAGES and the DEMAND —
 * and deliberately not everything else. It only decides whether to show a row in a
 * picker; a false "changed" costs a redundant entry, never a wrong number.
 *
 * The demand is summed rather than counted. A re-import after a re-analysis keeps the
 * number of load rows exactly the same and changes every value in them, so a count would
 * call the redesigned model unchanged — which is the one case this exists to catch.
 */
export function modelSignatureOf(members) {
  const bars = g => (g ?? []).map(b => `${b.numBars}x${b.barSize}`).join('.')
  return (members ?? []).map(m => {
    const sec = m.section ?? {}
    const t = m.rebar?.ties
    return [
      m.id, sec.b, sec.h, sec.bw ?? '',
      bars(m.rebar?.topBars), bars(m.rebar?.botBars),
      t ? `${t.barSize}/${t.spacing}/${t.legs}` : '',
      m.loads?.length ?? 0,
      (m.loads ?? []).reduce((a, l) =>
        a + Math.abs(l.Mu_pos ?? 0) + Math.abs(l.Mu_neg ?? 0) + Math.abs(l.Vu ?? 0), 0).toFixed(1),
    ].join('|')
  }).join(';')
}
