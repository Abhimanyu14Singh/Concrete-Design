/**
 * EC2 §7.3.3(3)+§7.3.2(2) skin (side-face) minimum AREA — benchmarked against the
 * S-CONCRETE 2026 report for beam A_300x700_B2 (a 500 × 1500 rectangular beam,
 * fck 40, fyk 500). That report's "Min Crack Control Reinforcement – Skin Region"
 * (governing load case 3: N = 206.9 kN tension, M = 237.8 kN·m) prints:
 *     kc = 0.45 · k = 0.50 · fct,eff = 3.51 MPa · Act = 407 003.8 mm²
 *     As,min = 1176.81 mm²  (provided 12-Ø12 = 1357 mm² → Acceptable)
 * We reproduce kc, Act and As,min (within ~3 %, using σs = 280 MPa from Table 7.2N
 * vs the report's 273), and check the verifier flags an under-provided cage.
 */
import { describe, it, expect } from 'vitest';
import { skinMinArea, sigmaSforSkin, designMemberEC2 } from '../ec2Beam';
import { minSkinReinforcement } from '../../../adapters/etabs/rebarSeed';
import { DEFAULT_CRACK_PARAMS } from '../../../types';
import type { SectionDimensions, MaterialProps, RebarLayout, LoadCase } from '../../../types';

const MM = 25.4;
const PSI = 0.00689476;        // MPa → psi divisor
const KIP = 4.44822;           // kN → kip
const KIPFT = 1.35582;         // kN·m → kip·ft

describe('EC2 skinMinArea — S-CONCRETE A_300x700_B2 benchmark', () => {
  // 500 × 1500 rectangular beam, fck 40, N = 206.9 kN tension (NEd compression +).
  const b = 500, h = 1500, NEd = -206_900, fck = 40, phi = 12, wk = 0.3;

  it('sigmaSforSkin(Ø12, 0.3 mm) = 280 MPa (Table 7.2N)', () => {
    expect(sigmaSforSkin(12, 0.3)).toBeCloseTo(280, 5);
    expect(sigmaSforSkin(16, 0.3)).toBeCloseTo(240, 5); // table anchor
  });

  it('reproduces kc ≈ 0.45, Act ≈ 407 000 mm², As,min ≈ 1177 mm²', () => {
    const r = skinMinArea(b, h, NEd, fck, phi, wk)!;
    expect(r).not.toBeNull();
    expect(r.kc).toBeCloseTo(0.447, 2);            // report 0.45
    expect(r.k).toBe(0.5);
    expect(r.Act).toBeGreaterThan(404_000);
    expect(r.Act).toBeLessThan(410_000);           // report 407 003.8
    expect(r.yt).toBeGreaterThan(808);
    expect(r.yt).toBeLessThan(820);                // ~814 mm tension zone
    expect(r.AsMin).toBeGreaterThan(1100);
    expect(r.AsMin).toBeLessThan(1180);            // report 1176.81 (we get ~1140)
  });

  it('returns null for a shallow section (h < 1000 mm — no skin rule)', () => {
    expect(skinMinArea(400, 900, 0, 40, 12, 0.3)).toBeNull();
  });

  it('axial tension raises As,min above the pure-bending value', () => {
    const bending = skinMinArea(b, h, 0, fck, phi, wk)!;      // NEd = 0
    const tension = skinMinArea(b, h, NEd, fck, phi, wk)!;    // 206.9 kN tension
    expect(tension.AsMin).toBeGreaterThan(bending.AsMin);
    expect(tension.kc).toBeGreaterThan(bending.kc);           // 0.447 vs 0.40
  });
});

describe('designMemberEC2 — skin As,min flags an under-provided deep beam', () => {
  const section: SectionDimensions = {
    type: 'rectangular_beam', b: 500 / MM, h: 1500 / MM, coverClear: 50 / MM, stirrupDia: -12,
  };
  const material: MaterialProps = {
    fc: 40 / PSI, fy: 500 / PSI, fyt: 500 / PSI, Es: 199948 / PSI, lambdaConcrete: 1.0,
  };
  // GLC 3: N = 206.9 kN tension (−Pu), M = 237.8 kN·m, V = 105.2 kN, T = 12.6 kN·m.
  const load: LoadCase = {
    id: 'GLC3', label: 'L01', Mu_pos: 237.8 / KIPFT, Mu_neg: 0,
    Vu: 105.2 / KIP, Tu: 12.6 / KIPFT, Pu: -206.9 / KIP,
  };
  const crack = { ...DEFAULT_CRACK_PARAMS, wLimitBot: 0.3, wLimitTop: 0.3, wLimitFace: 0.3 };
  const cage = (perFace: number): RebarLayout => ({
    topBars: [{ numBars: 3, barSize: -25 }],
    botBars: [{ numBars: 4, barSize: -25 }, { numBars: 4, barSize: -25 }],
    ties: { barSize: -12, spacing: 150 / MM, legs: 2 },
    sideBars: perFace > 0 ? [{ numBars: perFace, barSize: -12 }] : undefined,
  });
  const skinWarn = (r: { warnings: { code: string; message: string }[] }) =>
    r.warnings.find(w => w.code === 'EC2 §7.3.3' && /Skin steel/.test(w.message));

  it('12-Ø12 (6/face = 1357 mm²) satisfies As,min — no skin-area warning', () => {
    const r = designMemberEC2(section, material, cage(6), load, 20, crack);
    expect(r.As_skin_prov).toBeGreaterThan(1350);          // 1357 mm²
    expect(r.As_skin_min).toBeGreaterThan(1100);
    expect(r.As_skin_min).toBeLessThan(1180);              // ~1140 (report 1177)
    expect(r.As_skin_prov!).toBeGreaterThan(r.As_skin_min!);
    expect(skinWarn(r)).toBeUndefined();
  });

  it('6-Ø12 (3/face = 679 mm²) is under As,min — skin-area warning fires', () => {
    const r = designMemberEC2(section, material, cage(3), load, 20, crack);
    expect(r.As_skin_prov).toBeLessThan(700);              // 679 mm²
    expect(skinWarn(r)).toBeDefined();
    expect(skinWarn(r)!.message).toMatch(/A_s,min/);
  });
});

describe('minSkinReinforcement — EC2 auto-size now targets the area', () => {
  const section: SectionDimensions = {
    type: 'rectangular_beam', b: 500 / MM, h: 1500 / MM, coverClear: 50 / MM, stirrupDia: -12,
  };

  it('area-driven EC2 suggestion (fck 40) gives ≥ 5 Ø12 per face — was 3 (geometry-only)', () => {
    const s = minSkinReinforcement(section, 'EN1992-1-1', -12, { fckMPa: 40 })!;
    expect(s).toBeDefined();
    expect(s.numBars).toBeGreaterThanOrEqual(5);           // ≥ 10 total, ~1131 mm²
    // The old lower-half/≤300 mm geometry rule gave only 3/face (679 mm²).
    const spacingOnly = Math.ceil((1500 / 2 - 50) / 300); // = 3
    expect(s.numBars).toBeGreaterThan(spacingOnly);
  });
});
