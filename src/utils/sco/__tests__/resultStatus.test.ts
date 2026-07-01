/**
 * Status/DCR derivation for the S-Concrete results table. The key case: an EC2
 * batch report with NO "OK/OVERSTRESSED" status line (status === null) but
 * utilizations above 1.0 must still read "NG", not a blank "—" (the bug the
 * results table showed before this change).
 */
import { describe, it, expect } from 'vitest';
import { governingDcr, dcrTone, statusView, summarize } from '../resultStatus';

describe('governingDcr', () => {
  it('takes the worse of N-M and shear+torsion, and names the governing check', () => {
    expect(governingDcr({ nmUtil: 1.078, vtUtil: 0.42 })).toEqual({ dcr: 1.078, by: 'N-M' });
    expect(governingDcr({ nmUtil: 0.30, vtUtil: 0.95 })).toEqual({ dcr: 0.95, by: 'V&T' });
  });

  it('handles a missing utilization on either side', () => {
    expect(governingDcr({ nmUtil: 0.8, vtUtil: null })).toEqual({ dcr: 0.8, by: 'N-M' });
    expect(governingDcr({ nmUtil: null, vtUtil: 0.6 })).toEqual({ dcr: 0.6, by: 'V&T' });
    expect(governingDcr({ nmUtil: null, vtUtil: null })).toEqual({ dcr: null, by: null });
  });
});

describe('dcrTone', () => {
  it('classifies safe / near / over / unknown', () => {
    expect(dcrTone(0.5)).toBe('ok');
    expect(dcrTone(0.89)).toBe('ok');
    expect(dcrTone(0.9)).toBe('warn');   // near-capacity threshold is inclusive
    expect(dcrTone(1.0)).toBe('warn');   // exactly at capacity is "near", not over
    expect(dcrTone(1.001)).toBe('ng');
    expect(dcrTone(null)).toBe('none');
  });
});

describe('statusView', () => {
  it('uses the reported .SCRS status when present (not derived)', () => {
    expect(statusView({ status: 'OK', nmUtil: 0.8, vtUtil: 0.2 })).toEqual({ text: 'OK', tone: 'ok', derived: false });
    expect(statusView({ status: 'OVERSTRESSED', nmUtil: 1.2, vtUtil: 0.2 })).toEqual({ text: 'OVERSTRESSED', tone: 'ng', derived: false });
    expect(statusView({ status: 'WARNING', nmUtil: 0.5, vtUtil: 0.5 })).toEqual({ text: 'WARNING', tone: 'warn', derived: false });
  });

  it('derives NG from the DCR when the report has no status line (the EC2 case)', () => {
    // These are the exact utilizations from the user's screenshot — status null.
    for (const nm of [1.078, 1.002, 1.055, 1.054, 1.068]) {
      expect(statusView({ status: null, nmUtil: nm, vtUtil: 0.3 })).toEqual({ text: 'NG', tone: 'ng', derived: true });
    }
  });

  it('derives Near / OK from the DCR when there is no status line', () => {
    expect(statusView({ status: null, nmUtil: 0.93, vtUtil: 0.1 })).toEqual({ text: 'Near', tone: 'warn', derived: true });
    expect(statusView({ status: null, nmUtil: 0.42, vtUtil: 0.1 })).toEqual({ text: 'OK', tone: 'ok', derived: true });
  });

  it('shows "—" (not derived) when neither status nor utilizations exist', () => {
    expect(statusView({ status: null, nmUtil: null, vtUtil: null })).toEqual({ text: '—', tone: 'none', derived: false });
  });

  it('treats blank/whitespace status as absent and derives instead', () => {
    expect(statusView({ status: '   ', nmUtil: 1.1, vtUtil: 0.2 })).toEqual({ text: 'NG', tone: 'ng', derived: true });
  });
});

describe('summarize', () => {
  it('rolls a result set up into per-tone counts', () => {
    const results = [
      { status: null, nmUtil: 1.078, vtUtil: 0.3 }, // ng
      { status: null, nmUtil: 1.002, vtUtil: 0.3 }, // ng
      { status: null, nmUtil: 0.92, vtUtil: 0.3 },  // warn
      { status: 'OK', nmUtil: 0.5, vtUtil: 0.3 },   // ok
      { status: null, nmUtil: null, vtUtil: null },  // none
    ];
    expect(summarize(results)).toEqual({ ok: 1, warn: 1, ng: 2, none: 1 });
  });
});
