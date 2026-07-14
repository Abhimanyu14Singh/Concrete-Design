import { describe, it, expect } from 'vitest';
import { barSizeStep, US_BAR_SIZES, METRIC_BAR_SIZES } from '../rebar';

describe('barSizeStep', () => {
  it('steps US bars up (larger) and down (smaller) within the family', () => {
    expect(barSizeStep(8, 1)).toBe(9);
    expect(barSizeStep(8, -1)).toBe(7);
    expect(barSizeStep(11, 1)).toBe(14); // skips to the next real size, not 12/13
    expect(barSizeStep(14, -1)).toBe(11);
  });

  it('steps metric bars: +1 = larger diameter, -1 = smaller', () => {
    expect(barSizeStep(-16, 1)).toBe(-20); // Ø16 → Ø20
    expect(barSizeStep(-16, -1)).toBe(-12); // Ø16 → Ø12
    expect(barSizeStep(-8, -1)).toBe(-8);   // clamp at smallest
    expect(barSizeStep(-40, 1)).toBe(-40);  // clamp at largest
  });

  it('clamps at the ends of the US family', () => {
    expect(barSizeStep(US_BAR_SIZES[0], -1)).toBe(US_BAR_SIZES[0]);
    expect(barSizeStep(US_BAR_SIZES[US_BAR_SIZES.length - 1], 1)).toBe(US_BAR_SIZES[US_BAR_SIZES.length - 1]);
    expect(barSizeStep(METRIC_BAR_SIZES[METRIC_BAR_SIZES.length - 1], 1)).toBe(METRIC_BAR_SIZES[METRIC_BAR_SIZES.length - 1]);
  });

  it('returns a custom (non-family) size unchanged', () => {
    expect(barSizeStep(13, 1)).toBe(13);
    expect(barSizeStep(-99, -1)).toBe(-99);
  });
});
