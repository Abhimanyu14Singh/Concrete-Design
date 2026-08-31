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
import { governingDcr, isOverstressed, worstStatusView, type StatusTone } from './sco/resultStatus';

/** One member's S-Concrete verification, reduced to what the results card shows. */
export interface MemberScoSummary {
  /** All persisted results that cover this member. */
  results: SconcreteResult[];
  /** Group label of the governing (worst) result. */
  groupLabel?: string;
  /** Worst pass/fail across the covering results. */
  status: 'OK' | 'NG';
  /** Worst display status across the covering results — carries S-Concrete's own
   *  wording ("Acceptable" / "Warning" / "Borderline"), so a member that PASSED
   *  with code messages reads as a warning instead of an outright fail. */
  statusText: string;
  tone: StatusTone;
  /** N-M and V&T utilisation from the governing strength (ULS / single) result. */
  nmUtil: number | null;
  vtUtil: number | null;
  /** Crack-width pass/fail from a dedicated crack result, when present. */
  crackStatus: 'OK' | 'NG' | null;
}

/** Summarise the S-Concrete result(s) covering `memberId`, or null if none. */
export function memberScoSummary(
  all: SconcreteResult[] | undefined, memberId: string,
): MemberScoSummary | null {
  const results = (all ?? []).filter((r) => r.memberIds.includes(memberId));
  if (!results.length) return null;
  // A member can be covered by SEVERAL strength files — one per stirrup zone —
  // so take the worst, not the first. (`[0]` reported whichever zone happened to
  // be written first, which is rarely the governing one.)
  const strengths = results.filter((r) => r.kind === 'uls' || r.kind === 'single');
  const strength = (strengths.length ? strengths : results)
    .reduce((a, b) => ((governingDcr(b).dcr ?? -1) > (governingDcr(a).dcr ?? -1) ? b : a));
  const crack = results.find((r) => r.kind === 'crack');
  const worst = worstStatusView(results)!;
  return {
    results,
    groupLabel: strength.groupLabel,
    status: results.some(isOverstressed) ? 'NG' : 'OK',
    statusText: worst.text,
    tone: worst.tone,
    nmUtil: strength.nmUtil,
    vtUtil: strength.vtUtil,
    crackStatus: crack ? (isOverstressed(crack) ? 'NG' : 'OK') : null,
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
