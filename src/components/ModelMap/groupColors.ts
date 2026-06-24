/**
 * Shared design-group color palette.
 *
 * One source of truth so the colored dots in the Groups list, the beams on
 * the map plan, and the auto-group overlay/legend all agree. Groups are
 * colored by their explicit `color` when set, otherwise by position so that
 * no two adjacent groups collide until the palette wraps.
 */
export const GROUP_PALETTE = [
  '#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2',
  '#dc2626', '#65a30d', '#7c3aed', '#0284c7', '#be185d',
  '#ca8a04', '#0d9488', '#db2777', '#4f46e5', '#15803d',
  '#b45309',
];

/** Resolve a group's display color: explicit color wins, else palette by index. */
export function groupColor(color: string | undefined, index: number): string {
  return color ?? GROUP_PALETTE[index % GROUP_PALETTE.length];
}
