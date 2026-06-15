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
