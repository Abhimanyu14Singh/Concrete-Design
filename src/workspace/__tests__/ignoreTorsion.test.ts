/**
 * "Neglect torsion" has to reach EVERY surface that reports a DCR.
 *
 * The setting lives on the project and is honoured by `runDesign`, which zeroes Tu
 * before either beam engine sees it. But `runDesign` takes it as the NINTH POSITIONAL
 * argument, so a call site that simply stops short of it silently designs with torsion
 * — no type error, no warning, just a torsion DCR on a project that asked for none.
 *
 * That is exactly what happened to the workspace shell (the primary UI) and to every
 * export: the Excel and PDF reports even PRINT "Torsion — Neglected (Tu = 0)" in their
 * standards block while the DCRs beside it were computed with the full Tu.
 */
import { describe, it, expect } from 'vitest';
import { runDesign } from '../../engines';
import { designMemberAllRows } from '../design.js';
import { buildProjectWorkbook, buildDcrListWorkbook } from '../../utils/export/excelExport';
import type { Member, Project } from '../../types';

const member: Member = {
  id: 'B1', label: 'B1', memberType: 'beam', span: 24,
  material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1.0 },
  section: { type: 'rectangular_beam', b: 14, h: 24, coverClear: 1.5, stirrupDia: 4 },
  rebar: {
    topBars: [{ numBars: 2, barSize: 8 }],
    botBars: [{ numBars: 3, barSize: 8 }],
    ties: { barSize: 4, spacing: 10, legs: 2 },
  },
  // A torsion demand big enough that the check is unmistakably live.
  loads: [{ id: 'lc1', label: '1.2D+1.6L', Mu_pos: 150, Mu_neg: 90, Vu: 45, Tu: 40, Pu: 0 }],
};

const project = (ignoreTorsion: boolean) => ({
  id: 'p', name: 'P', code: 'ACI318-19', date: '2026-01-01',
  members: [member], ignoreTorsion,
} as unknown as Project);

/** Every numeric cell in a worksheet, so a DCR can be found without knowing the layout. */
const nums = (ws: Record<string, unknown>) =>
  Object.entries(ws).filter(([k]) => !k.startsWith('!'))
    .map(([, c]) => (c as { t?: string; v?: unknown }))
    .filter(c => c && c.t === 'n').map(c => c.v as number);

describe('the engine honours it (the part that already worked)', () => {
  it('zeroes Tu, so the torsion DCR collapses', () => {
    const on = runDesign(member.section, member.material, member.rebar, member.loads[0], member.span, 'ACI318-19');
    const off = runDesign(member.section, member.material, member.rebar, member.loads[0], member.span, 'ACI318-19', undefined, undefined, true);
    expect(on.DCR_torsion).toBeGreaterThan(0);
    expect(off.DCR_torsion).toBe(0);
  });
});

describe('the workspace shell honours it', () => {
  it('designs with Tu = 0 and drops the Torsion chip entirely', () => {
    const on = designMemberAllRows(member, 'ACI318-19');
    const off = designMemberAllRows(member, 'ACI318-19', { ignoreTorsion: true });

    expect(on.checks.map((c: { key: string }) => c.key)).toContain('torsion');
    expect(on.rows[0].result.DCR_torsion).toBeGreaterThan(0);

    // Not a chip reading 0.00 — the check is not being made, so it is not shown.
    expect(off.checks.map((c: { key: string }) => c.key)).not.toContain('torsion');
    expect(off.rows[0].result.DCR_torsion).toBe(0);
  });

  it('the headline DCR is no longer a torsion DCR', () => {
    const on = designMemberAllRows(member, 'ACI318-19');
    const off = designMemberAllRows(member, 'ACI318-19', { ignoreTorsion: true });
    expect(off.governing.dcr).toBeLessThanOrEqual(on.governing.dcr);
    expect(off.governing.key).not.toBe('torsion');
  });
});

describe('the exports honour it — they already claim to', () => {
  it('the DCR list reports no torsion', () => {
    const wbOn = buildDcrListWorkbook(project(false));
    const wbOff = buildDcrListWorkbook(project(true));
    const on = nums(wbOn.Sheets[wbOn.SheetNames[0]] as Record<string, unknown>);
    const off = nums(wbOff.Sheets[wbOff.SheetNames[0]] as Record<string, unknown>);
    // With torsion neglected, no cell in the sheet carries the torsion DCR.
    const torsionOn = Math.max(...on);
    expect(torsionOn).toBeGreaterThan(1);          // the member IS torsion-governed
    expect(Math.max(...off)).toBeLessThan(torsionOn);
  });

  it('the project workbook agrees with its own "Torsion: Neglected" header', () => {
    const wb = buildProjectWorkbook(project(true));
    const sheet = wb.Sheets[wb.SheetNames[1]] as Record<string, unknown>;   // the member sheet
    const cells = Object.entries(sheet).filter(([k]) => !k.startsWith('!'));
    const tu = cells.find(([, c]) => (c as { v?: unknown }).v === 40);
    expect(tu, 'Tu = 40 must not appear as a demand once torsion is neglected').toBeUndefined();
  });
});
