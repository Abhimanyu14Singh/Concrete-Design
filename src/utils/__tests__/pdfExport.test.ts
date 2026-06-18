/**
 * PDF export: WinAnsi sanitizer + full-project smoke test (beam, circular
 * column, and wall — including labels/warnings with Greek/math characters
 * that standard Helvetica cannot encode).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { winAnsiSafe, exportPDF, buildReportBytes } from '../export/pdfExport';
import type { Project, Member } from '../../types';

describe('winAnsiSafe', () => {
  it('maps Greek letters and math symbols to ASCII', () => {
    expect(winAnsiSafe('φMn+ (k-ft)')).toBe('phiMn+ (k-ft)');
    expect(winAnsiSafe('s ≤ d/2 and √f\'c with β₁')).toBe("s <= d/2 and sqrtf'c with beta1");
    expect(winAnsiSafe('Mu = 12 − 4')).toBe('Mu = 12 - 4'); // U+2212 minus
    expect(winAnsiSafe('ρw and λs and εt')).toBe('rhow and lambdas and epst');
  });

  it('replaces non-Latin-1 leftovers with ?', () => {
    expect(winAnsiSafe('好')).toBe('?');
  });

  it('leaves plain ASCII untouched', () => {
    const s = 'S-Concrete Design | ACI318-19 | Page 1 of 3';
    expect(winAnsiSafe(s)).toBe(s);
  });
});

function makeProject(): Project {
  const beam: Member = {
    id: 'B1', label: 'Beam φ test', memberType: 'beam',
    material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 },
    section: { type: 'rectangular_beam', b: 16, h: 24, coverClear: 1.5, stirrupDia: 4 },
    rebar: {
      topBars: [{ numBars: 2, barSize: 8 }],
      botBars: [{ numBars: 4, barSize: 8 }, { numBars: 2, barSize: 8 }], // 2 layers
      ties: { barSize: 4, spacing: 6, legs: 4 },
      layerClearSpacing: 0.5, // forces a §25.2.2 warning (contains ≤/" chars)
    },
    loads: [{ id: 'lc1', label: '1.2D+1.6L', Mu_pos: 200, Mu_neg: 80, Vu: 60, Tu: 5, Pu: 0 }],
    span: 24,
  };
  const col: Member = {
    id: 'C1', label: 'Circ col', memberType: 'column',
    material: { fc: 5000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 },
    section: { type: 'circular_column', b: 20, h: 20, diameter: 20, coverClear: 1.5, stirrupDia: 4 },
    rebar: {
      topBars: [{ numBars: 4, barSize: 9 }], botBars: [{ numBars: 4, barSize: 9 }],
      ties: { barSize: 4, spacing: 12, legs: 2 }, tieType: 'spiral',
    },
    loads: [{ id: 'lc1', label: 'G+Q', Mu_pos: 0, Mu_neg: 0, Vu: 30, Tu: 0, Pu: 400, Mux: 120, Muy: 60 }],
    span: 12,
  };
  const wall: Member = {
    id: 'W1', label: 'Core wall', memberType: 'wall',
    material: { fc: 6000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 },
    section: { type: 'shear_wall', b: 120, h: 12, lw: 120, tw: 12, hw: 180, coverClear: 0.75, stirrupDia: 4 },
    rebar: { topBars: [], botBars: [] },
    wallRebar: {
      vertBarSize: 5, vertSpacing: 12, horizBarSize: 5, horizSpacing: 12, numCurtains: 2,
      sbzBarSize: 8, sbzNumBars: 8, sbzTieBarSize: 4, sbzTieSpacing: 4, sbzTieLegs: 4, driftRatio: 0.01,
    },
    loads: [{ id: 'lc1', label: 'EQ', Mu_pos: 1500, Mu_neg: 0, Vu: 200, Tu: 0, Pu: 500 }],
    span: 15,
  };
  return {
    id: 'p1', name: 'Smoke φ Project', code: 'ACI318-19',
    description: '', engineer: 'QA', date: '2026-06-11',
    members: [beam, col, wall],
  };
}

describe('exportPDF smoke test', () => {
  let bytes: Uint8Array | null = null;

  beforeEach(() => {
    bytes = null;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (blob: Blob) => {
        // capture for size assertion
        void blob.arrayBuffer().then(b => { bytes = new Uint8Array(b); });
        return 'blob:test';
      },
      revokeObjectURL: () => {},
    });
    vi.stubGlobal('document', {
      createElement: () => ({ click: () => {}, set href(_: string) {}, set download(_: string) {} }),
    });
  });

  it('resolves without throwing for beam + circular column + wall with φ in labels', async () => {
    await expect(exportPDF(makeProject())).resolves.toBeUndefined();
    // allow the captured arrayBuffer microtask to settle
    await new Promise(r => setTimeout(r, 0));
    expect(bytes).not.toBeNull();
    expect((bytes as unknown as Uint8Array).length).toBeGreaterThan(1000);
    // %PDF header
    const head = String.fromCharCode(...(bytes as unknown as Uint8Array).slice(0, 4));
    expect(head).toBe('%PDF');
  });
});

describe('buildReportBytes options', () => {
  it('returns a valid PDF for a single-member, governing-only, calc-included report', async () => {
    const project = makeProject();
    const bytes = await buildReportBytes(project, {
      memberIds: ['B1'],
      governingOnly: true,
      includeDiagrams: true,
      includeCalcs: true,
      includeCrack: true,
      jobNumber: '2024-118',
      revision: 'A',
    });
    expect(bytes.length).toBeGreaterThan(1000);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('%PDF');
  });

  it('produces a smaller document when content sections are disabled', async () => {
    const project = makeProject();
    const full = await buildReportBytes(project, {
      governingOnly: false, includeDiagrams: true, includeCalcs: true, includeCrack: true,
    });
    const lean = await buildReportBytes(project, {
      governingOnly: true, includeDiagrams: false, includeCalcs: false, includeCrack: false,
    });
    expect(lean.length).toBeLessThan(full.length);
  });
});
