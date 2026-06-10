import { describe, it, expect } from 'vitest';
import { circularSegment, grossArea } from '../../column/sectionModel';
import {
  aciInteractionCurve, capacityOnRay, aciBiaxialCheck,
  aciColumnShear, aciColumnDetailing, designColumnACI, totalAst,
} from '../aciColumn';
import type { SectionDimensions, MaterialProps, RebarLayout, LoadCase } from '../../../types';

const mat4k: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1.0 };

// 18×18 tied column, 8 #8 (Ast = 6.32 in²): 3 top + 3 bot + 2 side
const rectCol: SectionDimensions = {
  type: 'rectangular_column', b: 18, h: 18, coverClear: 1.5, stirrupDia: 4,
};
const rectRebar: RebarLayout = {
  topBars: [{ numBars: 3, barSize: 8 }],
  botBars: [{ numBars: 3, barSize: 8 }],
  sideBars: [{ numBars: 2, barSize: 8 }],
  ties: { barSize: 4, spacing: 12, legs: 2 },
};

// Ø20 circular, 8 #8, spiral
const circCol: SectionDimensions = {
  type: 'circular_column', b: 20, h: 20, diameter: 20, coverClear: 1.5, stirrupDia: 4,
};
const circRebar: RebarLayout = {
  topBars: [{ numBars: 8, barSize: 8 }],
  botBars: [],
  ties: { barSize: 4, spacing: 3, legs: 2 },
  tieType: 'spiral',
};

describe('circularSegment', () => {
  it('full circle: a = D gives A = πR², centroid at center', () => {
    const { A, yBar } = circularSegment(20, 20);
    expect(A).toBeCloseTo(Math.PI * 100, 5);
    expect(yBar).toBeCloseTo(10, 5);
  });

  it('half circle: a = R gives A = πR²/2, centroid R − 4R/(3π) from face', () => {
    const { A, yBar } = circularSegment(10, 20);
    expect(A).toBeCloseTo(Math.PI * 50, 5);
    expect(yBar).toBeCloseTo(10 - 40 / (3 * Math.PI), 5);
  });

  it('zero depth gives zero area', () => {
    const { A } = circularSegment(0, 20);
    expect(A).toBe(0);
  });

  it('clamps a > D to full circle', () => {
    const { A } = circularSegment(25, 20);
    expect(A).toBeCloseTo(Math.PI * 100, 5);
  });
});

describe('aciInteractionCurve — pure compression', () => {
  it('hand-check Pn0 and φPn,max for 18×18, 8#8, fc 4000', () => {
    // Ast = 8 × 0.79 = 6.32 in², Ag = 324 in²
    // Pn0 = [0.85·4000·(324 − 6.32) + 60000·6.32] / 1000 = 1080.1 + 379.2 = 1459.3 kips
    // φPn,max = 0.65 · 0.80 · 1459.3 = 758.8 kips
    const curve = aciInteractionCurve(rectCol, mat4k, rectRebar);
    const top = curve[curve.length - 1];
    expect(top.Pn).toBeCloseTo(1459.3, 0);
    expect(top.phiPn).toBeCloseTo(758.8, 0);
  });

  it('spiral column uses 0.85 cap and φ = 0.75', () => {
    const curve = aciInteractionCurve(circCol, mat4k, circRebar);
    const top = curve[curve.length - 1];
    const Ag = Math.PI * 100;
    const Ast = 8 * 0.79;
    const Pn0 = (0.85 * 4000 * (Ag - Ast) + 60000 * Ast) / 1000;
    expect(top.Pn).toBeCloseTo(Pn0, 0);
    expect(top.phiPn).toBeCloseTo(0.75 * 0.85 * Pn0, 0);
  });
});

