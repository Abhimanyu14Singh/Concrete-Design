/**
 * SectionCard — one design group's cross-section as a thumbnail with its governing
 * DCR, live ρ / steel weight, and inline bar editing (click a bar count/size to
 * step it; edits apply to the whole group). Clicking the card selects the group.
 */
import type { RebarLayout } from '../../types';
import type { DashboardGroup } from '../../utils/dashboardPayload';
import SectionView from '../Detailing/SectionView';
import { dcrColor, dcrBg, BORDER, INK, ACCENT, STATUS, MONO_NUM } from '../../theme';

export default function SectionCard({ group, selected, onSelect, onApplyRebar }: {
  group: DashboardGroup;
  selected: boolean;
  onSelect: () => void;
  onApplyRebar: (groupId: string, rebar: RebarLayout) => void;
}) {
  const ng = group.govDCR > 1.0;
  return (
    <div
      onClick={onSelect}
      title="Click to isolate this group on the plan"
      style={{
        border: `1px solid ${selected ? ACCENT.primary : ng ? STATUS.failBorder : BORDER.default}`,
        background: selected ? ACCENT.softBg : ng ? STATUS.failBg : 'white',
        borderRadius: 10, padding: 8, cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 6,
        boxShadow: selected ? `0 0 0 1px ${ACCENT.primary}` : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: group.color ?? INK.muted, flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: INK.strong, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.label}</span>
        <span style={{ ...MONO_NUM, fontSize: 11, fontWeight: 700, color: dcrColor(group.govDCR), background: dcrBg(group.govDCR), padding: '1px 5px', borderRadius: 4 }}>{group.govDCR.toFixed(2)}</span>
      </div>

      {/* Section drawing — bars are click-editable; clicking elsewhere selects the group. */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <SectionView
          section={group.section}
          rebar={group.rebar}
          width={224} height={168}
          showDims={false} barLabels editBarSize
          padL={8} padR={82} padT={14} padB={16}
          onRebarChange={r => onApplyRebar(group.id, r)}
        />
      </div>

      <div style={{ display: 'flex', gap: 10, fontSize: 10, color: INK.secondary, ...MONO_NUM }}>
        <span title="Bottom steel ratio">ρ⁺ {group.rhoBot.toFixed(2)}%</span>
        <span title="Top steel ratio">ρ⁻ {group.rhoTop.toFixed(2)}%</span>
        <span title="Longitudinal steel weight">{group.steelWtLbFt.toFixed(1)} lb/ft</span>
        <span style={{ marginLeft: 'auto', color: INK.muted }}>{group.beamCount} beam{group.beamCount === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}
