/**
 * Confirms the renderer → main IPC boundary: the .SCO files extracted for the
 * design groups are the exact payload handed to the S-Concrete batch RUN, and
 * the parsed .SCRS comes back. The real run (electron/sconcreteBridge.cjs:
 * write files → drive BatchReporter via the bundled SConcreteHelper.exe →
 * read SConcreteResults.SCRS) only executes on Windows with S-Concrete, so here
 * the bridge is mocked and we assert the wiring around it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { hasSconcrete, generateScoFiles, runScoBatch, rerunScoBatch } from '../sconcreteClient';
import { collectGroupScoFiles, parseBatchResults } from '../scoBatch';
import type { Member, DesignGroup } from '../../../types';

type Call = { method: string; args: unknown };
let calls: Call[];
let mockReturn: unknown;

function installBridge(impl?: (method: string, args: unknown) => unknown) {
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      sconcrete: (method: string, args: unknown) => {
        calls.push({ method, args });
        return Promise.resolve(impl ? impl(method, args) : mockReturn);
      },
    },
  };
}

beforeEach(() => { calls = []; mockReturn = {}; });
afterEach(() => { delete (globalThis as { window?: unknown }).window; vi.restoreAllMocks(); });

const beam = (id: string, label: string): Member => ({
  id, label, memberType: 'beam',
  material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 },
  section: { type: 'rectangular_beam', b: 14, h: 24, coverClear: 1.5, stirrupDia: 4 },
  rebar: { topBars: [{ numBars: 2, barSize: 8 }], botBars: [{ numBars: 3, barSize: 9 }], ties: { barSize: 4, spacing: 6, legs: 2 } },
  loads: [{ id: 'LC1', label: '1.2D+1.6L', Mu_pos: 180, Mu_neg: -90, Vu: 45, Tu: 8, Pu: 0 }],
  span: 20,
});
const group = (id: string, label: string, memberIds: string[]): DesignGroup => ({ id, label, memberIds });

describe('hasSconcrete', () => {
  it('is false without the desktop bridge, true with it', () => {
    (globalThis as { window?: unknown }).window = {};
    expect(hasSconcrete()).toBe(false);
    installBridge();
    expect(hasSconcrete()).toBe(true);
  });
});

describe('runScoBatch — the group .SCO files reach the batch run', () => {
  it('forwards the extracted files and the run config to the IPC "run" method', async () => {
    installBridge();
    const members = [beam('b1', 'B1'), beam('b2', 'B2')];
    const files = collectGroupScoFiles([group('g', 'Perimeter', ['b1', 'b2'])], members, 'ACI318-19');
    const cfg = { outDir: '/scos', title: 'T', engineer: 'EOR' };

    await runScoBatch(files, cfg);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('run');
    const args = calls[0].args as { files: typeof files; outDir: string };
    // The SAME .SCO files (text + names) the group produced are what the run consumes.
    expect(args.files.map(f => f.fileName)).toEqual(['B1.SCO', 'B2.SCO']);
    expect(args.files.map(f => f.text)).toEqual(files.map(f => f.text));
    expect(args.files[0].text).toContain('@Object@S-CONCRETE Sectional Loads@');  // forces table present
    expect(args.outDir).toBe('/scos');
  });

  it('returns the bridge result, and the .SCRS parses back to per-member results', async () => {
    const scrs = ['File: B1.SCO', '  OK', '  N vs M Util ...... 0.62',
      'File: B2.SCO', '  OVERSTRESSED', '  N vs M Util ...... 1.08'].join('\n');
    installBridge(() => ({ exitCode: 0, scoCount: 2, scrsPath: '/scos/SConcreteResults.SCRS', scrsText: scrs, stderr: '' }));

    const files = collectGroupScoFiles([group('g', 'G', ['b1', 'b2'])], [beam('b1', 'B1'), beam('b2', 'B2')], 'ACI318-19');
    const out = await runScoBatch(files, { outDir: '/scos' });

    expect(out.scoCount).toBe(2);
    const byName = parseBatchResults(out.scrsText!);
    expect(byName.B1.status).toBe('OK');
    expect(byName.B2.nmUtil).toBeCloseTo(1.08, 6);
  });

  it('generateScoFiles writes (no run) via the "generate" method', async () => {
    installBridge(() => ({ outDir: '/scos', scoCount: 1 }));
    const files = collectGroupScoFiles([group('g', 'G', ['b1'])], [beam('b1', 'B1')], 'ACI318-19');
    await generateScoFiles(files, '/scos');
    expect(calls[0].method).toBe('generate');
    expect((calls[0].args as { files: unknown[] }).files).toHaveLength(1);
  });

  it('throws a helpful error when the desktop bridge is absent', async () => {
    (globalThis as { window?: unknown }).window = {};  // no electronAPI
    await expect(runScoBatch([], { outDir: '' }))
      .rejects.toThrow(/Windows desktop app/);
  });
});

describe('rerunScoBatch — re-run an existing folder (edits preserved)', () => {
  it('calls the "rerun" method with the config and NO files payload', async () => {
    installBridge(() => ({ exitCode: 0, scoCount: 3, scrsPath: '/scos/SConcreteResults.SCRS', scrsText: '', stderr: '' }));
    await rerunScoBatch({ outDir: '/scos', title: 'T', engineer: 'EOR' });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('rerun');
    const args = calls[0].args as { files?: unknown; outDir: string };
    expect(args.files).toBeUndefined();   // nothing is re-written — the folder is used as-is
    expect(args.outDir).toBe('/scos');
  });

  it('returns the bridge result and the fresh .SCRS parses back', async () => {
    const scrs = ['File: Perimeter.SCO', '  OK', '  N vs M Util ...... 0.71'].join('\n');
    installBridge(() => ({ exitCode: 0, scoCount: 1, scrsPath: '/scos/SConcreteResults.SCRS', scrsText: scrs, stderr: '' }));
    const out = await rerunScoBatch({ outDir: '/scos' });
    expect(out.scoCount).toBe(1);
    expect(parseBatchResults(out.scrsText!).Perimeter.status).toBe('OK');
  });

  it('throws when the desktop bridge is absent', async () => {
    (globalThis as { window?: unknown }).window = {};
    await expect(rerunScoBatch({ outDir: '' }))
      .rejects.toThrow(/Windows desktop app/);
  });
});
