import { describe, it, expect } from 'vitest';
import { autoSizeColumnSection, describeColumnSection } from '../autoSizeColumn';

describe('autoSizeColumnSection', () => {
  it('sizes a tied rectangular column for axial demand (Pu=800k → 20×20)', () => {
    const s = autoSizeColumnSection({ governingPuKip: 800, fcPsi: 4000, fyPsi: 60000, targetDCR: 0.9, rho: 0.02 })!;
    // K = 0.65·0.80·(0.85·4000·0.98 + 60000·0.02) = 2356.64 psi
    // Ag,req = 800000 / (0.9·2356.64) = 377.2 in²
    expect(s.AgReq).toBeCloseTo(377.2, 0);
    expect(s.b).toBe(20);
    expect(s.h).toBe(20);
    expect(s.AgProvided).toBe(400);
    expect(s.shape).toBe('rectangular');
  });

  it('rounds up to even inches and provides ≥ required area', () => {
    const s = autoSizeColumnSection({ governingPuKip: 650, fcPsi: 5000, fyPsi: 60000 })!;
    expect(s.b % 2).toBe(0);
    expect(s.h % 2).toBe(0);
    expect(s.AgProvided).toBeGreaterThanOrEqual(s.AgReq);
  });

  it('sizes a circular column from the area', () => {
    const s = autoSizeColumnSection({ governingPuKip: 800, fcPsi: 4000, fyPsi: 60000, targetDCR: 0.9, rho: 0.02, shape: 'circular' })!;
    expect(s.shape).toBe('circular');
    expect(s.diameter).toBe(22);          // ceil_even(sqrt(4·377.2/π)=21.9)
    expect(s.AgProvided).toBeCloseTo(Math.PI * 22 * 22 / 4, 6);
  });

  it('uses the higher spiral capacity factors (smaller section)', () => {
    const tied = autoSizeColumnSection({ governingPuKip: 800, fcPsi: 4000, fyPsi: 60000, spiral: false })!;
    const spiral = autoSizeColumnSection({ governingPuKip: 800, fcPsi: 4000, fyPsi: 60000, spiral: true })!;
    expect(spiral.AgReq).toBeLessThan(tied.AgReq);
  });

  it('forces an enlargement past the current (P-M-governed) section', () => {
    // Axial size would be ~20×20, but the failing section is already 24×24.
    const s = autoSizeColumnSection({ governingPuKip: 800, fcPsi: 4000, fyPsi: 60000, currentBIn: 24, currentHIn: 24 })!;
    expect(s.b).toBeGreaterThanOrEqual(26);
    expect(s.h).toBeGreaterThanOrEqual(26);
  });

  it('returns null when the demand exceeds the max dimension', () => {
    expect(autoSizeColumnSection({ governingPuKip: 100000, fcPsi: 4000, fyPsi: 60000 })).toBeNull();
  });

  it('describeColumnSection renders geometry + ρ', () => {
    expect(describeColumnSection({ shape: 'rectangular', b: 24, h: 24, AgReq: 1, AgProvided: 576, rho: 0.02, governingPuKip: 800 }))
      .toBe('24×24" (ρ≈2%)');
    expect(describeColumnSection({ shape: 'circular', b: 22, h: 22, diameter: 22, AgReq: 1, AgProvided: 380, rho: 0.025, governingPuKip: 800 }))
      .toBe('Ø22" (ρ≈3%)');
  });
});
