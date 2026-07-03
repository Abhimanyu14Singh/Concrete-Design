/**
 * Byte-for-byte validation of the circular-column .SCO writer against the Python
 * reference (Column_Design_DW `_write_circular_sco_v2026` dead-code build, via
 * Column_Design_DW/parity/export_circular_sco_reference.py → the committed
 * fixtures/circularScoReference.json — regenerate with that script).
 *
 * Same guarantee as scoWriter.test.ts for the rectangular writer: the TS output
 * must equal the Python output exactly, so the Version-2026.0 / Member-Type-4
 * structure and every substituted value (D, cage, materials, biaxial loads) are
 * reproduced. Biaxial shear (V2→Vfz, V3→Vfy) is checked explicitly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCircularColumnScoText, type CircularColumnScoParams } from '../scoWriterCircular';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fixture: any = JSON.parse(
  readFileSync(new URL('./fixtures/circularScoReference.json', import.meta.url), 'utf-8'),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapKwargs(k: any): CircularColumnScoParams {
  return {
    memberName: k.member_name,
    dIn: k.D_in,
    fcKsi: k.fc_ksi,
    fyKsi: k.fy_ksi,
    nBars: k.n_bars,
    longBar: k.long_bar,
    tieBar: k.tie_bar,
    tieSpacingIn: k.tie_spacing_in,
    coverIn: k.cover_in,
    loadCases: k.load_cases,
    luYyIn: k.lu_yy_in,
    luZzIn: k.lu_zz_in,
    fyTiesKsi: k.fy_ties_ksi,
  };
}

/** Index + context of the first differing character (or -1 if equal). */
function firstDiff(a: string, b: string): { idx: number; aCtx: string; bCtx: string } {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return { idx: i, aCtx: JSON.stringify(a.slice(i - 30, i + 30)), bCtx: JSON.stringify(b.slice(i - 30, i + 30)) };
    }
  }
  if (a.length !== b.length) {
    return { idx: n, aCtx: JSON.stringify(a.slice(n - 30, n + 30)), bCtx: JSON.stringify(b.slice(n - 30, n + 30)) };
  }
  return { idx: -1, aCtx: '', bCtx: '' };
}

describe('buildCircularColumnScoText — byte-for-byte vs Python', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of fixture.cases as any[]) {
    it(`${c.id} matches the reference exactly`, () => {
      const ts = buildCircularColumnScoText(mapKwargs(c.kwargs));
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

describe('buildCircularColumnScoText — key fields', () => {
  const t = buildCircularColumnScoText({
    memberName: 'C1', dIn: 24, fcKsi: 5.0, fyKsi: 60.0, nBars: 8,
    longBar: '#9', tieBar: '#4', tieSpacingIn: 12, coverIn: 1.5,
    loadCases: [{ P: -600, T: 5, V2: 45, M3: 120, V3: 28, M2: 80, comment: '1.2D+1.6L' }],
  });

  it('writes the Version 2026.0 / Member Type 4 header (circular)', () => {
    expect(t).toContain('Version\t2026.0\n');
    expect(t).toContain('Member Type\t 4\n');   // circular column
    expect(t).toContain('Codes\t 18\n');         // ACI 318-19
    expect(t).toContain('Units\t 0\n');          // imperial
  });

  it('sets the circular diameter on Cm D (and Cm bcol/hcol) plus the cage', () => {
    expect(t).toContain('Cm D\t 24\t');
    expect(t).toContain('Cm bcol\t 24\tCm hcol\t 24\t');
    expect(t).toContain('Cm Nzcol\t 8\t');       // total perimeter bars
    expect(t).toContain('Cm Nycol\t 7\t');       // max(2, nBars − 1)
    expect(t).toContain('Cm DVert\t 8\t');       // #9 → bar index 8
  });

  it('preserves biaxial shear: V2 → Vfz (strong), V3 → Vfy (weak)', () => {
    // Row cols: LC Nf Tf Vfz Mfy Cmy Vfy Mfz … → Vfz=c3, Vfy=c6.
    const row = t.split('\n').find((l) => /^\s*1\t/.test(l) && l.includes('1.2D+1.6L'))!;
    const c = row.split('\t').map((s) => s.trim());
    expect(c[3]).toBe('45.0');   // Vfz = V2 (strong)
    expect(c[4]).toBe('120.0');  // Mfy = M3 (Mux)
    expect(c[6]).toBe('28.0');   // Vfy = V3 (weak)
    expect(c[7]).toBe('80.0');   // Mfz = M2 (Muy)
  });

  it('clamps a sub-minimum bar count to 4 (n_bars_total floor)', () => {
    const t2 = buildCircularColumnScoText({
      memberName: 'Cx', dIn: 18, fcKsi: 4, fyKsi: 60, nBars: 3,
      longBar: '#8', tieBar: '#3', tieSpacingIn: 12,
    });
    expect(t2).toContain('Cm Nzcol\t 4\t');
  });
});
