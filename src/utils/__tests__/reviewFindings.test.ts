/**
 * Regression cover for the xhigh review findings (zoned stirrups + per-face cover).
 *
 * Every case here failed before the fix, so each one pins a specific defect rather
 * than restating current behaviour. Grouped by the thing that was actually broken.
 */
import { describe, it, expect } from 'vitest';
import {
  designMember, computeShear, computeTorsion, steelLimits, requiredAs,
  zoneIndexAtX, worstTieSpacing, tieSpacingAtX, zoneShearDemands, zonedShearCheck,
} from '../concreteDesign';
import { generateBreakdown } from '../calcBreakdown';
import { generateBreakdownEC2 } from '../calcBreakdownEC2';
import { designMemberEC2, sideFaceCrackWidth } from '../../engines/ec2/ec2Beam';
import type { SectionDimensions, MaterialProps, RebarLayout, LoadCase, ComboForces } from '../../types';

const MM = 25.4, PSI = 0.00689476;

const section: SectionDimensions = { type: 'rectangular_beam', b: 18, h: 30, coverClear: 1.5, stirrupDia: 4 };
const material: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1.0 };
const SPAN = 30;

/** Zoned cage; ties.spacing mirrors what the editors write — the TIGHTEST zone. */
const zoned = (zones: number[]): RebarLayout => ({
  topBars: [{ numBars: 3, barSize: 8 }],
  botBars: [{ numBars: 4, barSize: 8 }],
  ties: { barSize: 4, spacing: Math.min(...zones), legs: 2 },
  tieZones: zones.map(s => ({ spacing: s })) as RebarLayout['tieZones'],
});
const row = (o: Partial<LoadCase>): LoadCase =>
  ({ id: 'L', label: 'L', Mu_pos: 0, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0, ...o }) as LoadCase;

describe('zone binning is one shared rule', () => {
  it('a third-point station bins the same from the raw and the rounded x', () => {
    // 40 ft beam, exact third point. The stored 2-dp x used to floor to zone 0
    // while zoneShearDemands floored the raw value to zone 1 — the headline DCR
    // then used a spacing the beam does not have at that section.
    expect(zoneIndexAtX(13.333333, 40)).toBe(zoneIndexAtX(13.33, 40));
    expect(zoneIndexAtX(26.666667, 40)).toBe(zoneIndexAtX(26.67, 40));
  });

  it('clamps ends and survives degenerate spans', () => {
    expect(zoneIndexAtX(0, 30)).toBe(0);
    expect(zoneIndexAtX(30, 30)).toBe(2);
    expect(zoneIndexAtX(999, 30)).toBe(2);
    expect(zoneIndexAtX(5, 0)).toBe(0);
    expect(zoneIndexAtX(NaN, 30)).toBe(0);
  });

  it('zoneShearDemands bins with the same rule', () => {
    const forces: ComboForces[] = [{ combo: 'C', stations: [
      { x: 0, V: 100, M: 0 }, { x: 13.333333, V: 50, M: 0 }, { x: 40, V: 90, M: 0 },
    ] }];
    expect(zoneShearDemands(forces, 40)).toEqual([100, 50, 90]);
  });
});

describe('tie spacing helpers separate capacity from detailing', () => {
  const r = zoned([4, 24, 4]);
  it('worstTieSpacing is the loosest zone, not ties.spacing', () => {
    expect(r.ties!.spacing).toBe(4);      // what the editors store
    expect(worstTieSpacing(r)).toBe(24);  // what detailing must judge
  });
  it('tieSpacingAtX returns the zone the station sits in', () => {
    expect(tieSpacingAtX(r, 1, SPAN)).toBe(4);
    expect(tieSpacingAtX(r, 15, SPAN)).toBe(24);
    expect(tieSpacingAtX(r, 29, SPAN)).toBe(4);
  });
  it('an unlocated row falls back to the WORST zone, never the tightest', () => {
    expect(tieSpacingAtX(r, undefined, SPAN)).toBe(24);
  });
});

