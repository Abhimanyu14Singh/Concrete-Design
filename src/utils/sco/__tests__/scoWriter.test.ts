/**
 * Byte-for-byte validation of the TS .SCO writer against the Python reference
 * (Column_Design_DW/sco_writer.py via parity/export_sco_reference.py).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildColumnScoText, pyG, type ColumnScoParams } from '../scoWriter';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fixture: any = JSON.parse(
  readFileSync(new URL('./fixtures/scoReference.json', import.meta.url), 'utf-8'),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapKwargs(k: any): ColumnScoParams {
  return {
    memberName: k.member_name,
    bIn: k.b_in,
    hIn: k.h_in,
    fcKsi: k.fc_ksi,
    fyKsi: k.fy_ksi,
    nzBars: k.nz_bars,
    nyBars: k.ny_bars,
    longBar: k.long_bar,
    tieBar: k.tie_bar,
    tieSpacingIn: k.tie_spacing_in,
    coverIn: k.cover_in,
    shape: k.shape,
    forces: k.forces,
    loadCases: k.load_cases,
  };
}

/** Index + context of the first differing character (or -1 if equal). */
function firstDiff(a: string, b: string): { idx: number; aCtx: string; bCtx: string } {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return { idx: i, aCtx: JSON.stringify(a.slice(i - 25, i + 25)), bCtx: JSON.stringify(b.slice(i - 25, i + 25)) };
    }
  }
  if (a.length !== b.length) {
    return { idx: n, aCtx: JSON.stringify(a.slice(n - 25, n + 25)), bCtx: JSON.stringify(b.slice(n - 25, n + 25)) };
  }
  return { idx: -1, aCtx: '', bCtx: '' };
}

describe('pyG (Python %.4g)', () => {
  it('matches Python for the values used in the fixtures', () => {
    expect(pyG(0)).toBe('0');
    expect(pyG(5)).toBe('5');
    expect(pyG(5.0)).toBe('5');
  });
  it('handles fractional and large magnitudes like Python %g', () => {
    expect(pyG(0.5)).toBe('0.5');
    expect(pyG(12000)).toBe('1.2e+04'); // exponential branch (torsion never reaches this)
  });
});

describe('buildColumnScoText — byte-for-byte vs Python', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of fixture.cases as any[]) {
    it(`${c.id} matches the reference exactly`, () => {
      const ts = buildColumnScoText(mapKwargs(c.kwargs));
      if (ts !== c.sco_text) {
        const d = firstDiff(ts, c.sco_text);
        throw new Error(
          `Mismatch at char ${d.idx} (ts len ${ts.length}, ref len ${c.sco_text.length})\n` +
          `  ts : ${d.aCtx}\n  ref: ${d.bCtx}`,
        );
      }
      expect(ts).toBe(c.sco_text);
    });
  }
});
