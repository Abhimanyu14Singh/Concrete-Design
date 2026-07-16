/**
 * SectionCard — one design group's cross-section as a thumbnail with its worst
 * per-mode DCRs (M⁺ / M⁻ / V) on the name row, an error-beam count beneath them,
 * live ρ / steel weight, and inline cage editing (click a bar count/size to step
 * it; '＋layer' adds a layer; the stirrup line is size/spacing-editable). Edits
 * apply to the whole group. Clicking the card selects the group.
 *
 * After the top/bottom bar labels sit small status icons:
 *   ⚑  L/3 curtailment (RED = 50 % can't cover the third-point demand; PURPLE =
 *      over-provided). Click for a detail popover + schedule-note pin.
 *   ◨  (top only) opposite-end top steel. AMBER = the far end can take less;
 *      click to add a reduced opposite-end cage. Then tweak it (left/right-click)
 *      until it turns BLUE = the reduced cage meets the opposite-end DCR for the
 *      whole group. RED = the set opposite cage is still short.
 */
import { useState } from 'react';
import type { RebarLayout, BarGroup } from '../../types';
import type { DashboardGroup } from '../../utils/dashboardPayload';
import { type FaceCurtailment, type OppositeEndResult, suggestOppositeCage, suggestMidThirdCage, minBarsForArea } from '../../utils/curtailment';
import { barSizeStep, formatBarLabel } from '../../utils/rebar';
import { getBarArea } from '../../utils/concreteDesign';
import SectionView from '../Detailing/SectionView';
import { DCRChip } from './dashboardShared';
import { BORDER, INK, ACCENT, STATUS, MONO_NUM } from '../../theme';

const flagColor = (fc: FaceCurtailment) => (fc.flag === 'red' ? STATUS.fail : ACCENT.primary);
const OPP_BLUE = '#2563eb';   // opposite-end cage meets DCR
const OPP_AMBER = '#d97706';  // opposite end can take less (opportunity)
const MID_TEAL = '#0d9488';   // middle-third cage meets its curtailed demand

type OppState = 'met' | 'insufficient' | 'opportunity' | 'same' | null;
function oppStateOf(opp: OppositeEndResult | undefined): OppState {
  if (!opp?.hasStationData) return null;
  if (opp.hasOpposite) return opp.oppositeDcrMet ? 'met' : 'insufficient';
  return opp.reductionPossible ? 'opportunity' : 'same';
}
const oppColorOf = (s: OppState) =>
  s === 'met' ? OPP_BLUE : s === 'insufficient' ? STATUS.fail : s === 'opportunity' ? OPP_AMBER : INK.muted;

