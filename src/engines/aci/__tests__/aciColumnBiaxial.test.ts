/**
 * Phase 1 validation: the ported rotating-NA biaxial solver (aciColumnBiaxial.ts)
 * must reproduce the Python reference `_biaxial_phi_mrtht` 1:1.
 *
 * The fixture's `python.biaxial_probe` array holds φMr (kip-ft) evaluated by the
 * Python solver at an axial sweep (0.15..0.9·φc·Po) for each rectangular case.
 * A faithful port should match to well within rounding.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { biaxialPhiMr, clipPolyU, polyAreaCuv, type BiaxialParams } from '../aciColumnBiaxial';
import { getBarArea, getBarDiam } from '../../../utils/concreteDesign';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fixture: any = JSON.parse(
  readFileSync(new URL('./fixtures/columnParity.json', import.meta.url), 'utf-8'),
);

const barNum = (s: string): number => parseInt(String(s).replace('#', ''), 10);
const DEG = Math.PI / 180;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function params(inp: any): BiaxialParams {
  return {
    b: inp.b,
    h: inp.h,
    fcKsi: inp.fc_ksi,
    fyKsi: inp.fy_ksi,
    cover: inp.cover,
    AbLong: getBarArea(barNum(inp.long_bar)),
    dbLong: getBarDiam(barNum(inp.long_bar)),
    dsTie: getBarDiam(barNum(inp.tie_bar)),
    nz: inp.nz,
    ny: inp.ny,
    tieType: inp.tie_type,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rectCases = (fixture.cases as any[]).filter((c) => (c.python.biaxial_probe ?? []).length > 0);

describe('aciColumnBiaxial — geometry helpers', () => {
  it('clipPolyU keeps a fully-inside square unchanged', () => {
    const sq: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];
    expect(clipPolyU(sq, 5)).toHaveLength(4);
  });
  it('clipPolyU clips a square to half-area at u=1', () => {
    const sq: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];
    const [A] = polyAreaCuv(clipPolyU(sq, 1));
    expect(A).toBeCloseTo(2, 6); // 1×2 strip
  });
  it('polyAreaCuv returns area + centroid of the unit square', () => {
    const [A, cu, cv] = polyAreaCuv([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(A).toBeCloseTo(1, 9);
    expect(cu).toBeCloseTo(0.5, 9);
    expect(cv).toBeCloseTo(0.5, 9);
  });
});

describe('aciColumnBiaxial — φMr matches Python rotating-NA solver 1:1', () => {
  for (const c of rectCases) {
    const p = params(c.inputs);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c.python.biaxial_probe as any[]).forEach((probe, i) => {
      it(`${c.id} [probe ${i}: Pu=${probe.Pu_kips}, θ=${probe.theta_deg}°]`, () => {
        const ts = biaxialPhiMr(probe.Pu_kips, probe.theta_deg * DEG, p);
        if (probe.phi_mr_kft == null) {
          expect(ts).toBeNull();
        } else {
          expect(ts).not.toBeNull();
          // 1:1 port — match to 0.1% (rel) or 0.05 kip-ft (abs), whichever is looser
          const rel = Math.abs((ts as number) - probe.phi_mr_kft) / Math.max(probe.phi_mr_kft, 1e-9);
          const abs = Math.abs((ts as number) - probe.phi_mr_kft);
          expect(rel < 1e-3 || abs < 0.05).toBe(true);
        }
      });
    });
  }
});
