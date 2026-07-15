import { describe, it, expect } from 'vitest';
import { formatGroupName, depthCodeMm } from '../autoGroupName';

describe('formatGroupName', () => {
  it("matches the user's methodology: B-07-01 (700 mm, 1st group)", () => {
    expect(formatGroupName('{type}-{depth}-{seq}', {
      isColumn: false, depthMm: 700, widthMm: 300, seq: 1, n: 1,
    })).toBe('B-07-01');
  });

  it("matches B-12-04 (1200 mm, 4th group of that depth)", () => {
    expect(formatGroupName('{type}-{depth}-{seq}', {
      isColumn: false, depthMm: 1200, widthMm: 400, seq: 4, n: 7,
    })).toBe('B-12-04');
  });

  it('a literal prefix works too (B typed directly)', () => {
    expect(formatGroupName('B-{depth}-{seq}', {
      isColumn: false, depthMm: 700, widthMm: 300, seq: 1, n: 1,
    })).toBe('B-07-01');
  });

  it('columns get C from {type}', () => {
    expect(formatGroupName('{type}-{depth}-{seq}', {
      isColumn: true, depthMm: 600, widthMm: 600, seq: 2, n: 3,
    })).toBe('C-06-02');
  });

  it('supports {width}, {depthmm}, {n}, {story}, {face}', () => {
    const ctx = { isColumn: false, depthMm: 700, widthMm: 300, seq: 1, n: 5, face: 'top' as const, story: 'L02' };
    expect(formatGroupName('{width}x{depthmm} {face} #{n} @{story}', ctx)).toBe('03x700 T #05 @L02');
  });

  it('face token is empty when the group was not split by face', () => {
    expect(formatGroupName('{type}-{depth}{face}', { isColumn: false, depthMm: 700, widthMm: 300, seq: 1, n: 1 }))
      .toBe('B-07');
  });

  it('leaves unknown tokens visible rather than dropping them', () => {
    expect(formatGroupName('{type}-{bogus}', { isColumn: false, depthMm: 700, widthMm: 300, seq: 1, n: 1 }))
      .toBe('B-{bogus}');
  });

  it('is case-insensitive on token names', () => {
    expect(formatGroupName('{TYPE}-{Depth}-{SEQ}', { isColumn: false, depthMm: 1200, widthMm: 400, seq: 4, n: 1 }))
      .toBe('B-12-04');
  });

  it('depthCodeMm rounds to the nearest hundred mm', () => {
    expect(depthCodeMm(700)).toBe('07');
    expect(depthCodeMm(1200)).toBe('12');
    expect(depthCodeMm(650)).toBe('07'); // 6.5 → 7
  });
});
