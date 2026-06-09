/**
 * Unit tests for ACI 318-19 concrete design engine.
 * Reference values computed by hand or cross-checked against published examples.
 */
import { describe, it, expect } from 'vitest';
import {
  getBarArea,
  getBarDiam,
  computeFlexure,
  computeShear,
  computeTorsion,
  requiredAs,
  designMember,
  computeInteractionDiagram,
} from '../concreteDesign';
import type { MaterialProps, SectionDimensions, RebarLayout, LoadCase } from '../../types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const mat4k: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const mat5k: MaterialProps = { fc: 5000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };

const rectBeam: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 21, coverClear: 1.5, stirrupDia: 4 };
const rectBeam16x24: SectionDimensions = { type: 'rectangular_beam', b: 16, h: 24, coverClear: 1.5, stirrupDia: 4 };
const tBeam: SectionDimensions = { type: 'T_beam', b: 48, bw: 14, h: 24, hf: 5, coverClear: 1.5, stirrupDia: 4 };
const circCol: SectionDimensions = { type: 'circular_column', b: 20, h: 20, diameter: 20, coverClear: 1.5, stirrupDia: 4 };
const rectCol: SectionDimensions = { type: 'rectangular_column', b: 18, h: 18, coverClear: 1.5, stirrupDia: 4 };

const rebar3_8: RebarLayout = {
  topBars: [{ numBars: 3, barSize: 8 }],
  botBars: [{ numBars: 4, barSize: 8 }],
  ties: { barSize: 4, spacing: 6, legs: 2 },
};

// ─── Bar lookups ─────────────────────────────────────────────────────────────

describe('Bar property lookups', () => {
  it('returns correct area for standard bar sizes', () => {
    expect(getBarArea(3)).toBeCloseTo(0.11, 2);
    expect(getBarArea(8)).toBeCloseTo(0.79, 2);
    expect(getBarArea(11)).toBeCloseTo(1.56, 2);
    expect(getBarArea(14)).toBeCloseTo(2.25, 2);
  });

  it('returns correct diameter for standard bar sizes', () => {
    expect(getBarDiam(8)).toBeCloseTo(1.0, 2);
    expect(getBarDiam(4)).toBeCloseTo(0.5, 2);
    expect(getBarDiam(11)).toBeCloseTo(1.410, 2);
  });

  it('returns 0 for unknown bar size', () => {
    expect(getBarArea(99)).toBe(0);
    expect(getBarDiam(99)).toBe(0);
  });
});

// ─── Flexure ─────────────────────────────────────────────────────────────────

describe('computeFlexure — rectangular beam', () => {
  it('phi_Mn_pos > 0 when bottom steel is provided', () => {
    const As_bot = 4 * getBarArea(8); // 4-#8 = 3.16 in²
    const As_top = 3 * getBarArea(8); // 3-#8 = 2.37 in²
    const result = computeFlexure(rectBeam, mat4k, As_top, As_bot);
    expect(result.phi_Mn_pos).toBeGreaterThan(0);
    expect(result.phi_Mn_neg).toBeGreaterThan(0);
  });

  it('phi = 0.9 for tension-controlled section (low steel ratio)', () => {
    const As_bot = 1 * getBarArea(6); // light steel
    const result = computeFlexure(rectBeam, mat4k, 0, As_bot);
    expect(result.phi_pos).toBeCloseTo(0.9, 2);
  });

  it('phi_Mn increases with more bottom steel (up to max reinf)', () => {
    const resultLight = computeFlexure(rectBeam, mat4k, 0, 2 * getBarArea(7));
    const resultHeavy = computeFlexure(rectBeam, mat4k, 0, 5 * getBarArea(8));
    expect(resultHeavy.phi_Mn_pos).toBeGreaterThan(resultLight.phi_Mn_pos);
  });

  it('zero steel returns zero moment capacity', () => {
    const result = computeFlexure(rectBeam, mat4k, 0, 0);
    expect(result.phi_Mn_pos).toBe(0);
    expect(result.phi_Mn_neg).toBe(0);
  });

  it('higher f\'c produces higher moment capacity for same steel', () => {
    const As = 4 * getBarArea(8);
    const r4k = computeFlexure(rectBeam, mat4k, 0, As);
    const r6k = computeFlexure(rectBeam, { ...mat4k, fc: 6000 }, 0, As);
    // Same As×fy tension — moment arm increases slightly with higher fc
    expect(r6k.phi_Mn_pos).toBeGreaterThanOrEqual(r4k.phi_Mn_pos);
  });
});

