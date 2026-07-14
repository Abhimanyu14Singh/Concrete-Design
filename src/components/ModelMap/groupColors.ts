/**
 * Shared design-group color palette.
 *
 * One source of truth so the colored dots in the Groups list, the beams on
 * the map plan, and the auto-group overlay/legend all agree. Groups are
 * colored by their explicit `color` when set, otherwise by position so that
 * no two adjacent groups collide until the palette wraps.
 *
 * The palette is theme.CATEGORICAL — deliberately free of the status hues
 * (green/amber/red are reserved for pass/warn/fail), so a group color can
 * never be mistaken for a result on the status-colored map.
 */
import { CATEGORICAL } from '../../theme';

export const GROUP_PALETTE: readonly string[] = CATEGORICAL;

/** Resolve a group's display color: explicit color wins, else palette by index. */
export function groupColor(color: string | undefined, index: number): string {
  return color ?? GROUP_PALETTE[index % GROUP_PALETTE.length];
}
