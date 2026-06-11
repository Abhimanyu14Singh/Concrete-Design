import { describe, it, expect } from 'vitest';
import { toDisplay, fromDisplay, unitLabel, fmt, capacityLabels } from '../units';
import { formatBarLabel, barSizeOptions, isMetricBar, METRIC_BAR_SIZES, US_BAR_SIZES } from '../rebar';

describe('unit conversions', () => {
  it('length: 1 in = 25.4 mm', () => {
    expect(toDisplay(1, 'length', 'si')).toBeCloseTo(25.4, 6);
  });
  it('stress: 4000 psi ≈ 27.58 MPa', () => {
    expect(toDisplay(4000, 'stress', 'si')).toBeCloseTo(27.579, 2);
  });
  it('force: 10 kips ≈ 44.48 kN', () => {
    expect(toDisplay(10, 'force', 'si')).toBeCloseTo(44.482, 2);
  });
  it('moment: 100 kip-ft ≈ 135.58 kN·m', () => {
    expect(toDisplay(100, 'moment', 'si')).toBeCloseTo(135.582, 2);
  });
  it('area: 1 in² = 645.16 mm²', () => {
    expect(toDisplay(1, 'area', 'si')).toBeCloseTo(645.16, 2);
  });
  it('imperial mode is identity', () => {
    for (const q of ['length', 'stress', 'force', 'moment', 'area', 'spanLength'] as const) {
      expect(toDisplay(123.456, q, 'imperial')).toBe(123.456);
      expect(fromDisplay(123.456, q, 'imperial')).toBe(123.456);
    }
  });
  it('round-trip: fromDisplay(toDisplay(x)) ≈ x in SI', () => {
    for (const q of ['length', 'stress', 'force', 'moment', 'area', 'spanLength'] as const) {
      expect(fromDisplay(toDisplay(17.25, q, 'si'), q, 'si')).toBeCloseTo(17.25, 10);
    }
  });
  it('round-trip survives zero and negative values', () => {
    expect(fromDisplay(toDisplay(0, 'force', 'si'), 'force', 'si')).toBe(0);
    expect(fromDisplay(toDisplay(-50, 'moment', 'si'), 'moment', 'si')).toBeCloseTo(-50, 10);
  });
  it('labels', () => {
    expect(unitLabel('length', 'si')).toBe('mm');
    expect(unitLabel('length', 'imperial')).toBe('in');
    expect(unitLabel('moment', 'si')).toBe('kN·m');
    expect(unitLabel('stress', 'si')).toBe('MPa');
  });
  it('fmt produces idiomatic SI rounding', () => {
    expect(fmt(22, 'length', 'si')).toBe('559 mm');
    expect(fmt(22, 'length', 'imperial')).toBe('22.00 in');
  });
});

describe('capacityLabels', () => {
  it('ACI uses φ notation', () => {
    expect(capacityLabels('ACI318-19').Mn).toBe('φMn');
    expect(capacityLabels('ACI318-14').Vn).toBe('φVn');
  });
  it('EC2 uses Rd notation', () => {
    const l = capacityLabels('EN1992-1-1');
    expect(l.Mn).toBe('M_Rd');
    expect(l.Vn).toBe('V_Rd');
    expect(l.Tn).toBe('T_Rd');
  });
});

describe('metric rebar helpers', () => {
  it('formatBarLabel: US vs metric', () => {
    expect(formatBarLabel(8)).toBe('#8');
    expect(formatBarLabel(-16)).toBe('Ø16');
  });
  it('isMetricBar', () => {
    expect(isMetricBar(-20)).toBe(true);
    expect(isMetricBar(8)).toBe(false);
    expect(isMetricBar(0)).toBe(false);
  });
  it('barSizeOptions returns the active system list', () => {
    expect(barSizeOptions('imperial')).toEqual(US_BAR_SIZES);
    expect(barSizeOptions('si')).toEqual(METRIC_BAR_SIZES);
  });
  it('barSizeOptions keeps a cross-system selection so it is not destroyed', () => {
    const opts = barSizeOptions('si', 8); // US #8 selected while in SI mode
    expect(opts).toContain(8);
    expect(opts).toContain(-16);
  });
  it('barSizeOptions does not duplicate an in-list selection', () => {
    const opts = barSizeOptions('si', -16);
    expect(opts.filter(o => o === -16)).toHaveLength(1);
  });
});
