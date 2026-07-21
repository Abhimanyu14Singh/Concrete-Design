import { describe, it, expect } from 'vitest';
import { mRd, designMemberEC2, lambdaEta } from '../ec2Beam';
import type { SectionDimensions, MaterialProps, RebarLayout, LoadCase } from '../../../types';

// ── mRd §6.1 — compression steel is credited (doubly reinforced) ──────────────
describe('mRd doubly-reinforced §6.1', () => {
  const fck = 40, fcd = 0.85 * 40 / 1.5, fyd = 500 / 1.15;

  it('AsComp = 0 reproduces the singly-reinforced closed form (under-reinforced)', () => {
    const As = 3 * Math.PI * 100;                 // 3Ø20 = 942 mm², d = 450, b = 300
    const single = mRd(As, 450, 300, fck, fcd, fyd);
    const { lambda, eta } = lambdaEta(fck);
    const x = As * fyd / (eta * fcd * lambda * 300);
    expect(single.x).toBeCloseTo(x, 1);
    expect(single.MRd).toBeCloseTo(As * fyd * (450 - lambda * x / 2) / 1e6, 1);
    expect(single.tensionYields).toBe(true);
  });

  it('crediting compression steel raises M_Rd and shrinks the neutral axis', () => {
    // Heavily reinforced deep section (mirrors user beam 8550, −M sense):
    // tension = 16Ø32 top, compression = 10Ø32 bottom @ d' = 82 mm, d = 918.
    const As = 16 * (Math.PI / 4) * 32 * 32;       // 12868 mm²
    const AsC = 10 * (Math.PI / 4) * 32 * 32;       // 8042 mm²
    const single = mRd(As, 918, 500, fck, fcd, fyd);
    const doubly = mRd(As, 918, 500, fck, fcd, fyd, undefined, undefined, AsC, 82);
    expect(doubly.MRd).toBeGreaterThan(single.MRd);  // compression steel adds capacity
    expect(doubly.x).toBeLessThan(single.x);         // shallower NA
    expect(doubly.x / 918).toBeLessThan(0.45);       // back in the ductile range
    expect(single.x / 918).toBeGreaterThan(0.45);    // singly model was on the over-reinf. plateau
    // The corrected capacity clears a 3448 kN·m demand with real margin.
    expect(3448.4 / doubly.MRd).toBeLessThan(0.85);
    expect(3448.4 / single.MRd).toBeGreaterThan(0.90); // the old (buggy) singly value hugged 1.0
  });
});

// ── designMemberEC2 — the M⁻ DCR reported for beam 8550 drops below 1 ─────────
describe('designMemberEC2 — beam 8550 M⁻ DCR reflects compression steel', () => {
  const MM = 25.4, PSI = 0.00689476, KIPFT = 1.35582;
  const section: SectionDimensions = {
    type: 'rectangular_beam', b: 500 / MM, h: 1000 / MM, coverClear: 50 / MM, stirrupDia: -16,
  };
  const material: MaterialProps = {
    fc: 40 / PSI, fy: 500 / PSI, fyt: 500 / PSI, Es: 200000 / PSI, lambdaConcrete: 1,
  };
  const rebar: RebarLayout = {
    topBars: [{ numBars: 16, barSize: -32 }],     // heavy top steel (crack-width driven)
    botBars: [{ numBars: 10, barSize: -32 }],     // compression steel under −M
    ties: { barSize: -16, spacing: 200 / MM, legs: 2 },
  };
  const load: LoadCase = {
    id: 'env', label: 'Env−', Mu_pos: 0, Mu_neg: 3448.4 / KIPFT,
    Vu: 1048.7 / 4.44822, Tu: 0.9 / KIPFT, Pu: -19.6 / 4.44822,
  };

  it('reports M⁻ DCR well below 1 (≈0.75), not the ≈0.99 over-reinforced plateau', () => {
    const r = designMemberEC2(section, material, rebar, load);
    const MRd_neg = r.phi_Mn_neg * KIPFT;         // back to kN·m
    expect(MRd_neg).toBeGreaterThan(4300);        // doubly-reinforced ≈ 4.6 MN·m, not 3.5
    expect(r.DCR_flex_neg).toBeLessThan(0.80);
    expect(r.DCR_flex_neg).toBeGreaterThan(0.65); // still a real, non-trivial ratio
  });
});