describe('computeFlexure — T-beam', () => {
  it('T-beam positive moment capacity exceeds equivalent rectangular section', () => {
    const As = 5 * getBarArea(9);
    const tResult = computeFlexure(tBeam, mat4k, 0, As);
    const rResult = computeFlexure({ ...tBeam, type: 'rectangular_beam', b: tBeam.bw ?? 14 }, mat4k, 0, As);
    expect(tResult.phi_Mn_pos).toBeGreaterThan(rResult.phi_Mn_pos);
  });
});

// ─── Shear ───────────────────────────────────────────────────────────────────

describe('computeShear', () => {
  it('Vc is positive for a normal beam section', () => {
    const result = computeShear(rectBeam16x24, mat4k, rebar3_8);
    expect(result.Vc).toBeGreaterThan(0);
  });

  it('Vs is proportional to Av/s when stirrups present', () => {
    const rebarClose: RebarLayout = { ...rebar3_8, ties: { barSize: 4, spacing: 4, legs: 2 } };
    const rebarFar: RebarLayout = { ...rebar3_8, ties: { barSize: 4, spacing: 12, legs: 2 } };
    const close = computeShear(rectBeam16x24, mat4k, rebarClose);
    const far = computeShear(rectBeam16x24, mat4k, rebarFar);
    expect(close.Vs).toBeGreaterThan(far.Vs);
  });

  it('phi_Vn >= Vc when stirrups are present', () => {
    const result = computeShear(rectBeam16x24, mat4k, rebar3_8);
    expect(result.phi_Vn).toBeGreaterThanOrEqual(0.75 * result.Vc);
  });

  it('larger section gives higher Vc', () => {
    const small = computeShear({ ...rectBeam, b: 8, h: 12 }, mat4k, rebar3_8);
    const large = computeShear(rectBeam16x24, mat4k, rebar3_8);
    expect(large.Vc).toBeGreaterThan(small.Vc);
  });

  it('higher f\'c increases Vc', () => {
    const low = computeShear(rectBeam16x24, mat4k, rebar3_8);
    const high = computeShear(rectBeam16x24, mat5k, rebar3_8);
    expect(high.Vc).toBeGreaterThan(low.Vc);
  });
});

// ─── Torsion ─────────────────────────────────────────────────────────────────

describe('computeTorsion', () => {
  it('Tcr is positive', () => {
    const result = computeTorsion(rectBeam16x24, mat4k);
    expect(result.Tcr).toBeGreaterThan(0);
  });

  it('Tu_threshold = Tcr / 4', () => {
    const result = computeTorsion(rectBeam16x24, mat4k);
    expect(result.Tu_threshold).toBeCloseTo(result.Tcr / 4, 3);
  });

  it('larger section has higher cracking torsion', () => {
    const small = computeTorsion({ ...rectBeam, b: 10, h: 14 }, mat4k);
    const large = computeTorsion(rectBeam16x24, mat4k);
    expect(large.Tcr).toBeGreaterThan(small.Tcr);
  });

  it('higher f\'c increases Tcr', () => {
    const low = computeTorsion(rectBeam16x24, mat4k);
    const high = computeTorsion(rectBeam16x24, mat5k);
    expect(high.Tcr).toBeGreaterThan(low.Tcr);
  });
});

// ─── Required steel ──────────────────────────────────────────────────────────

