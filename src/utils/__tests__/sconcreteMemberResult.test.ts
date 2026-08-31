import { describe, it, expect } from 'vitest';
import { memberScoSummary, scoAgreesWithApp } from '../sconcreteMemberResult';
import type { SconcreteResult } from '../../types';

const r = (over: Partial<SconcreteResult>): SconcreteResult => ({
  name: 'x', status: 'OK', nmUtil: 0.5, vtUtil: 0.4, memberIds: ['m1'], ...over,
});

describe('memberScoSummary', () => {
  it('returns null when no result covers the member', () => {
    expect(memberScoSummary([], 'm1')).toBeNull();
    expect(memberScoSummary([r({ memberIds: ['other'] })], 'm1')).toBeNull();
    expect(memberScoSummary(undefined, 'm1')).toBeNull();
  });

  it('summarises a single/ULS result covering the member', () => {
    const s = memberScoSummary([r({ kind: 'single', groupLabel: 'G', nmUtil: 0.7, vtUtil: 0.6 })], 'm1')!;
    expect(s.status).toBe('OK');
    expect(s.nmUtil).toBe(0.7);
    expect(s.vtUtil).toBe(0.6);
    expect(s.groupLabel).toBe('G');
    expect(s.crackStatus).toBeNull();
  });

  it('combines a ULS + crack result (EC2) — strength utils from ULS, crack from the crack row', () => {
    const uls = r({ kind: 'uls', groupLabel: 'B', nmUtil: 0.8, vtUtil: 0.5, status: 'OK' });
    const crack = r({ kind: 'crack', name: 'B_crack', status: 'OVERSTRESSED', nmUtil: 1.2, vtUtil: null });
    const s = memberScoSummary([uls, crack], 'm1')!;
    expect(s.nmUtil).toBe(0.8);            // strength row, not the crack row
    expect(s.crackStatus).toBe('NG');      // crack overstressed
    expect(s.status).toBe('NG');           // worst across covering results
  });

  it('flags NG when a util exceeds 1 even if the status text says OK', () => {
    expect(memberScoSummary([r({ status: 'OK', nmUtil: 1.05 })], 'm1')!.status).toBe('NG');
  });

  it('reads S-Concrete EN status words instead of testing for the literal "OK"', () => {
    // The EN reports never say "OK": a pass is "Acceptable", a pass carrying code
    // messages is "Warning", and only "Borderline" (util ≥ 1) is a real fail. A
    // `status !== 'OK'` test marked every passing EN member overstressed.
    const ok = memberScoSummary([r({ status: 'Acceptable', nmUtil: 0.7, vtUtil: 0.6 })], 'm1')!;
    expect(ok.status).toBe('OK');
    expect(ok.tone).toBe('ok');
    expect(ok.statusText).toBe('OK');

    const warn = memberScoSummary([r({ status: 'Warning', nmUtil: 0.7, vtUtil: 0.6 })], 'm1')!;
    expect(warn.status).toBe('OK');        // passed capacity…
    expect(warn.tone).toBe('warn');        // …but the card still shows it amber
    expect(warn.statusText).toBe('Warning');

    const ng = memberScoSummary([r({ status: 'Borderline', nmUtil: 1.05, vtUtil: 0.6 })], 'm1')!;
    expect(ng.status).toBe('NG');
    expect(ng.tone).toBe('ng');
  });

  it('takes the WORST tone and the WORST strength row across covering results', () => {
    // A zoned beam produces one strength file per stirrup spacing; `[0]` reported
    // whichever was written first rather than the governing one.
    const s = memberScoSummary([
      r({ kind: 'single', name: 'B_S8', status: 'Acceptable', nmUtil: 0.4, vtUtil: 0.5 }),
      r({ kind: 'single', name: 'B_S4', status: 'Warning', nmUtil: 0.9, vtUtil: 0.95 }),
    ], 'm1')!;
    expect(s.nmUtil).toBe(0.9);
    expect(s.vtUtil).toBe(0.95);
    expect(s.tone).toBe('warn');
    expect(s.status).toBe('OK');
  });

  it('does not call an "Acceptable" crack result NG', () => {
    const uls = r({ kind: 'uls', status: 'Acceptable', nmUtil: 0.8, vtUtil: 0.5 });
    const crack = r({ kind: 'crack', status: 'Acceptable', nmUtil: 0.2, vtUtil: null });
    const s = memberScoSummary([uls, crack], 'm1')!;
    expect(s.crackStatus).toBe('OK');
    expect(s.status).toBe('OK');
  });
});

describe('scoAgreesWithApp', () => {
  it('is null when there is no S-Concrete result', () => {
    expect(scoAgreesWithApp(null, 0.8)).toBeNull();
  });
  it('agrees when both pass or both fail; differs otherwise', () => {
    expect(scoAgreesWithApp('OK', 0.8)).toBe(true);    // both pass
    expect(scoAgreesWithApp('NG', 1.2)).toBe(true);    // both fail
    expect(scoAgreesWithApp('OK', 1.1)).toBe(false);   // app fails, S-Concrete OK
    expect(scoAgreesWithApp('NG', 0.7)).toBe(false);   // app passes, S-Concrete NG
  });
});
