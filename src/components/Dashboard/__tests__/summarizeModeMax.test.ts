import { describe, it, expect } from 'vitest';
import { summarize, worstOf } from '../dashboardShared';
import { runDesign } from '../../../engines';
import type { Member, SectionDimensions, MaterialProps, RebarLayout, LoadCase } from '../../../types';

// Regression: the dashboard M⁺/M⁻/V chips must show the GOVERNING per-mode DCR
// across ALL load rows — not the per-mode values of a single representative row.
// A beam whose overall-worst row is (say) shear- or crack-driven would otherwise
// show a green M⁻ chip while a DIFFERENT row pushes M⁻ past 1.0.
const section: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 20, coverClear: 1.5, stirrupDia: 3 };
const material: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 };
const rebar: RebarLayout = {
  topBars: [{ numBars: 2, barSize: 6 }],
  botBars: [{ numBars: 3, barSize: 8 }],
  ties: { barSize: 3, spacing: 8, legs: 2 },
};
// L1 peaks hogging flexure (big Mu⁻, tiny shear); L2 peaks shear (tiny Mu⁻, big Vu).
const L1: LoadCase = { id: 'M', label: 'moment', Mu_pos: 40, Mu_neg: 130, Vu: 15, Tu: 0, Pu: 0 };
const L2: LoadCase = { id: 'V', label: 'shear', Mu_pos: 25, Mu_neg: 20, Vu: 95, Tu: 0, Pu: 0 };
const member: Member = { id: 'b', label: 'B1', memberType: 'beam', material, section, rebar, loads: [L1, L2], span: 20 };

describe('summarize.modeMax — governing DCR per mode across all rows', () => {
  const r1 = runDesign(section, material, rebar, L1, 20, 'ACI318-19');
  const r2 = runDesign(section, material, rebar, L2, 20, 'ACI318-19');
  const s = summarize(member, 'ACI318-19');

  it('the two modes peak on DIFFERENT load rows (the scenario under test)', () => {
    expect(r1.DCR_flex_neg).toBeGreaterThan(r2.DCR_flex_neg); // hogging governs on L1
    expect(r2.DCR_shear).toBeGreaterThan(r1.DCR_shear);        // shear governs on L2
  });

  it('modeMax.flexNeg / modeMax.shear equal the per-mode max across rows', () => {
    expect(s.modeMax.flexNeg).toBeCloseTo(Math.max(r1.DCR_flex_neg, r2.DCR_flex_neg), 6);
    expect(s.modeMax.shear).toBeCloseTo(
      Math.max(Math.max(r1.DCR_shear, r1.VT_util ?? 0), Math.max(r2.DCR_shear, r2.VT_util ?? 0)), 6);
    expect(s.modeMax.flexPos).toBeCloseTo(Math.max(r1.DCR_flex_pos, r2.DCR_flex_pos), 6);
  });

  it('captures BOTH peaks even though worstResult is a single row', () => {
    // worstResult holds one row, so it understates whichever mode peaks on the other.
    const understatesFlex = s.worstResult.DCR_flex_neg < s.modeMax.flexNeg - 1e-9;
    const understatesShear = s.worstResult.DCR_shear < s.modeMax.shear - 1e-9;
    expect(understatesFlex || understatesShear).toBe(true);
    // Sanity: worstResult is genuinely the worst-overall row.
    expect(worstOf(s.worstResult)).toBeCloseTo(Math.max(worstOf(r1), worstOf(r2)), 6);
  });
});
