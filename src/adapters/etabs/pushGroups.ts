/**
 * Helpers for pushing design groups back into the ETABS model (assigning member
 * frames to named ETABS groups). The transport is EtabsConnection.pushGroups
 * (live COM only); these are the pure mapping/summary helpers around it.
 */
import type { PushGroupResult } from './connection';

export interface PushableGroup {
  label: string;
  memberIds: string[];
}

/**
 * Build the {name, frameNames}[] payload for EtabsConnection.pushGroups from the
 * app's design groups and a member→ETABS-frame-name map (from project.modelMap).
 * Frame names are de-duplicated; groups with no mappable frames are skipped.
 */
export function buildGroupPushPayload(
  groups: PushableGroup[],
  frameByMemberId: Map<string, string> | Record<string, string>,
): Array<{ name: string; frameNames: string[] }> {
  const get = (id: string): string | undefined =>
    frameByMemberId instanceof Map ? frameByMemberId.get(id) : frameByMemberId[id];
  return groups
    .map((g) => ({
      name: g.label,
      frameNames: Array.from(new Set(g.memberIds.map(get).filter((f): f is string => !!f))),
    }))
    .filter((g) => g.frameNames.length > 0);
}

/** One-line human summary of a push. */
export function summarizePushResults(results: PushGroupResult[]): string {
  const assigned = results.reduce((s, r) => s + r.assigned, 0);
  const total = results.reduce((s, r) => s + r.total, 0);
  const failed = results.flatMap((r) => r.failures ?? []);
  const tail = failed.length ? ` (${failed.length} failed)` : '';
  return `Pushed ${results.length} group(s) to ETABS: ${assigned}/${total} frames assigned${tail}.`;
}
