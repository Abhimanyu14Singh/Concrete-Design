import { describe, it, expect } from 'vitest';
import { suggestGroupRebar, isSuggestError } from '../suggestRebar';
import { isSkinWarning } from '../skinReinforcement';
import { runDesign } from '../../engines';
import { getBarArea } from '../concreteDesign';
import { DEFAULT_CRACK_PARAMS } from '../../types';
import type { Member } from '../../types';

function makeBeam(opts: {
  id: string; b?: number; h?: number;
  MuPos?: number; MuNeg?: number; Vu?: number;
  loads?: Member['loads'];
}): Member {
  return {
    id: opts.id,
    label: opts.id,
    memberType: 'beam',
    material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1 },
    section: { type: 'rectangular_beam', b: opts.b ?? 14, h: opts.h ?? 24, coverClear: 1.5, stirrupDia: 4 },
    rebar: {
      topBars: [{ numBars: 2, barSize: 5 }],
      botBars: [{ numBars: 2, barSize: 5 }],
      ties: { barSize: 4, spacing: 6, legs: 2 },
    },
    loads: opts.loads ?? [{
      id: 'lc1', label: 'Env',
      Mu_pos: opts.MuPos ?? 150, Mu_neg: opts.MuNeg ?? 120, Vu: opts.Vu ?? 45, Tu: 0, Pu: 0,
    }],
    span: 20,
  };
}

function totalAs(bars: { numBars: number; barSize: number }[]): number {
  return bars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
}