describe('ACI zoned shear — the reported bug', () => {
  const at = (x: number) => row({ Mu_pos: 100, Vu: 90, x });

  it('opening the middle third moves the mid-span shear DCR', () => {
    const tight = designMember(section, material, zoned([4, 4, 4]), at(15), SPAN);
    const mid   = designMember(section, material, zoned([4, 8, 4]), at(15), SPAN);
    const loose = designMember(section, material, zoned([4, 24, 4]), at(15), SPAN);
    expect(mid.DCR_shear).toBeGreaterThan(tight.DCR_shear);
    expect(loose.DCR_shear).toBeGreaterThan(mid.DCR_shear);
    // and the loosest case is genuinely inadequate, not merely larger
    expect(loose.DCR_shear).toBeGreaterThan(1);
  });

  it('the END zones are unaffected by the middle third', () => {
    const a = designMember(section, material, zoned([4, 4, 4]), at(1), SPAN);
    const b = designMember(section, material, zoned([4, 24, 4]), at(1), SPAN);
    expect(b.DCR_shear).toBeCloseTo(a.DCR_shear, 9);
  });

  it('§9.7.6.2.2 s_max judges the LOOSE zone', () => {
    const r = designMember(section, material, zoned([4, 24, 4]), at(15), SPAN);
    expect(r.warnings.filter(w => w.code.includes('9.7.6.2.2'))).toHaveLength(1);
  });

  it('torsion capacity tracks the zone at the station too', () => {
    const t = row({ Tu: 30, x: 15 });
    const tight = designMember(section, material, zoned([4, 4, 4]), t, SPAN);
    const loose = designMember(section, material, zoned([4, 16, 4]), t, SPAN);
    expect(loose.DCR_torsion).toBeGreaterThan(tight.DCR_torsion * 3);
  });

  it('a uniform (non-zoned) cage is unchanged', () => {
    const uniform: RebarLayout = { ...zoned([6, 6, 6]), tieZones: undefined };
    const a = designMember(section, material, uniform, at(15), SPAN);
    const b = designMember(section, material, zoned([6, 6, 6]), at(15), SPAN);
    expect(a.DCR_shear).toBeCloseTo(b.DCR_shear, 9);
  });
});

describe('ACI per-face cover', () => {
  // Deep top cover (topping slab) — the case that exposes a face mix-up.
  const perFace: SectionDimensions = { ...section, coverClear: 1.5, coverTop: 3 } as SectionDimensions;
  const uniform: RebarLayout = {
    topBars: [{ numBars: 3, barSize: 8 }], botBars: [{ numBars: 4, barSize: 8 }],
    ties: { barSize: 4, spacing: 6, legs: 2 },
  };

  it('shear d follows the flexural TENSION face', () => {
    const bot = computeShear(perFace, material, uniform, 0, 6, 'bot');
    const top = computeShear(perFace, material, uniform, 0, 6, 'top');
    expect(top.d_shear).toBeLessThan(bot.d_shear);  // deeper top cover ⇒ smaller d
  });

  it('a hogging row is designed on the top-face depth', () => {
    const hog = designMember(perFace, material, uniform, row({ Mu_neg: 150, Vu: 60, x: 0 }), SPAN);
    const sag = designMember(perFace, material, uniform, row({ Mu_pos: 150, Vu: 60, x: 15 }), SPAN);
    expect(hog.phi_Vn).toBeLessThan(sag.phi_Vn);     // unconservative before the fix
  });

  it('steelLimits scales As_min with the requested face', () => {
    const bot = steelLimits(perFace, material, 'bot');
    const top = steelLimits(perFace, material, 'top');
    expect(top.As_min).toBeLessThan(bot.As_min);
    expect(top.As_max).toBeLessThan(bot.As_max);
  });

  it('equal covers leave both faces identical (no behaviour change)', () => {
    expect(steelLimits(section, material, 'top').As_min)
      .toBeCloseTo(steelLimits(section, material, 'bot').As_min, 9);
  });

  it('computeTorsion honours the spacing override', () => {
    const a = computeTorsion(section, material, uniform, 6);
    const b = computeTorsion(section, material, uniform, 12);
    expect(b.phi_Tn).toBeCloseTo(a.phi_Tn / 2, 6);
  });
});