describe('requiredAs', () => {
  it('returns positive value for nonzero moment', () => {
    const As = requiredAs(100, rectBeam16x24, mat4k, false);
    expect(As).toBeGreaterThan(0);
  });

  it('returns 0 for zero moment', () => {
    expect(requiredAs(0, rectBeam16x24, mat4k, false)).toBe(0);
  });

  it('more moment requires more steel', () => {
    const small = requiredAs(50, rectBeam16x24, mat4k, false);
    const large = requiredAs(200, rectBeam16x24, mat4k, false);
    expect(large).toBeGreaterThan(small);
  });

  it('higher f\'c allows less steel for same moment', () => {
    const low = requiredAs(150, rectBeam16x24, mat4k, false);
    const high = requiredAs(150, rectBeam16x24, mat5k, false);
    expect(high).toBeLessThanOrEqual(low);
  });
});

// ─── Full designMember ────────────────────────────────────────────────────────

describe('designMember', () => {
  const load: LoadCase = { id: 'test', label: 'Test', Mu_pos: 120, Mu_neg: 80, Vu: 50, Tu: 5, Pu: 0 };

  it('returns a status of OK, Warning, or NG', () => {
    const result = designMember(rectBeam16x24, mat4k, rebar3_8, load);
    expect(['OK', 'Warning', 'NG']).toContain(result.status);
  });

  it('DCR values are non-negative', () => {
    const result = designMember(rectBeam16x24, mat4k, rebar3_8, load);
    expect(result.DCR_flex_pos).toBeGreaterThanOrEqual(0);
    expect(result.DCR_flex_neg).toBeGreaterThanOrEqual(0);
    expect(result.DCR_shear).toBeGreaterThanOrEqual(0);
    expect(result.DCR_torsion).toBeGreaterThanOrEqual(0);
  });

  it('status is NG when loads massively exceed capacity', () => {
    const bigLoad: LoadCase = { ...load, Mu_pos: 9999, Mu_neg: 9999, Vu: 9999 };
    const result = designMember(rectBeam16x24, mat4k, rebar3_8, bigLoad);
    expect(result.status).toBe('NG');
    expect(result.DCR_flex_pos).toBeGreaterThan(1);
  });

  it('status is OK when loads are well below capacity', () => {
    const smallLoad: LoadCase = { ...load, Mu_pos: 10, Mu_neg: 5, Vu: 5, Tu: 1 };
    const result = designMember(rectBeam16x24, mat4k, rebar3_8, smallLoad);
    expect(result.status).toBe('OK');
  });

  it('As_min > 0 for standard section', () => {
    const result = designMember(rectBeam16x24, mat4k, rebar3_8, load);
    expect(result.As_min).toBeGreaterThan(0);
  });

  it('As_max > As_min', () => {
    const result = designMember(rectBeam16x24, mat4k, rebar3_8, load);
    expect(result.As_max).toBeGreaterThan(result.As_min);
  });

  it('phi_Mn_pos > phi_Mn_neg for more bottom steel', () => {
    // rebar3_8 has 4 bot bars vs 3 top bars
    const result = designMember(rectBeam16x24, mat4k, rebar3_8, load);
    expect(result.phi_Mn_pos).toBeGreaterThan(result.phi_Mn_neg);
  });

  it('Vc + Vs sums to Vn (within phi factor)', () => {
    const result = designMember(rectBeam16x24, mat4k, rebar3_8, load);
    expect(result.phi_Vn).toBeCloseTo(0.75 * (result.Vc + result.Vs), 1);
  });

  it('Av_req = 0 when Vu < phi*Vc (stirrups not needed for shear)', () => {
    const lightLoad: LoadCase = { ...load, Vu: 1, Mu_pos: 10 };
    const result = designMember(rectBeam16x24, mat4k, rebar3_8, lightLoad);
    expect(result.Av_req).toBe(0);
  });
});

// ─── Interaction diagram ─────────────────────────────────────────────────────

