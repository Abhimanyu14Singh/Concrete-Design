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
