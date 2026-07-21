/**
 * Shared Dashboard primitives — the DCR chips, per-mode extraction, the
 * status-banded DCR-distribution histogram, and the group summary. Extracted
 * from Dashboard.tsx (behaviour-identical) so both the Dashboard tab and the
 * in-map Group Dashboard render members the same way.
 */
import type { Member, DesignResults, DesignCode } from '../../types';
import { runDesign } from '../../engines';
import { resolveCrack } from '../../utils/resolveCrack';
import { useUnits } from '../../contexts/UnitsContext';
import { dcrColor, BORDER, INK, MAP_DCR_BANDS, LABEL_STYLE, MONO_NUM, STATUS } from '../../theme';

export interface MemberSummary {
  member: Member;
  worstResult: DesignResults;
  maxDCR: number;
}

export function worstOf(r: DesignResults): number {
  return Math.max(
    r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear, r.DCR_torsion,
    r.DCR_PM ?? 0, r.DCR_axial ?? 0, r.VT_util ?? 0,
  );
}

export function summarize(m: Member, code: DesignCode, slsCombo?: string, cotTheta?: number, ignoreTorsion?: boolean): MemberSummary {
  const results = m.loads.map(l =>
    runDesign(m.section, m.material, m.rebar, l, m.span, code, resolveCrack(m, code, slsCombo), cotTheta, ignoreTorsion));
  const maxDCR = Math.max(...results.map(worstOf));
  const worstResult = results.reduce((a, b) => worstOf(b) > worstOf(a) ? b : a);
  return { member: m, worstResult, maxDCR };
}

/** Per-failure-mode DCRs off a governing DesignResults (crack only for EC2). */
export function modeDCRs(r: DesignResults, code: DesignCode) {
  return {
    flexPos: r.DCR_flex_pos,
    flexNeg: r.DCR_flex_neg,
    shear: r.DCR_shear,
    // Crack DCR straight from the engine (wk / actual w_limit per face).
    wk: code === 'EN1992-1-1' ? (r.DCR_crack ?? 0) : undefined,
  };
}

interface DCRChipProps {
  label: string;
  value: number | undefined;
  isWk?: boolean;
}

// Chips use the shared dcrColor thresholds (amber above NEAR_CAPACITY = 0.9),
// so a member reads the same colour here as on the map and in the results.
export function DCRChip({ label, value, isWk }: DCRChipProps) {
  let display: string;
  let bg: string;
  if (value === undefined) {
    display = '—';
    bg = INK.muted;
  } else if (isWk) {
    display = value > 1.0 ? '!' : value > 0.9 ? '!' : 'OK';
    bg = dcrColor(value);
  } else {
    display = value.toFixed(2);
    bg = dcrColor(value);
  }
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <span style={{ fontSize: 10, color: INK.muted, fontWeight: 600, lineHeight: 1 }}>{label}</span>
      <span style={{
        padding: '2px 5px', borderRadius: 3, fontSize: 11, fontWeight: 700,
        background: bg, color: 'white', ...MONO_NUM, lineHeight: 1.3,
      }}>{display}</span>
    </span>
  );
}

export function AvgChip({ label, value }: { label: string; value: number | undefined }) {
  const display = value === undefined ? '—' : value.toFixed(2);
  const bg = value === undefined ? INK.muted : dcrColor(value);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <span style={{ fontSize: 10, color: INK.muted, fontWeight: 600, lineHeight: 1 }}>{label}</span>
      <span style={{
        padding: '2px 5px', borderRadius: 3, fontSize: 11, fontWeight: 700,
        background: bg, color: 'white', ...MONO_NUM, lineHeight: 1.3,
      }}>{display}</span>
    </span>
  );
}

// Same bands as the model map's DCR colouring, so the histogram and the map
// always tell the same story.
const DCR_BUCKETS = MAP_DCR_BANDS;