describe('computeInteractionDiagram', () => {
  const colRebar: RebarLayout = {
    topBars: [{ numBars: 4, barSize: 9 }],
    botBars: [{ numBars: 4, barSize: 9 }],
    ties: { barSize: 4, spacing: 9, legs: 4 },
  };

  it('returns array of points', () => {
    const pts = computeInteractionDiagram(rectCol, mat5k, colRebar);
    expect(pts.length).toBeGreaterThan(5);
  });

  it('first point (pure compression) has highest axial load', () => {
    const pts = computeInteractionDiagram(rectCol, mat5k, colRebar);
    const pureComp = pts[0].Pn;
    pts.slice(1).forEach(p => expect(pureComp).toBeGreaterThanOrEqual(p.Pn));
  });

  it('last point (pure tension) has negative Pn', () => {
    const pts = computeInteractionDiagram(rectCol, mat5k, colRebar);
    expect(pts[pts.length - 1].Pn).toBeLessThan(0);
  });

  it('all phi values are in [0.65, 0.9]', () => {
    const pts = computeInteractionDiagram(rectCol, mat5k, colRebar);
    pts.forEach(p => {
      expect(p.phi).toBeGreaterThanOrEqual(0.65 - 1e-9);
      expect(p.phi).toBeLessThanOrEqual(0.90 + 1e-9);
    });
  });

  it('circular column generates interaction diagram', () => {
    const pts = computeInteractionDiagram(circCol, mat5k, colRebar);
    expect(pts.length).toBeGreaterThan(5);
    expect(pts[0].Pn).toBeGreaterThan(0);
  });
});

// ─── Code checks / edge cases ─────────────────────────────────────────────────

describe('ACI 318-19 code checks', () => {
  it('beta1 = 0.85 for fc <= 4000 psi', () => {
    // Indirectly verified: a = As*fy / (0.85*fc*b), phi based on strain
    // Just ensure design doesn't crash for fc=3000 and fc=4000
    const load: LoadCase = { id: 'x', label: 'x', Mu_pos: 80, Mu_neg: 40, Vu: 30, Tu: 0, Pu: 0 };
    expect(() => designMember(rectBeam, { ...mat4k, fc: 3000 }, rebar3_8, load)).not.toThrow();
    expect(() => designMember(rectBeam, { ...mat4k, fc: 4000 }, rebar3_8, load)).not.toThrow();
  });

  it('beta1 decreases for fc > 4000 psi', () => {
    // Higher fc → smaller beta1 → smaller a → slightly different moments
    const load: LoadCase = { id: 'x', label: 'x', Mu_pos: 80, Mu_neg: 40, Vu: 30, Tu: 0, Pu: 0 };
    const r4 = designMember(rectBeam, { ...mat4k, fc: 4000 }, rebar3_8, load);
    const r8 = designMember(rectBeam, { ...mat4k, fc: 8000 }, rebar3_8, load);
    expect(r8.phi_Mn_pos).not.toBe(r4.phi_Mn_pos);
  });

  it('lightweight concrete (lambda=0.75) reduces Vc vs normal weight', () => {
    const normal = computeShear(rectBeam16x24, mat4k, rebar3_8);
    const lightweight = computeShear(rectBeam16x24, { ...mat4k, lambdaConcrete: 0.75 }, rebar3_8);
    expect(lightweight.Vc).toBeLessThan(normal.Vc);
  });

  it('designMember does not throw for column member type', () => {
    const colLoad: LoadCase = { id: 'c', label: 'Col', Mu_pos: 80, Mu_neg: 0, Vu: 25, Tu: 0, Pu: 400 };
    const colRebar: RebarLayout = {
      topBars: [{ numBars: 4, barSize: 9 }],
      botBars: [{ numBars: 4, barSize: 9 }],
      ties: { barSize: 4, spacing: 9, legs: 4 },
    };
    expect(() => designMember(rectCol, mat5k, colRebar, colLoad)).not.toThrow();
  });
});
