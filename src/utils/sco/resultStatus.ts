/**
 * Display helpers for S-Concrete batch results — turning the raw .SCRS values
 * (status line + utilizations) into a pass/fail Status, a governing DCR, and a
 * roll-up summary for the results table and the per-member verification card.
 *
 * Why "derived" status: EC2 (and some ACI) batch reports don't always emit an
 * "OK / OVERSTRESSED" line the parser can key on, so `status` comes back null even
 * when the utilizations are clearly over 1.0. Rather than show a blank "—", we
 * DERIVE the status from the governing DCR so the table still reads OK / Near / NG.
 * These are pure functions (no colours, no React) so they're unit-testable.
 */

export type StatusTone = 'ok' | 'warn' | 'ng' | 'none';

/** The minimal result shape these helpers need (a subset of SconcreteResult/ScrsResult). */
export interface UtilResult {
  status: string | null;
  nmUtil: number | null;
  vtUtil: number | null;
}

/** DCR at/above which a member is "near capacity" (amber) rather than safe (green). */
export const NEAR_CAPACITY = 0.9;

/** Governing demand/capacity ratio for a result — the worse of N-M (axial+moment)
 *  and shear+torsion — plus which check governs. Null when neither is available. */
export function governingDcr(r: { nmUtil: number | null; vtUtil: number | null }): { dcr: number | null; by: string | null } {
  const { nmUtil: n, vtUtil: v } = r;
  if (n == null && v == null) return { dcr: null, by: null };
  if (n != null && (v == null || n >= v)) return { dcr: n, by: 'N-M' };
  return { dcr: v as number, by: 'V&T' };
}

/** Classify a DCR into a status tone: green (safe) · amber (≥0.90, near) · red (>1, over). */
export function dcrTone(dcr: number | null): StatusTone {
  if (dcr == null) return 'none';
  if (dcr > 1) return 'ng';
  if (dcr >= NEAR_CAPACITY) return 'warn';
  return 'ok';
}

/**
 * Display status for a result: the .SCRS-reported status when the parser found
 * one, otherwise DERIVED from the governing DCR (so a status-less report still
 * reads OK / Near / NG). `derived` flags the latter case for the UI to annotate.
 */
export function statusView(r: UtilResult): { text: string; tone: StatusTone; derived: boolean } {
  const raw = r.status?.trim();
  if (raw) {
    const up = raw.toUpperCase();
    // S-Concrete EN reports use Acceptable / Warning / Borderline; ACI uses OK /
    // OVERSTRESSED. "Borderline" = utilization ≥ 1.0 (over capacity) → NG.
    if (up.startsWith('OK') || up.startsWith('PASS') || up.startsWith('ACCEPT')) return { text: 'OK', tone: 'ok', derived: false };
    if (up.startsWith('WARN')) return { text: 'Warning', tone: 'warn', derived: false };
    if (up.startsWith('BORDER')) return { text: 'Borderline', tone: 'ng', derived: false };
    return { text: raw, tone: 'ng', derived: false }; // OVERSTRESSED / NG / FAIL / …
  }
  const { dcr } = governingDcr(r);
  const tone = dcrTone(dcr);
  const text = tone === 'none' ? '—' : tone === 'ng' ? 'NG' : tone === 'warn' ? 'Near' : 'OK';
  return { text, tone, derived: tone !== 'none' };
}

/** Severity order, for rolling several results (a group's ULS + crack + per-zone
 *  files, or every result covering one member) up into a single worst-case badge. */
export const TONE_RANK: Record<StatusTone, number> = { none: 0, ok: 1, warn: 2, ng: 3 };

/** The worst (highest-severity) status view across a set of results. Null when empty. */
export function worstStatusView(results: UtilResult[]): { text: string; tone: StatusTone; derived: boolean } | null {
  if (!results.length) return null;
  let worst = statusView(results[0]);
  for (let i = 1; i < results.length; i++) {
    const sv = statusView(results[i]);
    if (TONE_RANK[sv.tone] > TONE_RANK[worst.tone]) worst = sv;
  }
  return worst;
}

/**
 * Has this result actually FAILED capacity (as opposed to merely carrying code
 * warnings)? Only the `ng` tone counts — S-Concrete's EN 1992 reports say
 * "Acceptable" for a pass and "Warning" for a pass that still raised messages, so
 * a plain `status !== 'OK'` test marks every passing EN member overstressed.
 * A utilisation over 1 still fails even when the report text disagrees.
 */
export function isOverstressed(r: UtilResult): boolean {
  return statusView(r).tone === 'ng' || Math.max(r.nmUtil ?? 0, r.vtUtil ?? 0) > 1;
}

/** Roll a result set up into per-tone counts for a header summary ("3 NG · 1 near · 2 OK"). */
export function summarize(results: UtilResult[]): Record<StatusTone, number> {
  return results.reduce<Record<StatusTone, number>>(
    (a, r) => { a[statusView(r).tone]++; return a; },
    { ok: 0, warn: 0, ng: 0, none: 0 },
  );
}
