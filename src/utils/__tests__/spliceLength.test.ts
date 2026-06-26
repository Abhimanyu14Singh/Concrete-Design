import { describe, it, expect } from 'vitest';
import { spliceLengthIn, spliceClause } from '../spliceLength';

describe('spliceLengthIn — compression lap (§25.5.5.1)', () => {
  it('Grade 60, #8: 0.0005·fy·db = 30 in', () => {
    expect(spliceLengthIn({ barSize: 8, spliceType: 'Compression', fcPsi: 4000, fyPsi: 60000 })!)
      .toBeCloseTo(30.0, 6);
  });
  it('Grade 75, #8: (0.0009·fy − 24)·db = 43.5 in', () => {
    expect(spliceLengthIn({ barSize: 8, spliceType: 'Compression', fcPsi: 4000, fyPsi: 75000 })!)
      .toBeCloseTo(43.5, 6);
  });
  it("applies the ×1.33 factor when f'c < 3000 psi", () => {
    expect(spliceLengthIn({ barSize: 8, spliceType: 'Compression', fcPsi: 2500, fyPsi: 60000 })!)
      .toBeCloseTo(30.0 * 1.33, 6);
  });
  it('floors at 12 in for a small bar (#3: 0.0005·60000·0.375 = 11.25 → 12)', () => {
    expect(spliceLengthIn({ barSize: 3, spliceType: 'Compression', fcPsi: 4000, fyPsi: 60000 })!)
      .toBe(12);
  });
});

describe('spliceLengthIn — tension lap (§25.4.2.3 + §25.5.2.1)', () => {
  it('Class B (#8) ≈ 1.3 × ld', () => {
    const b = spliceLengthIn({ barSize: 8, spliceType: 'Tension B', fcPsi: 4000, fyPsi: 60000 })!;
    const a = spliceLengthIn({ barSize: 8, spliceType: 'Tension A', fcPsi: 4000, fyPsi: 60000 })!;
    expect(b).toBeCloseTo(a * 1.3, 6);
    expect(a).toBeCloseTo(40.66, 1);
  });
  it("'Lap' is an alias for Class B", () => {
    const lap = spliceLengthIn({ barSize: 8, spliceType: 'Lap', fcPsi: 4000, fyPsi: 60000 })!;
    const b = spliceLengthIn({ barSize: 8, spliceType: 'Tension B', fcPsi: 4000, fyPsi: 60000 })!;
    expect(lap).toBeCloseTo(b, 9);
  });
  it('uses ψs = 0.8 and clamps the confinement ratio for a #5 bar', () => {
    // db 0.625 ≤ 0.75 → ψs 0.8; ratio clamps to 2.5
    const a = spliceLengthIn({ barSize: 5, spliceType: 'Tension A', fcPsi: 4000, fyPsi: 60000 })!;
    expect(a).toBeCloseTo(14.23, 1);
  });
});

describe('spliceLengthIn — no lap length', () => {
  it.each(['None', 'Tangential', 'Bearing', 'Mech/Weld', 'Mechanical'] as const)(
    'returns null for %s', (t) => {
      expect(spliceLengthIn({ barSize: 8, spliceType: t, fcPsi: 4000, fyPsi: 60000 })).toBeNull();
    },
  );
});

describe('spliceClause', () => {
  it('maps each splice type to its ACI clause', () => {
    expect(spliceClause('Compression')).toBe('ACI §25.5.5.1');
    expect(spliceClause('Tension A')).toBe('ACI §25.5.2.1 (Class A)');
    expect(spliceClause('Tension B')).toBe('ACI §25.5.2.1 (Class B)');
    expect(spliceClause('Lap')).toBe('ACI §25.5.2.1 (Class B)');
  });
});
