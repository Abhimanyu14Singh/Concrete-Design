/**
 * The stacking order between things that portal to `<body>`.
 *
 * Everything portalled lands in the ROOT stacking context, so these values are compared
 * against each other directly and there is no containing element to arbitrate. A layer
 * chosen locally — "9999 is surely higher than anything" — is a bet against every other
 * portal in the app, and that bet has been lost: SuggestSizeDialog took `10000`,
 * Dropdown had `9999`, and so the three bar-size lists INSIDE that dialog painted
 * underneath its own backdrop. Clicking one appeared to do nothing at all.
 *
 * The invariant is the non-obvious half: a POPOVER opened from inside a MODAL must
 * outrank that modal. It is a child of the dialog in every sense except the DOM's, so
 * the intuitive "modals are the topmost thing" ordering is precisely wrong.
 */
import { describe, expect, it } from 'vitest';
import { Z } from '../../theme';

describe('portal stacking order', () => {
  it('a popover opened inside a modal paints above it', () => {
    // The regression, stated as the rule that prevents it.
    expect(Z.popover).toBeGreaterThan(Z.modal);
  });

  it('a drag ghost clears even an open menu', () => {
    expect(Z.drag).toBeGreaterThan(Z.popover);
  });

  it('docked chrome stays below everything that floats over it', () => {
    expect(Z.chrome).toBeLessThan(Z.modal);
  });

  it('every layer is distinct, so no two can tie and fall back to DOM order', () => {
    const values = Object.values(Z);
    expect(new Set(values).size).toBe(values.length);
  });
});
