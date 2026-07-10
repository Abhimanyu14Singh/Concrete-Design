/**
 * SectionCard — one design group's cross-section as a thumbnail with its worst
 * per-mode DCRs (M⁺ / M⁻ / V) on the name row, live ρ / steel weight, and inline
 * cage editing (click a bar count/size to step it; '＋layer' adds a layer; the
 * stirrup line is size/spacing-editable with a '⅓' zoned-spacing toggle). Edits
 * apply to the whole group. Clicking the card selects the group.
 */
import type { RebarLayout } from '../../types';
import type { DashboardGroup } from '../../utils/dashboardPayload';
import SectionView from '../Detailing/SectionView';
import { DCRChip } from './dashboardShared';
import { BORDER, INK, ACCENT, STATUS, MONO_NUM } from '../../theme';

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
      {/* Name row + the group's worst per-mode DCRs (M⁺ / M⁻ / V). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: group.color ?? INK.muted, flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: INK.strong, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.label}</span>
        <span style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
          <DCRChip label="M⁺" value={group.maxFlexPos} />
          <DCRChip label="M⁻" value={group.maxFlexNeg} />
          <DCRChip label="V" value={group.maxShear} />
        </span>
      </div>

      {/* Section drawing — bars + stirrups are click-editable; the '＋layer' token
          adds a reinforcement layer, the '⅓' token zones the stirrup spacing.
          Clicking anywhere else on the card selects the group. */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <SectionView
          section={group.section}
          rebar={group.rebar}
          width={248} height={168}
          showDims={false} barLabels editBarSize editStirrup
          padL={8} padR={104} padT={14} padB={16}
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
