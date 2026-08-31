/**
 * Bulk fix for side-face (skin) reinforcement warnings.
 *
 * Deep beams pick up an EC2 §7.3.3 skin-reinforcement warning across a whole import at
 * once, and clearing them one member at a time is busywork. The dashboard offers "add
 * minimum skin bars to all flagged members", which is these two helpers: recognise the
 * warning, then write the layout. Both are pure — the caller re-runs design on the
 * returned members, so the warning clears through the engine rather than being masked.
 */

import type { Member, DesignWarning } from '../types';

/** True if a design warning is about skin/side-face reinforcement (EC2 §7.3.3/§7.3.4). */
export function isSkinWarning(w: DesignWarning): boolean {
  return /skin reinforcement/i.test(w.message) || w.code === 'EC2 §7.3.3';
}

/** Apply a minimum side/skin reinforcement layout to the given members. Returns new members. */
export function applyMinSkinReinforcement(
  members: Member[],
  flaggedIds: Set<string>,
  min: { numBars: number; barSize: number },
): Member[] {
  return members.map(m => {
    if (!flaggedIds.has(m.id)) return m;
    return { ...m, rebar: { ...m.rebar, sideBars: [{ numBars: min.numBars, barSize: min.barSize }] } };
  });
}
