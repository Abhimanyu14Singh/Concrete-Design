/**
 * SectionCard — one design group's cross-section as a thumbnail with its worst
 * per-mode DCRs (M⁺ / M⁻ / V) on the name row, live ρ / steel weight, and inline
 * cage editing (click a bar count/size to step it; '＋layer' adds a layer; the
 * stirrup line is size/spacing-editable with a '⅓' zoned-spacing toggle). Edits
 * apply to the whole group. Clicking the card selects the group.
 *
 * A small ⚑ sits after the top and bottom bar labels: it reports the L/3
 * curtailment check (RED = 50 % of the bars can't cover the third-point demand;
 * PURPLE = the region is over-provided, curtailment opportunity). Clicking it
 * opens a detail popover where the % can be pinned to the beam schedule notes.
 */
import { useState } from 'react';
import type { RebarLayout } from '../../types';
import type { DashboardGroup } from '../../utils/dashboardPayload';
import type { FaceCurtailment } from '../../utils/curtailment';
import SectionView from '../Detailing/SectionView';
import { DCRChip } from './dashboardShared';
import { BORDER, INK, ACCENT, STATUS, MONO_NUM } from '../../theme';

const flagColor = (fc: FaceCurtailment) => (fc.flag === 'red' ? STATUS.fail : ACCENT.primary);

export default function SectionCard({ group, selected, onSelect, onApplyRebar, onToggleCurtailmentNote }: {
  group: DashboardGroup;
  selected: boolean;
  onSelect: () => void;
  onApplyRebar: (groupId: string, rebar: RebarLayout) => void;
  onToggleCurtailmentNote?: (groupId: string, face: 'top' | 'bot', on: boolean) => void;
}) {
  const ng = group.govDCR > 1.0;
  const cu = group.curtailment;
  const [openFace, setOpenFace] = useState<'top' | 'bot' | null>(null);

  const faceFlag = (face: 'top' | 'bot') => {
    const fc = face === 'top' ? cu?.top : cu?.bot;
    if (!fc) return null;
    const where = face === 'top' ? 'middle third' : 'end thirds';
    return {
      color: flagColor(fc),
      title: `${face === 'top' ? 'Top' : 'Bottom'} · ${Math.round(fc.pctNeeded)}% needed through the ${where} (L/3) — click for detail`,
      onClick: () => setOpenFace(f => (f === face ? null : face)),
    };
  };

  const openFc: FaceCurtailment | null = openFace === 'top' ? cu?.top ?? null : openFace === 'bot' ? cu?.bot ?? null : null;
  const pinned = openFace === 'top' ? group.notePinned.top : openFace === 'bot' ? group.notePinned.bot : false;

  return (
    <div
      onDoubleClick={onSelect}
      title="Double-click to isolate this group on the plan"
      style={{
        position: 'relative',
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
          The ⚑ after each face label opens its L/3 curtailment detail.
          Clicking anywhere else on the card selects the group. */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <SectionView
          section={group.section}
          rebar={group.rebar}
          width={248} height={168}
          showDims={false} barLabels editBarSize editStirrup
          padL={8} padR={104} padT={14} padB={16}
          onRebarChange={r => onApplyRebar(group.id, r)}
          topFlag={faceFlag('top')}
          botFlag={faceFlag('bot')}
        />
      </div>

      <div style={{ display: 'flex', gap: 10, fontSize: 10, color: INK.secondary, ...MONO_NUM }}>
        <span title="Bottom steel ratio">ρ⁺ {group.rhoBot.toFixed(2)}%</span>
        <span title="Top steel ratio">ρ⁻ {group.rhoTop.toFixed(2)}%</span>
        <span title="Longitudinal steel weight">{group.steelWtLbFt.toFixed(1)} lb/ft</span>
        <span style={{ marginLeft: 'auto', color: INK.muted }}>{group.beamCount} beam{group.beamCount === 1 ? '' : 's'}</span>
      </div>

      {openFc && (
        <CurtailmentPopover
          face={openFace as 'top' | 'bot'}
          fc={openFc}
          pinned={pinned}
          canPin={!!onToggleCurtailmentNote}
          onPin={on => onToggleCurtailmentNote?.(group.id, openFace as 'top' | 'bot', on)}
          onClose={() => setOpenFace(null)}
        />
      )}
    </div>
  );
}

function CurtailmentPopover({ face, fc, pinned, canPin, onPin, onClose }: {
  face: 'top' | 'bot';
  fc: FaceCurtailment;
  pinned: boolean;
  canPin: boolean;
  onPin: (on: boolean) => void;
  onClose: () => void;
}) {
  const red = fc.flag === 'red';
  const color = red ? STATUS.fail : ACCENT.primary;
  const faceName = face === 'top' ? 'Top bars' : 'Bottom bars';
  const where = face === 'top' ? 'middle third (L/3)' : 'end thirds (L/3)';
  const pct = Math.round(fc.pctNeeded);
  return (
    <div
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      style={{
        position: 'absolute', top: 30, right: 8, zIndex: 20, width: 216,
        background: 'white', border: `1px solid ${color}`, borderRadius: 8,
        boxShadow: '0 6px 20px rgba(15,23,42,0.18)', padding: 10,
        display: 'flex', flexDirection: 'column', gap: 6, cursor: 'default',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color, fontWeight: 800, fontSize: 13 }}>⚑</span>
        <span style={{ fontWeight: 700, fontSize: 11.5, color: INK.strong }}>{faceName} · {where}</span>
        <div style={{ flex: 1 }} />
        <span onClick={onClose} title="Close" style={{ cursor: 'pointer', color: INK.muted, fontSize: 13, lineHeight: 1 }}>✕</span>
      </div>

      <div style={{ fontSize: 11, color: INK.secondary, lineHeight: 1.5 }}>
        <span style={{ color, fontWeight: 800, fontSize: 15, ...MONO_NUM }}>{pct}%</span>{' '}
        of the provided {face === 'top' ? 'top' : 'bottom'} steel is required through the {where}.
      </div>

      <div style={{ fontSize: 10, color: INK.muted, ...MONO_NUM }}>
        As,req {fc.asRequired.toFixed(2)} / As,prov {fc.asProvided.toFixed(2)} in²
        {fc.governedBy === 'code-min' ? ' · code As,min governs' : ` · Mregion ${Math.round(fc.demandMoment)} k·ft`}
      </div>

      <div style={{ fontSize: 10.5, color, fontWeight: 600, lineHeight: 1.45 }}>
        {red
          ? '50% of the bars would NOT cover this — keep more than half continuous.'
          : '50% of the bars is more than enough here — the balance may be curtailed.'}
      </div>

      {canPin && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: INK.secondary, cursor: 'pointer', marginTop: 2 }}>
          <input type="checkbox" checked={pinned} onChange={e => onPin(e.target.checked)} style={{ cursor: 'pointer' }} />
          Add this % to the beam schedule notes
        </label>
      )}
    </div>
  );
}
