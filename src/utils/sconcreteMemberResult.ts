/**
 * Look up the persisted S-Concrete batch result(s) for a single member and
 * summarise them for the member results card — closing the loop between the
 * app's own DCRs and the external S-Concrete verification.
 *
 * Results are persisted on the project (Project.sconcreteResults) keyed by the
 * member ids each covers, so a member can be covered by a ULS result AND a crack
 * result (EC2 beam groups) or a single combined result (ACI / columns).
 */
import type { SconcreteResult } from '../types';

export interface MemberScoSummary {
  /** All persisted results that cover this member. */
  results: SconcreteResult[];
  /** Group label of the governing (worst) result. */
  groupLabel?: string;
  /** Worst pass/fail across the covering results. */
  status: 'OK' | 'NG';
  /** N-M and V&T utilisation from the strength (ULS / single) result. */
  nmUtil: number | null;
  vtUtil: number | null;
  /** Crack-width pass/fail from a dedicated crack result, when present. */
  crackStatus: 'OK' | 'NG' | null;
}

const isNg = (r: SconcreteResult): boolean =>
  (r.status != null && r.status !== 'OK') || Math.max(r.nmUtil ?? 0, r.vtUtil ?? 0) > 1;

/** Summarise the S-Concrete result(s) covering `memberId`, or null if none. */
export function memberScoSummary(
  all: SconcreteResult[] | undefined, memberId: string,
): MemberScoSummary | null {
  const results = (all ?? []).filter((r) => r.memberIds.includes(memberId));
  if (!results.length) return null;
  const strength = results.find((r) => r.kind === 'uls' || r.kind === 'single') ?? results[0];
  const crack = results.find((r) => r.kind === 'crack');
  return {
    results,
    groupLabel: strength.groupLabel,
    status: results.some(isNg) ? 'NG' : 'OK',
    nmUtil: strength.nmUtil,
    vtUtil: strength.vtUtil,
    crackStatus: crack ? (isNg(crack) ? 'NG' : 'OK') : null,
  };
}

/**
 * Does S-Concrete agree with the app on the pass/fail verdict? Returns null when
 * there's no S-Concrete result to compare against. A DCR / util > 1 is a fail.
 */
export function scoAgreesWithApp(
  scoStatus: 'OK' | 'NG' | null, appGoverningDCR: number,
): boolean | null {
  if (scoStatus == null) return null;
  return (appGoverningDCR > 1) === (scoStatus === 'NG');
}
