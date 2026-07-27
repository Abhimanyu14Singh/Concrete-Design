import { describe, it, expect } from 'vitest';
import { designMemberEC2 } from '../ec2Beam';
import type { SectionDimensions, MaterialProps, RebarLayout, LoadCase } from '../../../types';

// Zoned-shear regression (user beam 6622): the headline shear check must evaluate
// capacity at the spacing of the zone where the demand ACTS, not the loosest zone.
// Pairing the loose mid-span spacing with the peak end shear (different sections)
// spuriously failed a correctly-zoned beam.
const MM = 25.4, PSI = 0.00689476, KN = 4.44822;
const SPAN_FT = 18 * 3.28084;                 // 18 m span

const section: SectionDimensions = { type: 'rectangular_beam', b: 500 / MM, h: 1200 / MM, coverClear: 50 / MM, stirrupDia: -12 };
const material: MaterialProps = { fc: 40 / PSI, fy: 500 / PSI, fyt: 500 / PSI, Es: 200000 / PSI, lambdaConcrete: 1 };
// Tight ends (200 mm), loose middle (250 mm).
const rebar: RebarLayout = {
  topBars: [{ numBars: 10, barSize: -25 }],
  botBars: [{ numBars: 10, barSize: -25 }],
  ties: { barSize: -12, spacing: 200 / MM, legs: 2 },
  tieZones: [{ spacing: 200 / MM }, { spacing: 250 / MM }, { spacing: 200 / MM }] as RebarLayout['tieZones'],
};
const base = { Mu_pos: 0, Mu_neg: 0, Tu: 0, Pu: 0 };
const Vu_kip = 1100 / KN;                      // between V_Rd,s@250 and @200

describe('designMemberEC2 — zoned shear evaluates capacity at the demand’s zone', () => {
  const atSupport: LoadCase = { id: 's', label: 's', ...base, Vu: Vu_kip, x: 0.5 };            // zone 0 (200)
  const atMidspan: LoadCase = { id: 'm', label: 'm', ...base, Vu: Vu_kip, x: SPAN_FT / 2 };    // zone 1 (250)
  const noPos:     LoadCase = { id: 'n', label: 'n', ...base, Vu: Vu_kip };                    // no position

  const rSupport = designMemberEC2(section, material, rebar, atSupport, SPAN_FT);
  const rMid     = designMemberEC2(section, material, rebar, atMidspan, SPAN_FT);
  const rNo      = designMemberEC2(section, material, rebar, noPos, SPAN_FT);

  it('the tight end zone (200) gives more shear capacity than the loose middle (250)', () => {
    expect(rSupport.phi_Vn).toBeGreaterThan(rMid.phi_Vn);
  });

  it('a row with no station position falls back to the worst (loosest) zone = 250', () => {
    expect(rNo.phi_Vn).toBeCloseTo(rMid.phi_Vn, 6);
  });

  it('the SAME peak shear passes at the support but fails mid-span-spacing — the fix', () => {
    // Before the fix, the support demand was checked against the loose 250 spacing → NG.
    expect(rSupport.DCR_shear).toBeLessThan(1); // correctly-zoned end: adequate
    expect(rMid.DCR_shear).toBeGreaterThan(1);  // that spacing would only be here, where shear is low
    expect(rNo.DCR_shear).toBeCloseTo(rMid.DCR_shear, 6);
  });

  it('a uniform (non-zoned) beam is unchanged — uses ties.spacing', () => {
    const uniform: RebarLayout = { ...rebar, tieZones: undefined };
    const r = designMemberEC2(section, material, uniform, atSupport, SPAN_FT);
    // ties.spacing is 200 → same capacity as the 200 end zone.
    expect(r.phi_Vn).toBeCloseTo(rSupport.phi_Vn, 6);
  });
});