describe('EC2 per-face cover', () => {
  const ec2Section = (o: Partial<SectionDimensions>): SectionDimensions =>
    ({ type: 'rectangular_beam', b: 500 / MM, h: 1200 / MM, coverClear: 40 / MM, stirrupDia: -12, ...o }) as SectionDimensions;
  const ec2Mat: MaterialProps = { fc: 40 / PSI, fy: 500 / PSI, fyt: 500 / PSI, Es: 200000 / PSI, lambdaConcrete: 1 };
  const cage: RebarLayout = {
    topBars: [{ numBars: 6, barSize: -25 }], botBars: [{ numBars: 6, barSize: -25 }],
    ties: { barSize: -12, spacing: 200 / MM, legs: 2 },
  };

  it('torsion t_ef is floored by the DEEPEST cover, not the bottom one', () => {
    const even = designMemberEC2(ec2Section({}), ec2Mat, cage, row({ Tu: 80, Mu_pos: 100 }), 60);
    // Only the TOP cover deepens; t_ef must respond, so T_Rd cannot stay put.
    const deepTop = designMemberEC2(ec2Section({ coverTop: 90 / MM }), ec2Mat, cage, row({ Tu: 80, Mu_pos: 100 }), 60);
    expect(deepTop.phi_Tn).not.toBeCloseTo(even.phi_Tn, 6);
    expect(deepTop.phi_Tn).toBeLessThan(even.phi_Tn); // thicker wall ⇒ smaller Ak
  });

  it('side-face crack width uses the SIDE cover, not the bottom one', () => {
    const p = {
      b: 500, h: 1200, stirrupD: 12, fck: 40, Es: 200000, kt: 0.4, phi: 2,
      As_top: 3000, d_top: 1130, As_bot: 3000, d_bot: 1130, botBarD: 25,
      sideBarD: 16, As_perBar: 201, nPerFace: 4, Mqp_pos: 800, Mqp_neg: 0,
    };
    const sideThin = sideFaceCrackWidth({ ...p, cover: 75, coverSide: 40 });
    const sideThick = sideFaceCrackWidth({ ...p, cover: 75, coverSide: 75 });
    expect(sideThin.sr_side).toBeLessThan(sideThick.sr_side);
    // Before the fix both read the 75 mm bottom cover and were identical.
    expect(sideThin.wk).toBeLessThan(sideThick.wk);
  });

  it('coverSide defaults to cover — one-cover callers are unchanged', () => {
    const p = {
      b: 500, h: 1200, cover: 50, stirrupD: 12, fck: 40, Es: 200000, kt: 0.4, phi: 2,
      As_top: 3000, d_top: 1130, As_bot: 3000, d_bot: 1130, botBarD: 25,
      sideBarD: 16, As_perBar: 201, nPerFace: 4, Mqp_pos: 800, Mqp_neg: 0,
    };
    expect(sideFaceCrackWidth(p).wk).toBeCloseTo(sideFaceCrackWidth({ ...p, coverSide: 50 }).wk, 12);
  });
});

describe('EC2 calc sheet reproduces the engine', () => {
  const sec: SectionDimensions = { type: 'rectangular_beam', b: 500 / MM, h: 1200 / MM, coverClear: 50 / MM, stirrupDia: -12 };
  const mat: MaterialProps = { fc: 40 / PSI, fy: 500 / PSI, fyt: 500 / PSI, Es: 200000 / PSI, lambdaConcrete: 1 };
  const cage = zonedEC2([200 / MM, 250 / MM, 200 / MM]);
  function zonedEC2(zones: number[]): RebarLayout {
    return {
      topBars: [{ numBars: 8, barSize: -25 }], botBars: [{ numBars: 8, barSize: -25 }],
      ties: { barSize: -12, spacing: Math.min(...zones), legs: 2 },
      tieZones: zones.map(s => ({ spacing: s })) as RebarLayout['tieZones'],
    };
  }
  const SPAN_FT = 59;

  it('prints V_Rd,s at the ROW’s zone, matching the reported DCR', () => {
    const lc = row({ Vu: 200, Mu_pos: 400, x: 0.5 });   // zone 0 → 200 mm
    const eng = designMemberEC2(sec, mat, cage, lc, SPAN_FT);
    const sheet = generateBreakdownEC2(sec, mat, cage, lc, SPAN_FT);
    const shear = sheet.find(s => /Shear Resistance/.test(s.title))!;
    const govern = shear.steps.find(s => /Governing shear resistance/.test(s.label))!;
    const printed = Number(/DCR = ([\d.]+)/.exec(govern.note ?? '')?.[1]);
    expect(printed).toBeCloseTo(eng.DCR_shear, 2);
  });

  it('the note names the zone it used', () => {
    const sheet = generateBreakdownEC2(sec, mat, cage, row({ Vu: 200, Mu_pos: 400, x: 0.5 }), SPAN_FT);
    const step = sheet.find(s => /Shear Resistance/.test(s.title))!
      .steps.find(s => /Stirrup resistance/.test(s.label))!;
    expect(step.note).toMatch(/zone 1 of/);
  });

  it('an unlocated row is shown at the worst zone', () => {
    const sheet = generateBreakdownEC2(sec, mat, cage, row({ Vu: 200, Mu_pos: 400 }), SPAN_FT);
    const step = sheet.find(s => /Shear Resistance/.test(s.title))!
      .steps.find(s => /Stirrup resistance/.test(s.label))!;
    expect(step.note).toMatch(/no station on this row/);
  });

  it('the Ec override reaches the printed crack width', () => {
    const uniform: RebarLayout = { ...cage, tieZones: undefined };
    const lc = row({ Mu_pos: 600, Vu: 100 });
    const wk = (m: MaterialProps) => {
      const sheet = generateBreakdownEC2(sec, m, uniform, lc, SPAN_FT);
      const crackSec = sheet.find(s => /Crack/i.test(s.title));
      return crackSec?.steps.map(s => s.result).join(' ') ?? '';
    };
    // A stiffer concrete must change wk; before the fix the override moved only the
    // displayed αe while wk stayed on the code Ecm.
    expect(wk({ ...mat, Ec: 50000 / PSI })).not.toBe(wk(mat));
  });
});

