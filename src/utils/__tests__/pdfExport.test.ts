/**
 * PDF export: Unicode font rendering + full-project smoke test (beam, circular
 * column — including labels/warnings with Greek/math characters).
 * DejaVu Sans is embedded so Greek/subscript/superscript render natively;
 * winAnsiSafe now only strips C0/C1 control chars.
 */
/// <reference types="node" />
import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import { winAnsiSafe, buildReportBytes, setFontLoader } from '../export/pdfExport';
import type { Project, Member } from '../../types';

// Register a Node.js font loader so tests don't need a live HTTP server.
beforeAll(() => {
  setFontLoader(async () => ({
    regular: readFileSync(path.resolve('public/fonts/DejaVuSans.ttf')).buffer as ArrayBuffer,
    bold:    readFileSync(path.resolve('public/fonts/DejaVuSans-Bold.ttf')).buffer as ArrayBuffer,
  }));
});

describe('winAnsiSafe', () => {
  it('passes Greek letters through unchanged (rendered natively by DejaVu)', () => {
    expect(winAnsiSafe('φMn+ (k-ft)')).toBe('φMn+ (k-ft)');
    expect(winAnsiSafe('ρw and λs and εt')).toBe('ρw and λs and εt');
  });

  it('passes non-ASCII through unchanged', () => {
    expect(winAnsiSafe('好')).toBe('好');
  });

  it('strips C0/C1 control characters', () => {
    expect(winAnsiSafe('ab\x01\x1Fcd')).toBe('abcd');
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
  return {
    id: 'p1', name: 'Smoke φ Project', code: 'ACI318-19',
    description: '', engineer: 'QA', date: '2026-06-11',
    members: [beam],
  };
}

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