export default function SectionCard({ group, selected, onSelect, onApplyRebar, onToggleCurtailmentNote, onSetOppositeTop, onSetMidThirdTop }: {
  group: DashboardGroup;
  selected: boolean;
  onSelect: () => void;
  onApplyRebar: (groupId: string, rebar: RebarLayout) => void;
  onToggleCurtailmentNote?: (groupId: string, face: 'top' | 'bot', on: boolean) => void;
  onSetOppositeTop?: (groupId: string, bars: BarGroup[] | null) => void;
  onSetMidThirdTop?: (groupId: string, bars: BarGroup[] | null) => void;
}) {
  const ng = group.govDCR > 1.0;
  const cu = group.curtailment;
  const opp = group.oppositeEnd;
  const [openFace, setOpenFace] = useState<'top' | 'bot' | null>(null);
  const [showRegions, setShowRegions] = useState(false);

  const faceFlag = (face: 'top' | 'bot') => {
    const fc = face === 'top' ? cu?.top : cu?.bot;
    if (!fc) return null;
    const where = face === 'top' ? 'middle third' : 'end thirds';
    // Green once the % is pinned to the schedule notes — the flag doubles as a
    // "this curtailment is recorded" indicator.
    const pinned = face === 'top' ? group.notePinned.top : group.notePinned.bot;
    return {
      color: pinned ? STATUS.ok : flagColor(fc),
      title: `${face === 'top' ? 'Top' : 'Bottom'} · ${Math.round(fc.pctNeeded)}% needed through the ${where} (L/3)${pinned ? ' · pinned to schedule notes' : ' — click for detail'}`,
      onClick: () => setOpenFace(f => (f === face ? null : face)),
    };
  };

  // ◨ opposite-end top-steel status icon (after the top curtailment flag).
  const oppState = oppStateOf(opp);
  const oppBar = group.oppositeTopBars?.[0];
  const toggleOpposite = () => {
    if (!onSetOppositeTop || !opp?.hasStationData) return;
    if (opp.hasOpposite) onSetOppositeTop(group.id, null);            // remove
    else onSetOppositeTop(group.id, suggestOppositeCage(group.rebar, opp)); // add a reduced starting cage
  };
  const oppTitle =
    oppState === 'met' ? `Opposite end OK — ${oppBar?.numBars}-${formatBarLabel(oppBar?.barSize ?? 8)} meets DCR ${opp!.worstOppositeDcr.toFixed(2)} (click to remove)`
    : oppState === 'insufficient' ? `Opposite end short — DCR ${opp!.worstOppositeDcr.toFixed(2)} > 1; increase the bars`
    : oppState === 'opportunity' ? `Opposite end can take less (needs ~${Math.round(opp!.reductionPct)}% of the mark steel) — click to add a reduced cage`
    : 'Opposite end needs the same top steel as the mark side';
  const topFlag2 = oppState ? { color: oppColorOf(oppState), title: oppTitle, onClick: toggleOpposite } : null;

  // Every per-region top cage must satisfy code As,min — reducing the bar count
  // can never drop a region below minimum steel (the Group Dashboard side of the
  // "minimum reinforcement at any span" guarantee).
  const minBars = (size: number) => minBarsForArea(group.asMin, size);
  const bumpOpp = (field: 'count' | 'size', dir: 1 | -1) => {
    if (!onSetOppositeTop) return;
    const cur = oppBar ?? { numBars: minBars(group.rebar.topBars[0]?.barSize ?? 8), barSize: group.rebar.topBars[0]?.barSize ?? 8 };
    const next: BarGroup = field === 'count'
      ? { ...cur, numBars: Math.max(minBars(cur.barSize), cur.numBars + dir) }
      : { ...cur, barSize: barSizeStep(cur.barSize, dir) };
    onSetOppositeTop(group.id, [next]);
  };

  // ── Middle-third top reinforcement (curtail top steel through mid-span) ──────
  const faceAreaOf = (bars?: BarGroup[]) => (bars ?? []).reduce((s, b) => s + Math.max(0, b.numBars) * getBarArea(b.barSize), 0);
  const markTopArea = faceAreaOf(group.rebar.topBars);
  const midBar = group.midThirdTopBars?.[0];
  const midArea = faceAreaOf(group.midThirdTopBars);
  const midPct = markTopArea > 1e-9 ? (midArea / markTopArea) * 100 : 0;
  // The middle-third cage must cover its own hogging demand AND code As,min.
  const midReq = Math.max(group.asMin, cu?.top?.asRequired ?? 0);
  const midMeets = midArea >= midReq - 1e-4;
  const toggleMid = () => {
    if (!onSetMidThirdTop) return;
    if (group.midThirdTopBars?.length) onSetMidThirdTop(group.id, null);                         // remove
    else onSetMidThirdTop(group.id, suggestMidThirdCage(group.rebar.topBars, group.asMin));      // ~50%, ≥ As,min
  };
  const bumpMid = (field: 'count' | 'size', dir: 1 | -1) => {
    if (!onSetMidThirdTop) return;
    const size0 = group.rebar.topBars[0]?.barSize ?? 8;
    const cur = midBar ?? { numBars: minBars(size0), barSize: size0 };
    const next: BarGroup = field === 'count'
      ? { ...cur, numBars: Math.max(minBars(cur.barSize), cur.numBars + dir) }
      : { ...cur, barSize: barSizeStep(cur.barSize, dir) };
    onSetMidThirdTop(group.id, [next]);
  };

  const openFc: FaceCurtailment | null = openFace === 'top' ? cu?.top ?? null : openFace === 'bot' ? cu?.bot ?? null : null;
  const pinned = openFace === 'top' ? group.notePinned.top : openFace === 'bot' ? group.notePinned.bot : false;

  const errN = group.errorBeamCount;

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
      {/* Name row + the group's worst per-mode DCRs (M⁺ / M⁻ / V), with the
          error-beam count stacked under the chips. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: group.color ?? INK.muted, flexShrink: 0, marginTop: 2 }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: INK.strong, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {group.label}
          {group.face && (
            <span
              title={group.face === 'top' ? 'Top (M⁻ / hogging) governed' : 'Bottom (M⁺ / sagging) governed'}
              style={{ marginLeft: 4, fontSize: 10, fontWeight: 800, color: ACCENT.primary }}
            >({group.face === 'top' ? 'T' : 'B'})</span>
          )}
        </span>
        <button
          onClick={e => { e.stopPropagation(); setShowRegions(true); }}
          title="View the section at each L/3 region — mark end / middle / opposite end — with its reinforcement ratio"
          style={{ flexShrink: 0, border: `1px solid ${BORDER.default}`, background: 'white', borderRadius: 6, cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '2px 5px', marginTop: 1 }}
        >👁</button>
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
          <span style={{ display: 'flex', gap: 5 }}>
            <DCRChip label="M⁺" value={group.maxFlexPos} />
            <DCRChip label="M⁻" value={group.maxFlexNeg} />
            <DCRChip label="V" value={group.maxShear} />
          </span>
          <span
            title={`${errN} of ${group.beamCount} beam${group.beamCount === 1 ? '' : 's'} fail (NG)`}
            style={{ fontSize: 10, fontWeight: 700, ...MONO_NUM, color: errN > 0 ? STATUS.fail : INK.muted, display: 'flex', alignItems: 'center', gap: 3 }}
          >
            <span style={{ fontSize: 9 }}>{errN > 0 ? '▲' : '△'}</span>{errN} error{errN === 1 ? '' : 's'}
          </span>
        </span>
      </div>

      {/* Section drawing — bars + stirrups are click-editable. ⚑ = L/3 curtailment,
          ◨ = opposite-end top steel. Clicking elsewhere selects the group. */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <SectionView
          section={group.section}
          rebar={group.rebar}
          width={248} height={168}
          showDims={false} barLabels editBarSize editStirrup
          padL={48} padR={104} padT={14} padB={16}
          onRebarChange={r => onApplyRebar(group.id, r)}
          topFlag={faceFlag('top')}
          botFlag={faceFlag('bot')}
          topFlag2={topFlag2}
        />
      </div>

      {/* Opposite-end top reinforcement — editable when set. */}
      {opp?.hasOpposite && oppBar && (
        <div
          onClick={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, ...MONO_NUM,
            padding: '3px 6px', borderRadius: 6, cursor: 'default',
            border: `1px solid ${opp.oppositeDcrMet ? OPP_BLUE : STATUS.fail}`,
            background: opp.oppositeDcrMet ? '#eff6ff' : STATUS.failBg,
          }}
        >
          <span style={{ color: opp.oppositeDcrMet ? OPP_BLUE : STATUS.fail, fontWeight: 800 }}>◨</span>
          <span style={{ color: INK.secondary }}>Opp. end</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <span
              onClick={e => { e.stopPropagation(); bumpOpp('count', 1); }}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); bumpOpp('count', -1); }}
              style={{ cursor: 'pointer', textDecoration: 'underline', fontWeight: 700, color: INK.strong }}
            >{oppBar.numBars}</span>
            <span style={{ color: INK.muted }}>-</span>
            <span
              onClick={e => { e.stopPropagation(); bumpOpp('size', 1); }}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); bumpOpp('size', -1); }}
              style={{ cursor: 'pointer', textDecoration: 'underline', fontWeight: 700, color: INK.strong }}
            >{formatBarLabel(oppBar.barSize)}</span>
          </span>
          <span style={{ color: opp.oppositeDcrMet ? OPP_BLUE : STATUS.fail, fontWeight: 700 }}>
            DCR {opp.worstOppositeDcr.toFixed(2)} {opp.oppositeDcrMet ? '✓' : '✗'}
          </span>
          <span style={{ flex: 1 }} />
          <span title="L+ bars / R− · click the size for L larger / R smaller" style={{ color: INK.muted, fontSize: 8 }}>L+/R−</span>
          <span onClick={e => { e.stopPropagation(); onSetOppositeTop?.(group.id, null); }} title="Remove opposite-end reinforcement" style={{ cursor: 'pointer', color: INK.muted, fontWeight: 700 }}>✕</span>
        </div>
      )}

      {/* Middle-third top reinforcement — the curtailed top cage kept through
          mid-span, at a user-chosen percentage (never below code As,min). */}
      {midBar ? (
        <div
          onClick={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, ...MONO_NUM,
            padding: '3px 6px', borderRadius: 6, cursor: 'default',
            border: `1px solid ${midMeets ? MID_TEAL : STATUS.fail}`,
            background: midMeets ? '#f0fdfa' : STATUS.failBg,
          }}
        >
          <span style={{ color: midMeets ? MID_TEAL : STATUS.fail, fontWeight: 800 }}>⅓</span>
          <span style={{ color: INK.secondary }}>Mid ⅓</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <span
              onClick={e => { e.stopPropagation(); bumpMid('count', 1); }}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); bumpMid('count', -1); }}
              style={{ cursor: 'pointer', textDecoration: 'underline', fontWeight: 700, color: INK.strong }}
            >{midBar.numBars}</span>
            <span style={{ color: INK.muted }}>-</span>
            <span
              onClick={e => { e.stopPropagation(); bumpMid('size', 1); }}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); bumpMid('size', -1); }}
              style={{ cursor: 'pointer', textDecoration: 'underline', fontWeight: 700, color: INK.strong }}
            >{formatBarLabel(midBar.barSize)}</span>
          </span>
          <span title="Percent of the mark-end top steel kept continuous through the middle third (≥ code As,min)" style={{ color: midMeets ? MID_TEAL : STATUS.fail, fontWeight: 700 }}>
            {Math.round(midPct)}% {midMeets ? '✓' : '✗'}
          </span>
          <span style={{ flex: 1 }} />
          <span title="L+ bars / R− · click the size for L larger / R smaller · floored at code As,min" style={{ color: INK.muted, fontSize: 8 }}>L+/R−</span>
          <span onClick={e => { e.stopPropagation(); onSetMidThirdTop?.(group.id, null); }} title="Remove middle-third curtailment" style={{ cursor: 'pointer', color: INK.muted, fontWeight: 700 }}>✕</span>
        </div>
      ) : (onSetMidThirdTop && cu?.top && (
        <button
          onClick={e => { e.stopPropagation(); toggleMid(); }}
          title="Curtail the top steel through the middle third to a chosen percentage (never below code As,min)"
          style={{
            alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 9.5, fontWeight: 700, color: MID_TEAL, ...MONO_NUM,
            border: `1px dashed ${MID_TEAL}`, background: '#f0fdfa', borderRadius: 6,
            padding: '2px 7px', cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: 11 }}>⅓</span> curtail mid-third top
        </button>
      ))}

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

      {showRegions && (
        <RegionSectionsModal group={group} onClose={() => setShowRegions(false)} />
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

/** Pop-out: the section drawn at each L/3 region — mark end, middle third and
 *  opposite end — reflecting that region's TOP cage, with the top reinforcement
 *  ratio ρ⁻ under each (bottom steel ρ⁺ is constant along the span). */
function RegionSectionsModal({ group, onClose }: { group: DashboardGroup; onClose: () => void }) {
  const { section, rebar } = group;
  const areaOf = (bars?: BarGroup[]) =>
    (bars ?? []).reduce((s, b) => s + Math.max(0, b.numBars) * getBarArea(b.barSize), 0);
  const asMark = areaOf(rebar.topBars) || 1e-9;
  // ρ⁻ scales with the top-steel area (same section + d_top across regions), anchored
  // to the card's mark-end ratio so it matches the ρ⁻ shown on the card.
  const rhoOf = (bars?: BarGroup[]) => group.rhoTop * (areaOf(bars) / asMark);
  const desc = (bars?: BarGroup[]) => {
    const a = (bars ?? []).filter(b => b.numBars > 0);
    return a.length ? a.map(b => `${b.numBars}-${formatBarLabel(b.barSize)}`).join(' + ') : '—';
  };
  const regions: { key: string; title: string; sub: string; top: BarGroup[] }[] = [
    { key: 'mark', title: 'Mark End', sub: 'governing top cage', top: rebar.topBars },
    { key: 'mid',  title: 'Middle ⅓', sub: group.midThirdTopBars?.length ? 'curtailed cage' : 'full (no curtailment)', top: group.midThirdTopBars?.length ? group.midThirdTopBars : rebar.topBars },
    { key: 'opp',  title: 'Opp. End', sub: group.oppositeTopBars?.length ? 'reduced cage' : 'same as mark', top: group.oppositeTopBars?.length ? group.oppositeTopBars : rebar.topBars },
  ];
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(15,23,42,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        onDoubleClick={e => e.stopPropagation()}
        style={{ background: 'white', borderRadius: 12, padding: 16, boxShadow: '0 12px 40px rgba(15,23,42,0.28)', maxWidth: '92vw', maxHeight: '90vh', overflow: 'auto', cursor: 'default' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ width: 11, height: 11, borderRadius: 3, background: group.color ?? INK.muted }} />
          <span style={{ fontSize: 14, fontWeight: 800, color: INK.strong }}>{group.label}</span>
          <span style={{ fontSize: 12, color: INK.muted }}>— section by L/3 region (top steel)</span>
          <div style={{ flex: 1 }} />
          <span onClick={onClose} title="Close" style={{ cursor: 'pointer', color: INK.muted, fontSize: 16, lineHeight: 1 }}>✕</span>
        </div>
        <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
          {regions.map(r => (
            <div key={r.key} style={{ textAlign: 'center', width: 168 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: ACCENT.primary }}>{r.title}</div>
              <div style={{ fontSize: 9.5, color: INK.muted, marginBottom: 4 }}>{r.sub}</div>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <SectionView
                  section={section}
                  rebar={{ ...rebar, topBars: r.top }}
                  width={168} height={210}
                  showDims={false}
                  padL={14} padR={14} padT={12} padB={12}
                />
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: INK.strong, ...MONO_NUM, marginTop: 5 }}>{desc(r.top)} <span style={{ color: INK.muted, fontWeight: 400 }}>top</span></div>
              <div style={{ fontSize: 13, fontWeight: 800, color: ACCENT.primary, ...MONO_NUM, marginTop: 3 }}>ρ⁻ = {rhoOf(r.top).toFixed(2)}%</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 10.5, color: INK.muted, ...MONO_NUM, marginTop: 10, textAlign: 'center' }}>
          Bottom steel constant along the span: {desc(rebar.botBars)} · ρ⁺ = {group.rhoBot.toFixed(2)}%
        </div>
      </div>
    </div>
  );
}
