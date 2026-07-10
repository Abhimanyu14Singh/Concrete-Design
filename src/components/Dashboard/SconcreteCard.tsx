/**
 * SconcreteCard — one design group's cross-section (same thumbnail as the Group
 * Dashboard's SectionCard, but read-only) topped with its S-Concrete verification
 * status: worst pass/fail across the group's rows, governing DCR, and a warning
 * count. Groups not yet run show a muted "not verified" state. Clicking the card
 * fills the dashboard's lower half with the group's full S-Concrete detail.
 */
import type { SconcreteResult } from '../../types';
import type { DashboardGroup } from '../../utils/dashboardPayload';
import { summarizeGroupResults } from '../../utils/sco/useSconcreteBatch';
import { governingDcr, type StatusTone } from '../../utils/sco/resultStatus';
import SectionView from '../Detailing/SectionView';
import { BORDER, INK, ACCENT, STATUS, MONO_NUM, TYPE } from '../../theme';

const TONE_COLOR: Record<StatusTone, string> = { ok: STATUS.ok, warn: STATUS.warn, ng: STATUS.fail, none: INK.muted };
const TONE_BG: Record<StatusTone, string> = { ok: STATUS.okBg, warn: STATUS.warnBg, ng: STATUS.failBg, none: STATUS.noneBg };

/** Short tag for a result row: "ULS" / "crack" / "" (single). */
const kindTag = (k: SconcreteResult['kind']): string => (k === 'crack' ? 'crack' : k === 'uls' ? 'ULS' : '');

export default function SconcreteCard({ group, results, selected, onSelect }: {
  group: DashboardGroup;
  results: SconcreteResult[];
  selected: boolean;
  onSelect: () => void;
}) {
  const sum = summarizeGroupResults(results);
  const ng = sum?.tone === 'ng';
  const tone: StatusTone = sum?.tone ?? 'none';

  return (
    <div
      onClick={onSelect}
      title="Click to see this group's S-Concrete checks"
      style={{
        border: `1px solid ${selected ? ACCENT.primary : ng ? STATUS.failBorder : BORDER.default}`,
        background: selected ? ACCENT.softBg : ng ? STATUS.failBg : 'white',
        borderRadius: 10, padding: 8, cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 6,
        boxShadow: selected ? `0 0 0 1px ${ACCENT.primary}` : 'none',
      }}
    >
      {/* Name row + S-Concrete status badge (worst pass/fail + governing DCR + ⚠). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: group.color ?? INK.muted, flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: INK.strong, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.label}</span>
        {sum ? (
          <span style={{ display: 'flex', gap: 5, alignItems: 'center', flexShrink: 0 }}>
            {sum.dcr != null && (
              <span title="Governing S-Concrete DCR (worse of N-M and shear+torsion)"
                style={{ ...MONO_NUM, fontSize: 11, fontWeight: 700, color: TONE_COLOR[tone], background: TONE_BG[tone], padding: '1px 5px', borderRadius: 4 }}>
                {sum.dcr.toFixed(2)}
              </span>
            )}
            <span title="Worst S-Concrete status in this group"
              style={{ fontSize: 10, fontWeight: 700, color: TONE_COLOR[tone] }}>{sum.text}</span>
            {sum.warnCount > 0 && (
              <span title={`${sum.warnCount} S-Concrete message(s)`} style={{ fontSize: 10, fontWeight: 700, color: STATUS.warn }}>{sum.warnCount}⚠</span>
            )}
          </span>
        ) : (
          <span title="This group has no S-Concrete result yet — run the batch" style={{ fontSize: 10, fontWeight: 600, color: INK.muted, flexShrink: 0 }}>not verified</span>
        )}
      </div>

      {/* Read-only section drawing (bars + stirrups labelled, no inline editing). */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <SectionView
          section={group.section}
          rebar={group.rebar}
          width={248} height={168}
          showDims={false} barLabels
          padL={8} padR={104} padT={14} padB={16}
        />
      </div>

      {/* Footer — per-row DCRs (ULS / crack) + member count. */}
      <div style={{ display: 'flex', gap: 10, fontSize: TYPE.micro, color: INK.secondary, ...MONO_NUM }}>
        {results.length > 0 ? results.slice(0, 3).map((r, i) => {
          const { dcr } = governingDcr(r);
          const tag = kindTag(r.kind);
          return (
            <span key={i} title={tag ? `${tag} check` : 'strength check'}>
              {tag && <span style={{ color: INK.muted }}>{tag} </span>}
              {dcr != null ? dcr.toFixed(2) : '—'}
            </span>
          );
        }) : (
          <span style={{ color: INK.muted }}>run the batch to verify</span>
        )}
        <span style={{ marginLeft: 'auto', color: INK.muted }}>{group.beamCount} beam{group.beamCount === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}