/** Status-banded distribution histogram of a set of DCR values. */
export function DcrHistogram({ values }: { values: number[] }) {
  const counts = DCR_BUCKETS.map(() => 0);
  for (const v of values) {
    let i = DCR_BUCKETS.findIndex(b => v < b.max);
    if (i === -1) i = DCR_BUCKETS.length - 1;
    counts[i]++;
  }
  const maxC = Math.max(1, ...counts);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 30 }}>
      {DCR_BUCKETS.map((b, i) => (
        <div key={i} title={`${b.label}: ${counts[i]} member${counts[i] === 1 ? '' : 's'}`}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
          <span style={{ fontSize: 10, color: INK.muted, lineHeight: 1, marginBottom: 1 }}>{counts[i] || ''}</span>
          <div style={{ width: 12, height: Math.max(2, (counts[i] / maxC) * 22), background: counts[i] ? b.color : BORDER.default, borderRadius: 1 }} />
        </div>
      ))}
    </div>
  );
}

export function GroupDcrSummary({ members, summaryById, code }: { members: Member[]; summaryById: Map<string, MemberSummary>; code: DesignCode }) {
  let sp = 0, sn = 0, ss = 0, sw = 0, cw = 0, n = 0;
  const gov: number[] = [];
  for (const m of members) {
    const s = summaryById.get(m.id);
    if (!s) continue;
    const md = modeDCRs(s.worstResult, code);
    sp += md.flexPos; sn += md.flexNeg; ss += md.shear;
    if (md.wk !== undefined) { sw += md.wk; cw++; }
    gov.push(s.maxDCR);
    n++;
  }
  if (!n) return null;
  const avg = { flexPos: sp / n, flexNeg: sn / n, shear: ss / n, wk: cw ? sw / cw : undefined };
  const avgGov = gov.reduce((a, b) => a + b, 0) / gov.length;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 10, padding: '8px 14px' }}>
      <div>
        <div style={{ ...LABEL_STYLE, marginBottom: 4 }}>Average DCR</div>
        <div style={{ display: 'flex', gap: 4 }}>
          <AvgChip label="M⁺" value={avg.flexPos} />
          <AvgChip label="M⁻" value={avg.flexNeg} />
          <AvgChip label="V" value={avg.shear} />
          <AvgChip label="wk" value={avg.wk} />
        </div>
      </div>
      <div style={{ width: 1, alignSelf: 'stretch', background: BORDER.default }} />
      <div>
        <div style={{ ...LABEL_STYLE, marginBottom: 4 }}>
          DCR Distribution <span style={{ color: INK.secondary, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>· avg gov {avgGov.toFixed(2)}</span>
        </div>
        <DcrHistogram values={gov} />
      </div>
    </div>
  );
}

export function DCRInlineCell({ value, isWk }: { value: number | undefined; isWk?: boolean }) {
  if (value === undefined) return <span style={{ fontSize: 11, color: INK.muted }}>—</span>;
  if (isWk) {
    const ok = value <= 0.9;
    const warn = value > 0.9 && value <= 1.0;
    const fail = value > 1.0;
    const color = fail ? STATUS.fail : warn ? STATUS.warn : STATUS.ok;
    const bg = fail ? STATUS.failBg : warn ? STATUS.warnBg : STATUS.okBg;
    return <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 5px', borderRadius: 3, background: bg, color }}>{fail ? '!' : ok ? 'OK' : '!'}</span>;
  }
  const color = value > 1.0 ? STATUS.fail : value > 0.75 ? STATUS.warn : STATUS.ok;
  const bg = value > 1.0 ? STATUS.failBg : value > 0.75 ? STATUS.warnBg : STATUS.okBg;
  return <span style={{ fontSize: 10, fontWeight: 700, ...MONO_NUM, padding: '2px 5px', borderRadius: 3, background: bg, color }}>{value.toFixed(2)}</span>;
}

/** Convenience: unit-aware "b×h" label used by member rows. */
export function useSectionSizeLabel() {
  const { fmtVal, label } = useUnits();
  return (b: number, h: number) => `${fmtVal(b, 'length')}×${fmtVal(h, 'length')} ${label('length')}`;
}
