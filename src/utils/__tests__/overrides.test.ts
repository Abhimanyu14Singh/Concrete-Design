import { describe, it, expect } from 'vitest';
import {
  warningOverrideKey, isOverridden, failingKeys, effectiveStatus, visibleWarnings,
} from '../overrides';
import type { DesignResults, DesignWarning, MemberOverrides } from '../../types';

const baseResult = (over: Partial<DesignResults> = {}): DesignResults => ({
  loadCaseId: 'lc', status: 'OK', warnings: [],
  DCR_flex_pos: 0.5, DCR_flex_neg: 0.4, DCR_shear: 0.3, DCR_torsion: 0,
  phi_Mn_pos: 0, phi_Mn_neg: 0, phi_Vn: 0, phi_Tn: 0, Vc: 0, Vs: 0, Tcr: 0,
  As_min: 0, As_max: 0, As_req_pos: 0, As_req_neg: 0, Av_req: 0, Av_min_per_s: 0,
  ...over,
} as DesignResults);

describe('warningOverrideKey — clause classification', () => {
  it('crack codes map to DCR_crack', () => {
    expect(warningOverrideKey('EC2 §7.3.4', 'Side face crack width')).toBe('DCR_crack');
    expect(warningOverrideKey('ACI §24.3.2', 'crack control')).toBe('DCR_crack');
  });
  it('shear codes map to DCR_shear', () => {
    expect(warningOverrideKey('EC2 §6.2.3', 'Strut crushing')).toBe('DCR_shear');
    expect(warningOverrideKey('ACI §22.5', 'shear')).toBe('DCR_shear');
  });
  it('torsion §6.3 is not mis-classified as shear §6.2', () => {
    expect(warningOverrideKey('EC2 §6.3.2', 'torsion')).toBe('DCR_torsion');
  });
  it('flexure splits pos/neg by message', () => {
    expect(warningOverrideKey('EC2 §6.1', 'Positive flexure NG')).toBe('DCR_flex_pos');
    expect(warningOverrideKey('EC2 §6.1', 'Negative flexure NG')).toBe('DCR_flex_neg');
  });
  it('unknown codes return null', () => {
    expect(warningOverrideKey('EC2 §9.9.9', 'misc')).toBeNull();
  });
});

describe('isOverridden', () => {
  it('direct key', () => {
    expect(isOverridden({ DCR_crack: {} }, 'DCR_crack')).toBe(true);
  });
  it("'all' covers every key", () => {
    const ov: MemberOverrides = { all: {} };
    expect(isOverridden(ov, 'DCR_shear')).toBe(true);
    expect(isOverridden(ov, 'DCR_crack')).toBe(true);
  });
  it('undefined overrides → false', () => {
    expect(isOverridden(undefined, 'DCR_crack')).toBe(false);
  });
});

describe('failingKeys', () => {
  it('lists checks above 0.9', () => {
    const r = baseResult({ DCR_shear: 1.2, DCR_crack: 0.95, DCR_flex_pos: 0.5 });
    const keys = failingKeys(r);
    expect(keys).toContain('DCR_shear');
    expect(keys).toContain('DCR_crack');
    expect(keys).not.toContain('DCR_flex_pos');
  });
});

describe('effectiveStatus', () => {
  const warn: DesignWarning = { code: 'EC2 §7.3.4', message: 'Side face crack width exceeds', severity: 'warning' };

  it('no overrides → unchanged', () => {
    const r = baseResult({ status: 'NG', DCR_crack: 1.1, warnings: [warn] });
    expect(effectiveStatus(r, undefined)).toBe('NG');
  });
  it('overriding the only failing check → OK', () => {
    const r = baseResult({ status: 'Warning', DCR_crack: 1.1, warnings: [warn] });
    const ov: MemberOverrides = { DCR_crack: {} };
    expect(effectiveStatus(r, ov)).toBe('OK');
  });
  it('partial override leaves status unchanged when another check still fails', () => {
    const r = baseResult({ status: 'NG', DCR_crack: 1.1, DCR_shear: 1.3, warnings: [warn] });
    const ov: MemberOverrides = { DCR_crack: {} };
    expect(effectiveStatus(r, ov)).toBe('NG');
  });
  it("'all' forces OK", () => {
    const r = baseResult({ status: 'NG', DCR_shear: 1.3, warnings: [warn] });
    expect(effectiveStatus(r, { all: {} })).toBe('OK');
  });
});

describe('visibleWarnings', () => {
  const crackWarn: DesignWarning = { code: 'EC2 §7.3.4', message: 'crack', severity: 'warning' };
  const shearWarn: DesignWarning = { code: 'EC2 §6.2', message: 'shear NG', severity: 'error' };

  it('suppresses warnings covered by an override', () => {
    const ov: MemberOverrides = { DCR_crack: {} };
    const out = visibleWarnings([crackWarn, shearWarn], ov);
    expect(out).toEqual([shearWarn]);
  });
  it("'all' suppresses everything", () => {
    expect(visibleWarnings([crackWarn, shearWarn], { all: {} })).toEqual([]);
  });
  it('no overrides → unchanged', () => {
    expect(visibleWarnings([crackWarn, shearWarn], undefined)).toHaveLength(2);
  });
});