// ── Round 2: defects the first repair itself introduced or left behind ────────

describe('round 2 — the repair’s own regressions', () => {
  const ec2Sec: SectionDimensions = { type: 'rectangular_beam', b: 500 / MM, h: 1200 / MM, coverClear: 50 / MM, stirrupDia: -12 };
  const ec2Mat: MaterialProps = { fc: 40 / PSI, fy: 500 / PSI, fyt: 500 / PSI, Es: 200000 / PSI, lambdaConcrete: 1 };
  const ec2Zoned = (zones: number[]): RebarLayout => ({
    topBars: [{ numBars: 8, barSize: -25 }], botBars: [{ numBars: 8, barSize: -25 }],
    ties: { barSize: -12, spacing: Math.min(...zones), legs: 2 },
    tieZones: zones.map(s => ({ spacing: s })) as RebarLayout['tieZones'],
  });

  it('EC2 bins the third point the same way the tables do', () => {
    // 40 ft span, station at the exact third point. The engine used to floor the
    // raw ratio locally and land in zone 0 while every other path snapped to 1.
    const cage = ec2Zoned([4, 12, 4]);
    const atThird = designMemberEC2(ec2Sec, ec2Mat, cage, row({ Vu: 150, Mu_pos: 300, x: 13.333333 }), 40);
    const inMid   = designMemberEC2(ec2Sec, ec2Mat, cage, row({ Vu: 150, Mu_pos: 300, x: 15 }), 40);
    expect(atThird.phi_Vn).toBeCloseTo(inMid.phi_Vn, 6);   // both zone 1 (12")
    expect(tieSpacingAtX(cage, 13.333333, 40)).toBe(12);
  });

  it('EC2 §9.2.3(2) still judges the WORST zone', () => {
    // Torsion peaks at the supports, so the row sits in a tight end zone; the
    // detailing limit must still see the loose middle third.
    const cage = ec2Zoned([4, 30, 4]);
    const r = designMemberEC2(ec2Sec, ec2Mat, cage, row({ Tu: 200, Vu: 100, Mu_pos: 200, x: 0.5 }), 60);
    expect(r.warnings.some(w => w.code.includes('9.2.3'))).toBe(true);
  });

  it('EC2 skin-bar layout responds to the TOP cover', () => {
    const p = {
      b: 500, h: 1200, cover: 40, coverSide: 40, stirrupD: 12, fck: 40, Es: 200000,
      kt: 0.4, phi: 2, As_top: 3000, d_top: 1130, As_bot: 3000, d_bot: 1130,
      botBarD: 25, sideBarD: 16, As_perBar: 201, nPerFace: 4, Mqp_pos: 800, Mqp_neg: 0,
    };
    expect(sideFaceCrackWidth({ ...p, coverTop: 90 }).s_v)
      .not.toBeCloseTo(sideFaceCrackWidth(p).s_v, 6);
    // and defaulting coverTop leaves one-cover callers untouched
    expect(sideFaceCrackWidth({ ...p, coverTop: 40 }).s_v).toBeCloseTo(sideFaceCrackWidth(p).s_v, 12);
  });

  it('ACI rho_w does not collapse on a hogging row with no top steel', () => {
    const noTop: RebarLayout = {
      topBars: [], botBars: [{ numBars: 4, barSize: 8 }],
      ties: { barSize: 4, spacing: 6, legs: 2 },
    };
    const hog = designMember(section, material, noTop, row({ Mu_neg: 20, Vu: 40, x: 0 }), SPAN);
    const sag = designMember(section, material, noTop, row({ Mu_pos: 20, Vu: 40, x: 15 }), SPAN);
    expect(hog.phi_Vn).toBeGreaterThan(0);
    expect(hog.phi_Vn).toBeCloseTo(sag.phi_Vn, 6);  // falls back to the real steel
    expect(hog.DCR_shear).toBeLessThan(1);
  });

  it('the §9.6.3.1 trigger does not swing with the row’s moment sense', () => {
    // Deeper top-face d must not raise the trigger and hide the error.
    const sec: SectionDimensions = { ...section, coverClear: 3, coverTop: 1.5 } as SectionDimensions;
    const noTies: RebarLayout = {
      topBars: [{ numBars: 2, barSize: 6 }], botBars: [{ numBars: 4, barSize: 9 }],
    };
    const hog = designMember(sec, material, noTies, row({ Mu_neg: 60, Vu: 22, x: 0 }), SPAN);
    const sag = designMember(sec, material, noTies, row({ Mu_pos: 60, Vu: 22, x: 15 }), SPAN);
    const trig = (r: typeof hog) => r.warnings.some(w => w.code.includes('9.6.3.1'));
    expect(trig(hog)).toBe(trig(sag));
  });

  it('zonedShearCheck honours the tension face designMember used', () => {
    const sec: SectionDimensions = { ...section, coverClear: 1.5, coverTop: 3 } as SectionDimensions;
    const cage = zoned([4, 12, 4]);
    const bot = zonedShearCheck(sec, material, cage, [90, 40, 90], 0, 'bot');
    const top = zonedShearCheck(sec, material, cage, [90, 40, 90], 0, 'top');
    expect(top[0].phi_Vn).toBeLessThan(bot[0].phi_Vn);
  });

  it('requiredAs floors the top face with the TOP-face As,min', () => {
    const sec: SectionDimensions = { ...section, coverClear: 1.5, coverTop: 3 } as SectionDimensions;
    // A tiny Mu means As,min governs, so the returned value IS the floor.
    expect(requiredAs(1, sec, material, true, SPAN))
      .toBeCloseTo(steelLimits(sec, material, 'top').As_min, 9);
  });

  it('designMember publishes the top-face As,min for sizing consumers', () => {
    const sec: SectionDimensions = { ...section, coverClear: 3, coverTop: 1.5 } as SectionDimensions;
    const r = designMember(sec, material, zoned([6, 6, 6]), row({ Mu_neg: 200, Mu_pos: 200, Vu: 40, x: 0 }), SPAN);
    expect(r.As_min_top).toBeDefined();
    expect(r.As_min_top).not.toBeCloseTo(r.As_min, 6);   // d_top > d_bot here
  });

  it('the ACI calc sheet reproduces the engine on a zoned beam', () => {
    const cage = zoned([4, 24, 4]);
    const lc = row({ Mu_pos: 100, Vu: 90, x: 15 });
    const eng = designMember(section, material, cage, lc, SPAN);
    const sheet = generateBreakdown(section, material, cage, lc, SPAN);
    const txt = sheet.flatMap(s => s.steps).map(s => `${s.result} ${s.note ?? ''}`).join(' ');
    const printed = Number(/DCR\D{0,12}([\d.]+)/.exec(
      sheet.flatMap(s => s.steps).filter(s => /shear/i.test(s.label))
        .map(s => `${s.result} ${s.note ?? ''}`).join(' '))?.[1]);
    expect(txt.length).toBeGreaterThan(0);
    expect(printed).toBeCloseTo(eng.DCR_shear, 2);
  });
});