describe('aciInteractionCurve — shape', () => {
  it('moment is ~0 at both pure tension and pure compression, positive between', () => {
    const curve = aciInteractionCurve(rectCol, mat4k, rectRebar);
    expect(curve[0].Mn).toBeCloseTo(0, 5);
    expect(curve[curve.length - 1].Mn).toBeCloseTo(0, 5);
    const maxMn = Math.max(...curve.map(p => p.Mn));
    expect(maxMn).toBeGreaterThan(100); // 18×18 8#8 has hundreds of kip-ft
  });

  it('pure tension anchor = −Ast·fy', () => {
    const curve = aciInteractionCurve(rectCol, mat4k, rectRebar);
    expect(curve[0].Pn).toBeCloseTo(-6.32 * 60, 1);
  });

  it('φ transitions from 0.65 (compression) toward 0.90 (tension-controlled)', () => {
    const curve = aciInteractionCurve(rectCol, mat4k, rectRebar);
    const phis = curve.map(p => p.phi);
    expect(Math.min(...phis)).toBeCloseTo(0.65, 5);
    expect(Math.max(...phis)).toBeCloseTo(0.90, 5);
  });
});

describe('capacityOnRay', () => {
  const curve = aciInteractionCurve(rectCol, mat4k, rectRebar);

  it('pure axial demand compares to φPn,max', () => {
    const phiPnMax = Math.max(...curve.map(p => p.phiPn));
    const r = capacityOnRay(curve, 500, 0);
    expect(r.dcr).toBeCloseTo(500 / phiPnMax, 3);
  });

  it('DCR scales linearly with demand along the same ray', () => {
    const r1 = capacityOnRay(curve, 200, 100);
    const r2 = capacityOnRay(curve, 400, 200);
    expect(r2.dcr).toBeCloseTo(2 * r1.dcr, 4);
  });

  it('zero demand gives DCR 0', () => {
    expect(capacityOnRay(curve, 0, 0).dcr).toBe(0);
  });
});

describe('aciBiaxialCheck', () => {
  it('square section: Pnx = Pny for symmetric demand', () => {
    const curveX = aciInteractionCurve(rectCol, mat4k, rectRebar);
    const curveY = aciInteractionCurve(rectCol, mat4k, rectRebar, 40, true);
    const r = aciBiaxialCheck(curveX, curveY, 400, 80, 80, false);
    expect(r.method).toBe('bresler');
    expect(r.phiPnx).toBeCloseTo(r.phiPny, -1); // within ~10 kips (layouts differ slightly)
  });

  it('uniaxial path used when one moment ≈ 0 and matches ray DCR', () => {
    const curveX = aciInteractionCurve(rectCol, mat4k, rectRebar);
    const r = aciBiaxialCheck(curveX, null, 400, 100, 0, false);
    const ray = capacityOnRay(curveX, 400, 100);
    expect(r.method).toBe('uniaxial');
    expect(r.DCR_PM).toBeCloseTo(ray.dcr, 6);
  });

  it('circular column uses resultant moment', () => {
    const curve = aciInteractionCurve(circCol, mat4k, circRebar);
    const r1 = aciBiaxialCheck(curve, null, 300, 60, 80, true);
    const r2 = aciBiaxialCheck(curve, null, 300, 100, 0, true);
    expect(r1.method).toBe('circular-resultant');
    expect(r1.DCR_PM).toBeCloseTo(r2.DCR_PM, 4); // both resultant = 100
  });

  it('biaxial DCR exceeds either uniaxial DCR', () => {
    const curveX = aciInteractionCurve(rectCol, mat4k, rectRebar);
    const curveY = aciInteractionCurve(rectCol, mat4k, rectRebar, 40, true);
    const bi = aciBiaxialCheck(curveX, curveY, 400, 80, 80, false);
    const uniX = aciBiaxialCheck(curveX, curveY, 400, 80, 0, false);
    expect(bi.DCR_PM).toBeGreaterThan(uniX.DCR_PM);
  });
});