describe('suggestGroupRebar', () => {
  it('suggests a layout meeting target DCR for a typical beam', () => {
    const m = makeBeam({ id: 'b1' });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.worstDCRFlex).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(r.worstDCRShear).toBeLessThanOrEqual(0.9 + 1e-6);
    // Independent verification with runDesign
    const check = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'ACI318-19');
    expect(Math.max(check.DCR_flex_pos, check.DCR_flex_neg)).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(check.DCR_shear).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(r.steelLb).toBeGreaterThan(0);
    expect(r.governingMemberId).toBe('b1');
  });

  it('adds code-based skin bars to a deep beam (ACI §9.7.2.3, h > 36 in)', () => {
    const m = makeBeam({ id: 'deep', h: 40, MuPos: 260, MuNeg: 220, Vu: 55 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.rebar.sideBars).toBeDefined();
    expect(r.rebar.sideBars![0].numBars).toBeGreaterThanOrEqual(1); // per face
  });

  // Links are picked off a steel-RATE ladder (legs·Ab/s), and a wide spacing with a
  // fat bar carries the same rate as a close spacing with a thin one — so the lightest
  // passing rung was routinely illegal on spacing while passing DCR_shear. Every case
  // below came back flagged before the spacing cap was added.
  describe('stirrup spacing obeys the detailing limits, not just DCR_shear', () => {
    /** Every ACI §9.7.6.x spacing complaint the cage draws, across all its rows. */
    const spacingWarnings = (m: Member, rebar: Member['rebar']) =>
      m.loads.flatMap(lc => runDesign(m.section, m.material, rebar, lc, m.span, 'ACI318-19').warnings)
        .filter(w => w.code.startsWith('ACI §9.7.6'));

    it('§9.7.6.2.2 s ≤ d/2 on an ordinary beam (was #4@12 on a d/2 of 10.75 in)', () => {
      const m = makeBeam({ id: 'typ' });              // 14×24, d ≈ 21.5 ⇒ s_max = 10.75
      const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
      expect(isSuggestError(r)).toBe(false);
      if (isSuggestError(r)) return;
      expect(r.rebar.ties!.spacing).toBeLessThanOrEqual(10.75);
      expect(spacingWarnings(m, r.rebar)).toEqual([]);
    });

    it('§9.7.6.2.2 heavy-shear s ≤ d/4, which is an ERROR not a warning (was #6@8)', () => {
      const m = makeBeam({ id: 'heavy', MuPos: 200, MuNeg: 170, Vu: 120 });
      const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
      expect(isSuggestError(r)).toBe(false);
      if (isSuggestError(r)) return;
      expect(r.rebar.ties!.spacing).toBeLessThanOrEqual(21.5 / 4);
      expect(spacingWarnings(m, r.rebar)).toEqual([]);
    });

    it('§9.7.6.3.3 torsion s ≤ Ph/8 on a spandrel (was #4@10)', () => {
      const m = makeBeam({ id: 'spandrel', MuPos: 150, MuNeg: 130,
        loads: [{ id: 'lc1', label: 'Env', Mu_pos: 150, Mu_neg: 130, Vu: 60, Tu: 40, Pu: 0 }] });
      const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
      expect(isSuggestError(r)).toBe(false);
      if (isSuggestError(r)) return;
      expect(spacingWarnings(m, r.rebar)).toEqual([]);
    });

    it('holds the relaxed MIDDLE third to s_max too — that zone is what the code judges', () => {
      // Station rows, so the middle-third relaxation is actually reachable (it needs a
      // demand located in that zone to prove itself against).
      const m = makeBeam({ id: 'zoned', loads: [
        { id: 'r0', label: 'end',  Mu_pos: 0,   Mu_neg: 150, Vu: 55, Tu: 0, Pu: 0, x: 0 },
        { id: 'r1', label: 'mid',  Mu_pos: 130, Mu_neg: 0,   Vu: 12, Tu: 0, Pu: 0, x: 10 },
        { id: 'r2', label: 'end2', Mu_pos: 0,   Mu_neg: 150, Vu: 55, Tu: 0, Pu: 0, x: 20 },
      ] });
      const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
      expect(isSuggestError(r)).toBe(false);
      if (isSuggestError(r)) return;
      const loosest = Math.max(...(r.rebar.tieZones ?? []).map(z => z.spacing), r.rebar.ties!.spacing);
      expect(loosest).toBeLessThanOrEqual(10.75);
      expect(spacingWarnings(m, r.rebar)).toEqual([]);
    });

    it('shallow section: the cap follows d, not a fixed number (12×16, was #4@8)', () => {
      const m = makeBeam({ id: 'shallow', b: 12, h: 16, MuPos: 60, MuNeg: 50, Vu: 40 });
      const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
      expect(isSuggestError(r)).toBe(false);
      if (isSuggestError(r)) return;
      expect(spacingWarnings(m, r.rebar)).toEqual([]);
    });
  });

  // φVs ∝ legs·A_b/s but φT_n = φ·2A_o·(A_b/s)·f_yt — flat in leg count. The
  // rate-ordered shear search buys capacity with legs, which leaves torsion exactly
  // where it was, so a spandrel came back with every other check on target and
  // DCR_T > 1. Torsion needs its own ladder: the per-leg rate.
  describe('torsion is designed for, on the lever that actually moves it', () => {
    const spandrel = (o: { b: number; h: number; Vu: number; Tu: number }): Member => ({
      ...makeBeam({ id: `sp-${o.b}x${o.h}`, b: o.b, h: o.h, MuPos: 120, MuNeg: 200 }),
      loads: [{ id: 'lc', label: 'Env', Mu_pos: 120, Mu_neg: 200, Vu: o.Vu, Tu: o.Tu, Pu: 0 }],
      span: 26,
    });
    const torsionDCR = (m: Member, rebar: Member['rebar']) =>
      Math.max(...m.loads.map(lc => runDesign(m.section, m.material, rebar, lc, m.span, 'ACI318-19').DCR_torsion));

    it('brings DCR_torsion under target on a section that can carry it (was 1.37)', () => {
      const m = spandrel({ b: 18, h: 32, Vu: 60, Tu: 60 });
      const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
      expect(isSuggestError(r)).toBe(false);
      if (isSuggestError(r)) return;
      expect(torsionDCR(m, r.rebar)).toBeLessThanOrEqual(0.9 + 1e-6);
    });

    it('spends on A_t/s (bar size ÷ spacing), not on extra legs', () => {
      const m = spandrel({ b: 18, h: 32, Vu: 60, Tu: 60 });
      const withT = suggestGroupRebar([m], 'ACI318-19', 0.9);
      // Same search with the project's "neglect torsion" setting on: the shear-only
      // answer, which is what the whole ladder used to return.
      const withoutT = suggestGroupRebar([m], 'ACI318-19', 0.9, undefined, undefined, undefined, true);
      if (isSuggestError(withT) || isSuggestError(withoutT)) throw new Error('expected both to resolve');
      const perLeg = (r: typeof withT) =>
        isSuggestError(r) ? 0 : getBarArea(r.rebar.ties!.barSize) / r.rebar.ties!.spacing;
      expect(perLeg(withT)).toBeGreaterThan(perLeg(withoutT));
      // The shear-only cage is genuinely NG on torsion — this is the bug, pinned.
      expect(torsionDCR(m, withoutT.rebar)).toBeGreaterThan(1);
    });

    it('honours "neglect torsion" — no links are bought for a torsion the project drops', () => {
      const m = spandrel({ b: 18, h: 32, Vu: 60, Tu: 60 });
      const ignored = suggestGroupRebar([m], 'ACI318-19', 0.9, undefined, undefined, undefined, true);
      const zeroTu = suggestGroupRebar([spandrel({ b: 18, h: 32, Vu: 60, Tu: 0 })], 'ACI318-19', 0.9);
      if (isSuggestError(ignored) || isSuggestError(zeroTu)) throw new Error('expected both to resolve');
      expect(ignored.rebar.ties).toEqual(zeroTu.rebar.ties);
    });

    it('names the section (and the member) when links cannot fix it — §22.7.7.1', () => {
      // 12×26 carrying V 47 / T 47: √(v_u²+v_t²) is past φ(V_c/b_w d + 8λ√f'c), so no
      // cage is a design. Refusing beats handing back one that opens NG.
      const m = { ...spandrel({ b: 12, h: 26, Vu: 47, Tu: 47 }), label: 'L2-B7' };
      const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
      expect(isSuggestError(r)).toBe(true);
      if (!isSuggestError(r)) return;
      expect(r.error).toMatch(/L2-B7/);
      expect(r.error).toMatch(/Cross-section inadequate/);
      expect(r.error).toMatch(/ENLARGE THE SECTION/);
    });
  });

  it('adds no skin bars to a shallow beam (h ≤ 36 in)', () => {
    const r = suggestGroupRebar([makeBeam({ id: 'shallow', h: 24 })], 'ACI318-19', 0.9);
    if (isSuggestError(r)) return;
    expect(r.rebar.sideBars).toBeUndefined();
  });

  // The point of suggesting skin at all: a deep beam must come back with a face
  // reinforcement the engineer can PROCEED with — i.e. one the engine accepts.
  it('leaves no skin warning standing on the cage it suggests (ACI, h = 42 in)', () => {
    const m = makeBeam({ id: 'deep42', h: 42, MuPos: 300, MuNeg: 250, Vu: 60 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    const check = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'ACI318-19');
    expect(check.warnings.filter(isSkinWarning)).toEqual([]);
  });

  // DEPTH triggers the rule, demand doesn't — so sizing the skin on the moment-
  // governing member (as this used to) misses the deep one entirely.
  it('sizes skin on the DEEPEST member of a mixed group, not the governing one', () => {
    const shallowHeavy = makeBeam({ id: 'gov', h: 30, MuPos: 400, MuNeg: 340, Vu: 80 });
    const deepLight    = makeBeam({ id: 'deep', h: 44, MuPos: 90,  MuNeg: 70,  Vu: 25 });
    const r = suggestGroupRebar([shallowHeavy, deepLight], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.governingMemberId).toBe('gov');          // still the moment governor
    expect(r.rebar.sideBars).toBeDefined();           // but the deep member is served
    const check = runDesign(deepLight.section, deepLight.material, r.rebar,
      deepLight.loads[0], deepLight.span, 'ACI318-19');
    expect(check.warnings.filter(isSkinWarning)).toEqual([]);
  });

  // EC2 As,min is inversely proportional to σs, and Table 7.2N gives a Ø12 bar
  // σs = 280 MPa at wk = 0.3 but 240 at 0.2 — so a tighter project needs ~17 %
  // more face steel. Assuming 0.3 (as the old seed did) left the warning up.
  it('follows the project face crack limit for EC2 skin area (0.2 mm needs more than 0.3)', () => {
    const deepEC2 = (wLimitFace: number): Member => ({
      // 700×1500: big enough that the ~17 % area difference is a whole extra Ø12
      // per face (A_s,min 1316 → 1535 mm², i.e. 6 → 7) rather than one the ceiling
      // absorbs — at 500 wide both round to 5 and the test would prove nothing.
      ...makeBeam({ id: `ec2-${wLimitFace}`, b: 700 / 25.4, h: 1500 / 25.4, MuPos: 300, MuNeg: 260, Vu: 70 }),
      material: { fc: 40 / 0.00689476, fy: 500 / 0.00689476, fyt: 500 / 0.00689476, Es: 29000000, lambdaConcrete: 1 },
      crackParams: { ...DEFAULT_CRACK_PARAMS, wLimitFace },
    });
    const loose = suggestGroupRebar([deepEC2(0.3)], 'EN1992-1-1', 0.9);
    const tight = suggestGroupRebar([deepEC2(0.2)], 'EN1992-1-1', 0.9);
    if (isSuggestError(loose) || isSuggestError(tight)) throw new Error('expected both to resolve');
    const asPerFace = (r: typeof loose) =>
      isSuggestError(r) ? 0 : totalAs(r.rebar.sideBars ?? []);
    expect(asPerFace(tight)).toBeGreaterThan(asPerFace(loose));
    // …and both are actually accepted by the engine that raised the warning.
    for (const [r, m] of [[loose, deepEC2(0.3)], [tight, deepEC2(0.2)]] as const) {
      if (isSuggestError(r)) continue;
      const check = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'EN1992-1-1', m.crackParams);
      expect(check.warnings.filter(isSkinWarning)).toEqual([]);
    }
  });

  it('stacks extra bar layers for very high demand instead of erroring', () => {
    // A narrow, deep beam with a large sagging moment needs more bottom steel
    // than a single layer can hold; the multi-layer ladder lets it succeed.
    const m = makeBeam({ id: 'tall', b: 14, h: 48, MuPos: 1500, MuNeg: 500, Vu: 110 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.rebar.botBars.length).toBeGreaterThanOrEqual(2);
    expect(r.worstDCRFlex).toBeLessThanOrEqual(0.9 + 1e-6);
  });

  it('only uses practical bar sizes and stirrup spacings', () => {
    const m = makeBeam({ id: 'b1', MuPos: 250, MuNeg: 200, Vu: 60 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    const allBars = [...r.rebar.topBars, ...r.rebar.botBars];
    for (const g of allBars) {
      expect(g.barSize).toBeGreaterThanOrEqual(5);
      expect(g.barSize).toBeLessThanOrEqual(11);
      expect(g.numBars).toBeGreaterThanOrEqual(2);
    }
    // Top and bottom faces must share a single bar size.
    const sizes = new Set(allBars.map(g => g.barSize));
    expect(sizes.size).toBe(1);
    expect([4, 5, 6]).toContain(r.rebar.ties!.barSize);
    expect([4, 6, 8, 10, 12]).toContain(r.rebar.ties!.spacing);
    expect(r.rebar.tieZones).toHaveLength(3);
  });

  it('respects width fit on a narrow beam (max 2 layers, bars fit in 10 in width)', () => {
    const m = makeBeam({ id: 'narrow', b: 10, MuPos: 180, MuNeg: 150, Vu: 40 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    for (const bars of [r.rebar.topBars, r.rebar.botBars]) {
      expect(bars.length).toBeLessThanOrEqual(2);
      for (const g of bars) {
        // 10in − 2(1.5+0.5) = 6in usable; #9 (1.128in) with 1.128 clear → max 3 bars
        expect(g.numBars).toBeLessThanOrEqual(4);
      }
    }
  });

  it('lower target DCR yields at least as much steel', () => {
    const m = makeBeam({ id: 'b1', MuPos: 220, MuNeg: 180, Vu: 55 });
    const tight = suggestGroupRebar([m], 'ACI318-19', 0.75);
    const loose = suggestGroupRebar([m], 'ACI318-19', 0.95);
    expect(isSuggestError(tight)).toBe(false);
    expect(isSuggestError(loose)).toBe(false);
    if (isSuggestError(tight) || isSuggestError(loose)) return;
    expect(totalAs(tight.rebar.botBars)).toBeGreaterThanOrEqual(totalAs(loose.rebar.botBars) - 1e-9);
  });

  it('uses worst demand across the group', () => {
    const light = makeBeam({ id: 'light', MuPos: 60, MuNeg: 40, Vu: 20 });
    const heavy = makeBeam({ id: 'heavy', MuPos: 250, MuNeg: 200, Vu: 60 });
    const r = suggestGroupRebar([light, heavy], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.governingMemberId).toBe('heavy');
    // Verify the heavy member passes at target
    const check = runDesign(heavy.section, heavy.material, r.rebar, heavy.loads[0], heavy.span, 'ACI318-19');
    expect(Math.max(check.DCR_flex_pos, check.DCR_flex_neg, check.DCR_shear)).toBeLessThanOrEqual(0.9 + 1e-6);
  });

  it('returns an error for members without loads', () => {
    const m = makeBeam({ id: 'b1', loads: [] });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(true);
  });

  it('returns an error when demand is impossible for the section', () => {
    const m = makeBeam({ id: 'tiny', b: 10, h: 12, MuPos: 900, MuNeg: 800, Vu: 200 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(true);
  });
});

// Deep, heavily-loaded EC2 beams — the cases the old "linear seed + 5 retries"
// search abandoned with "needs a larger section" even though a buildable cage
// exists (bigger bars, extra layers, heavier/tighter links). The capacity-inversion
// search must now resolve them.
const MPA = 1 / 0.00689476; // MPa → psi
const KNM = 1 / 1.35582;    // kN·m → kip-ft
const KN = 1 / 4.44822;     // kN → kip

function makeEC2Beam(opts: {
  id: string; b: number; h: number; MuNeg: number; MuPos: number; Vu: number;
}): Member {
  return {
    id: opts.id, label: opts.id, memberType: 'beam',
    material: { fc: 40 * MPA, fy: 500 * MPA, fyt: 500 * MPA, Es: 200000 * MPA, lambdaConcrete: 1 },
    section: { type: 'rectangular_beam', b: opts.b / 25.4, h: opts.h / 25.4, coverClear: 40 / 25.4, stirrupDia: -10 },
    rebar: {
      topBars: [{ numBars: 3, barSize: -25 }], botBars: [{ numBars: 3, barSize: -25 }],
      ties: { barSize: -10, spacing: 300 / 25.4, legs: 2 },
    },
    loads: [{ id: 'ULS', label: 'ULS', Mu_neg: opts.MuNeg * KNM, Mu_pos: opts.MuPos * KNM, Vu: opts.Vu * KN, Tu: 0, Pu: 0 }],
    span: 8,
  };
}

describe('suggestGroupRebar — deep EC2 beams the old search abandoned', () => {
  it('resolves a heavily hogging 500×1200 EC2 beam (was "needs larger section")', () => {
    const m = makeEC2Beam({ id: 'G_500x1200', b: 500, h: 1200, MuNeg: 2000, MuPos: 900, Vu: 550 });
    const r = suggestGroupRebar([m], 'EN1992-1-1', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.worstDCRFlex).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(r.worstDCRShear).toBeLessThanOrEqual(0.9 + 1e-6);
    // Independent re-verification with the engine.
    const chk = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'EN1992-1-1');
    expect(Math.max(chk.DCR_flex_pos, chk.DCR_flex_neg, chk.DCR_shear)).toBeLessThanOrEqual(0.9 + 1e-6);
    // It needed the extra bar layers a 2-layer cap could not provide.
    const topBars = r.rebar.topBars.reduce((s, g) => s + g.numBars, 0);
    expect(topBars).toBeGreaterThan(6);
    expect(r.rebar.topBars.length).toBeGreaterThanOrEqual(2);
  });

  it('resolves a shear-heavy 800×1200 EC2 beam with heavier/tighter links', () => {
    const m = makeEC2Beam({ id: 'H_800x1200', b: 800, h: 1200, MuNeg: 1400, MuPos: 800, Vu: 1300 });
    const r = suggestGroupRebar([m], 'EN1992-1-1', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.worstDCRShear).toBeLessThanOrEqual(0.9 + 1e-6);
    const chk = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'EN1992-1-1');
    expect(chk.DCR_shear).toBeLessThanOrEqual(0.9 + 1e-6);
  });

  it('names the strut limit when shear genuinely cannot be met by links', () => {
    // Enormous shear on a slender web → V_Ed > V_Rd,max: no link layout can help.
    const m = makeEC2Beam({ id: 'crush', b: 300, h: 700, MuNeg: 150, MuPos: 150, Vu: 2000 });
    const r = suggestGroupRebar([m], 'EN1992-1-1', 0.9);
    expect(isSuggestError(r)).toBe(true);
    if (!isSuggestError(r)) return;
    expect(r.error).toMatch(/strut|V_Rd,max|widen/i);
  });
});

// The Suggest size-floor dialog passes minimum bar sizes ("use this size or
// larger"). The search must honor them while still returning a valid cage, and
// must be a no-op when no floors are supplied (default suggestion unchanged).
describe('suggestGroupRebar — size floors', () => {
  it('raises both faces to at least the requested longitudinal minimum', () => {
    const m = makeBeam({ id: 'b1' }); // light demand → unfloored search picks small bars
    const floored = suggestGroupRebar([m], 'ACI318-19', 0.9, { minTopBar: 8, minBotBar: 8 });
    expect(isSuggestError(floored)).toBe(false);
    if (isSuggestError(floored)) return;
    for (const g of [...floored.rebar.topBars, ...floored.rebar.botBars]) {
      expect(g.barSize).toBeGreaterThanOrEqual(8);
    }
    // Still a valid cage at target.
    expect(floored.worstDCRFlex).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(floored.worstDCRShear).toBeLessThanOrEqual(0.9 + 1e-6);
  });

  it('uses the LARGER of the two face minimums (top and bottom share one size)', () => {
    const m = makeBeam({ id: 'b1' });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9, { minTopBar: 6, minBotBar: 9 });
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    for (const g of [...r.rebar.topBars, ...r.rebar.botBars]) {
      expect(g.barSize).toBeGreaterThanOrEqual(9);
    }
  });

  it('raises the stirrup size to at least the requested minimum', () => {
    const m = makeBeam({ id: 'b1', MuPos: 250, MuNeg: 200, Vu: 60 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9, { minStirrup: 6 });
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.rebar.ties!.barSize).toBeGreaterThanOrEqual(6);
  });

  it('an empty floors object is a no-op (identical to no floors)', () => {
    const m = makeBeam({ id: 'b1' });
    const a = suggestGroupRebar([m], 'ACI318-19', 0.9);
    const b = suggestGroupRebar([m], 'ACI318-19', 0.9, {});
    expect(isSuggestError(a)).toBe(false);
    expect(isSuggestError(b)).toBe(false);
    if (isSuggestError(a) || isSuggestError(b)) return;
    expect(b.rebar.topBars[0].barSize).toBe(a.rebar.topBars[0].barSize);
    expect(b.rebar.botBars[0].barSize).toBe(a.rebar.botBars[0].barSize);
    expect(b.rebar.ties!.barSize).toBe(a.rebar.ties!.barSize);
  });

  it('honors an EC2 longitudinal floor (Ø or larger)', () => {
    const m = makeEC2Beam({ id: 'ec2', b: 400, h: 700, MuNeg: 300, MuPos: 200, Vu: 250 });
    const r = suggestGroupRebar([m], 'EN1992-1-1', 0.9, { minTopBar: -20, minBotBar: -20 });
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    // EC2 encodes bars as negative Ø; "Ø20 or larger" ⇒ |size| ≥ 20.
    for (const g of [...r.rebar.topBars, ...r.rebar.botBars]) {
      expect(Math.abs(g.barSize)).toBeGreaterThanOrEqual(20);
    }
  });
});