// ── ACI Example 1 — back-check against S-Concrete 2026 ───────────────────────
// Examples/ACI/Example 1 (section B-07-04, ACI 318-19): 12×28 in, f'c 6000 psi,
// 4-#8 top, 4-#8 + 4-#8 bottom (As 6.32 in², d 24.375 in), #5@9" 2-leg ties,
// covers 1.5 all round, under N = 1000 kip compression, Vz = 60 kip, My = 290 k·ft.
// S-Concrete reports ØVcz 85.0, ØVsz 75.6, ØVnz 160.5 kip, Vz Util 0.374.
describe('ACI Example 1 — S-Concrete back-check (axial + shear)', () => {
  const sec: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 28, coverClear: 1.5, stirrupDia: 5 };
  const mat: MaterialProps = { fc: 6000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1.0 };
  const cage: RebarLayout = {
    topBars: [{ numBars: 4, barSize: 8 }],
    botBars: [{ numBars: 4, barSize: 8 }, { numBars: 4, barSize: 8 }],
    ties: { barSize: 5, spacing: 9, legs: 2 },
    layerClearSpacing: 1.0,
  };
  const PHI_V = 0.75;
  const lc = row({ Mu_pos: 290, Vu: 60, Pu: 1000 });
  const r = designMember(sec, mat, cage, lc, 24);

  it('d = 24.375 in (two bottom layers, dz = 1.0)', () => {
    const s = computeShear(sec, mat, cage, 1000, 9);
    expect(s.d_shear).toBeCloseTo(24.375, 3);
  });

  it('φVs = 75.6 kips', () => {
    const s = computeShear(sec, mat, cage, 1000, 9);
    expect(PHI_V * s.Vs).toBeCloseTo(75.6, 1);
  });

  it('φVc = 85.0 kips — the 5λ√f\'c·bw·d cap governs once Nu is in POUNDS', () => {
    const s = computeShear(sec, mat, cage, 1000, 9);
    expect(PHI_V * s.Vc).toBeCloseTo(85.0, 1);
  });

  it('φVn = 160.5 kips and shear DCR = 0.374', () => {
    expect(r.phi_Vn).toBeCloseTo(160.5, 1);
    expect(r.DCR_shear).toBeCloseTo(0.374, 3);
  });

  it('the axial term is capped at 0.05f\'c per the Table 22.5.5.1 footnote', () => {
    // Raw Nu/(6Ag) = 1000·1000/(6·336) = 496 psi > 0.05·6000 = 300 psi.
    // The cap must bind, yet φVc stays 85.0 because the 5√f'c cap governs anyway.
    const capped = computeShear(sec, mat, cage, 1000, 9);      // term would be 496 psi
    const atCap  = computeShear(sec, mat, cage, 605, 9);       // term ≈ 300 psi exactly
    expect(PHI_V * capped.Vc).toBeCloseTo(PHI_V * atCap.Vc, 6);
  });

  it('axial TENSION removes the concrete contribution instead of ignoring it', () => {
    const tension = computeShear(sec, mat, cage, -1000, 9);
    expect(tension.Vc).toBe(0);            // both Table 22.5.5.1 cases go negative
    const none = computeShear(sec, mat, cage, 0, 9);
    expect(none.Vc).toBeGreaterThan(0);    // and it is the axial load doing it
  });

  // Superseded: the engine now RUNS the P-M interaction instead of warning that
  // it doesn't. S-Concrete reports N-vs-M 0.982 for this load case; the old
  // pure-bending answer was 0.46.
  it('checks the P-M interaction rather than warning that it is missing', () => {
    expect(r.warnings.some(x => x.message.includes('PURE BENDING'))).toBe(false);
    expect(r.DCR_PM).toBeCloseTo(0.982, 2);
    expect(r.phi_Pn_max).toBeCloseTo(1161.7, 1);
    // φMn at 1000 kips is roughly half the pure-bending capacity.
    expect(r.phi_Mn_pos).toBeCloseTo(307.8, 0);
  });

  it('the combined check governs over flexure alone here', () => {
    expect(r.DCR_PM!).toBeGreaterThan(r.DCR_flex_pos);
    expect(r.DCR_PM!).toBeGreaterThan(r.DCR_shear);
  });

  it('a beam with no axial is untouched by the fix', () => {
    const noP = computeShear(sec, mat, cage, 0, 9);
    expect(noP.Vc).toBeCloseTo(50.5, 1);   // the pre-fix value, which was correct at Pu = 0
  });
});