describe('aciColumnShear', () => {
  it('axial compression increases Vc', () => {
    const v0 = aciColumnShear(rectCol, mat4k, rectRebar, 50, 0);
    const v1 = aciColumnShear(rectCol, mat4k, rectRebar, 50, 400);
    expect(v1.Vc).toBeGreaterThan(v0.Vc);
  });

  it('hand-check Vc at Pu = 0: 2λ√fc·bw·d', () => {
    // bw = 18, d = 0.8·18 = 14.4 → Vc = 2·1·√4000·18·14.4/1000 = 32.78 kips
    const v = aciColumnShear(rectCol, mat4k, rectRebar, 0, 0);
    expect(v.Vc).toBeCloseTo(2 * Math.sqrt(4000) * 18 * 14.4 / 1000, 1);
  });

  it('circular uses bw = D, d = 0.8D', () => {
    const v = aciColumnShear(circCol, mat4k, circRebar, 0, 0);
    expect(v.Vc).toBeCloseTo(2 * Math.sqrt(4000) * 20 * 16 / 1000, 1);
  });
});

describe('aciColumnDetailing', () => {
  it('passes for the standard 8#8 18×18 layout', () => {
    // ρg = 6.32/324 = 1.95% ✓; ties #4@12 ≤ min(16×1.0, 48×0.5, 18) = 16 ✓
    const w = aciColumnDetailing(rectCol, rectRebar);
    expect(w.filter(x => x.severity === 'error')).toHaveLength(0);
  });

  it('flags ρ < 1%', () => {
    const skinny: RebarLayout = { ...rectRebar, topBars: [{ numBars: 2, barSize: 5 }], botBars: [{ numBars: 2, barSize: 5 }], sideBars: [] };
    const w = aciColumnDetailing(rectCol, skinny);
    expect(w.some(x => x.code.includes('10.6.1.1') && x.message.includes('< 1%'))).toBe(true);
  });

  it('flags tie spacing > 16db', () => {
    const wideTies: RebarLayout = { ...rectRebar, ties: { barSize: 4, spacing: 18, legs: 2 } };
    const w = aciColumnDetailing(rectCol, wideTies);
    expect(w.some(x => x.code.includes('25.7.2.1'))).toBe(true);
  });

  it('flags missing ties', () => {
    const noTies: RebarLayout = { ...rectRebar, ties: undefined };
    const w = aciColumnDetailing(rectCol, noTies);
    expect(w.some(x => x.code.includes('10.7.6'))).toBe(true);
  });
});

describe('designColumnACI', () => {
  const load: LoadCase = { id: 'LC1', label: '1.2D+1.6L', Mu_pos: 0, Mu_neg: 0, Vu: 35, Tu: 0, Pu: 450, Mux: 120, Muy: 60 };

  it('produces OK status for a reasonable design', () => {
    const r = designColumnACI(rectCol, mat4k, rectRebar, load);
    expect(r.status).toBe('OK');
    expect(r.DCR_PM).toBeGreaterThan(0);
    expect(r.DCR_PM).toBeLessThan(1);
    expect(r.interaction).toBeDefined();
    expect(r.interaction!.length).toBeGreaterThan(10);
  });

  it('NG when grossly overloaded', () => {
    const heavy: LoadCase = { ...load, Pu: 1200, Mux: 400 };
    const r = designColumnACI(rectCol, mat4k, rectRebar, heavy);
    expect(r.status).toBe('NG');
  });

  it('circular spiral column designs successfully', () => {
    const r = designColumnACI(circCol, mat4k, circRebar, { ...load, Pu: 400, Mux: 90, Muy: 0 });
    expect(r.phi_Pn_max).toBeGreaterThan(0);
    expect(r.DCR_PM).toBeGreaterThan(0);
  });

  it('totalAst counts all groups', () => {
    expect(totalAst(rectRebar)).toBeCloseTo(8 * 0.79, 4);
  });

  it('grossArea circular', () => {
    expect(grossArea(true, 20, 20, 20)).toBeCloseTo(Math.PI * 100, 4);
  });
});
