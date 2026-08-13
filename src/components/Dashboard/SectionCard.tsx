/**
 * SectionCard — one design group's cross-section as a thumbnail with its worst
 * per-mode DCRs (M⁺ / M⁻ / V) on the name row, an error-beam count (beside the name
 * at panel width, beneath the chips in the 248px grid card),
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
import type { RebarLayout, BarGroup, SectionDimensions } from '../../types';
import type { DashboardGroup } from '../../utils/dashboardPayload';
import { type FaceCurtailment, type OppositeEndResult, suggestOppositeCage, suggestMidThirdCage, minBarsForArea, continuousCage } from '../../utils/curtailment';
import { barSizeStep, formatBarLabel } from '../../utils/rebar';
import { getBarArea } from '../../utils/concreteDesign';
import SectionView from '../Detailing/SectionView';
import { DCRChip } from './dashboardShared';
import { BORDER, INK, ACCENT, STATUS, MONO_NUM } from '../../theme';

const flagColor = (fc: FaceCurtailment) => (fc.flag === 'red' ? STATUS.fail : ACCENT.primary);
const OPP_BLUE = '#2563eb';   // opposite-end cage meets DCR
const OPP_AMBER = '#d97706';  // opposite end can take less (opportunity)
const MID_TEAL = '#0d9488';   // middle-third cage meets its curtailed demand
const BOT_BLUE = '#1565c0';   // end-third bottom cage meets its curtailed demand (matches bottom bars)

type OppState = 'met' | 'insufficient' | 'opportunity' | 'same' | null;
function oppStateOf(opp: OppositeEndResult | undefined): OppState {
  if (!opp?.hasStationData) return null;
  if (opp.hasOpposite) return opp.oppositeDcrMet ? 'met' : 'insufficient';
  return opp.reductionPossible ? 'opportunity' : 'same';
}
const oppColorOf = (s: OppState) =>
  s === 'met' ? OPP_BLUE : s === 'insufficient' ? STATUS.fail : s === 'opportunity' ? OPP_AMBER : INK.muted;

export default function SectionCard({ group, selected, onSelect, onApplyRebar, onToggleCurtailmentNote, onSetOppositeTop, onSetMidThirdTop, onSetEndThirdBot, onSetReviewed, onApplySection, editedDims, width = 248, height = 168, showDims = false, flat = false, layout = 'stack' }: {
  group: DashboardGroup;
  selected: boolean;
  onSelect: () => void;
  /** Drawing size. Defaults are the dashboard-grid card; a host that gives the card a
   *  whole panel passes something larger so the section is legible at that size. */
  width?: number;
  height?: number;
  /** Dimension arrows on the drawing (b, h). Off in the grid, where there is no room
   *  for them; on when the card has a panel to itself, so a group's section is drawn
   *  the same way a single member's is. */
  showDims?: boolean;
  /** Drop the card's own border, fill and padding. In a grid a card must read as a
   *  card; filling a panel it is the panel's body, and the extra frame just puts a box
   *  inside a box. */
  flat?: boolean;
  /**
   * Where the detail blocks go — the opposite-end / middle-third / end-third cages and
   * the ρ line.
   *
   *   'stack'  under the drawing, full width. The grid card's layout and the default:
   *            at 248px there is no second column to have.
   *   'split'  in a fixed column to the LEFT of the drawing. Each of those blocks is one
   *            line of text, and given a whole panel they were spanning it to say it
   *            while the drawing — the thing being looked at — was squeezed between
   *            them. The column's width is `--sc-side` (196px), so a host can tune it.
   */
  layout?: 'stack' | 'split';
  onApplyRebar: (groupId: string, rebar: RebarLayout) => void;
  /** Resize the group's section from the drawing's b / h dimensions. Applies to the whole
   *  group, like the cage does — absent, the dimensions stay plain labels. */
  onApplySection?: (groupId: string, section: SectionDimensions) => void;
  /** Which of b / h have been overridden since import — drawn with a * and bold. */
  editedDims?: { b?: boolean; h?: boolean };
  onToggleCurtailmentNote?: (groupId: string, face: 'top' | 'bot', on: boolean) => void;
  onSetOppositeTop?: (groupId: string, bars: BarGroup[] | null) => void;
  onSetMidThirdTop?: (groupId: string, bars: BarGroup[] | null) => void;
  onSetEndThirdBot?: (groupId: string, bars: BarGroup[] | null) => void;
  onSetReviewed?: (groupId: string, on: boolean) => void;
}) {
  // Engineer sign-off: a reviewed group shows "Reviewed" in place of its NG/warning
  // flags and is never painted red — the design is unchanged, only accepted.
  const reviewed = !!group.reviewed;
  const split = layout === 'split';
  const ng = !reviewed && group.govDCR > 1.0;
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
  const midBar = group.midThirdTopBars?.[0];
  const midArea = faceAreaOf(group.midThirdTopBars);
  // The middle-third cage must cover its own hogging demand AND code As,min.
  const midReq = Math.max(group.asMin, cu?.top?.asRequired ?? 0);
  // Exact worst middle-third hogging DCR from the engine (per-beam design pass);
  // falls back to the As-ratio only when the group carries no station forces.
  const midDCR = group.midThirdDcr ?? (midArea > 1e-9 ? midReq / midArea : Infinity);
  const midMeets = midDCR <= 1 + 1e-6;
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

  // ── End-third bottom reinforcement (curtail bottom steel toward the supports) ──
  // Revealed once the ⚑ bottom curtailment is pinned to the schedule notes. Seeds
  // from the auto ~continuous end cage; editing pins an explicit end-third cage.
  const autoEndBot = continuousCage(group.rebar.botBars, group.asMin);
  const endBotExplicit = group.endThirdBotBars?.length ? group.endThirdBotBars : null;
  const endBotBars = endBotExplicit ?? autoEndBot;
  const endBotBar = endBotBars[0];
  const endBotArea = faceAreaOf(endBotBars);
  // The end-third bottom cage must cover the end-third sagging demand AND As,min.
  const endBotReq = Math.max(group.asMin, cu?.bot?.asRequired ?? 0);
  // Exact worst end-third sagging DCR from the engine; As-ratio fallback if no data.
  const endBotDCR = group.endThirdDcr ?? (endBotArea > 1e-9 ? endBotReq / endBotArea : Infinity);
  const endBotMeets = endBotDCR <= 1 + 1e-6;
  const showEndBotRow = !!(onSetEndThirdBot && cu?.bot && group.notePinned.bot);
  const bumpEndBot = (field: 'count' | 'size', dir: 1 | -1) => {
    if (!onSetEndThirdBot) return;
    const size0 = group.rebar.botBars[0]?.barSize ?? 8;
    const cur = endBotExplicit?.[0] ?? endBotBar ?? { numBars: minBars(size0), barSize: size0 };
    const next: BarGroup = field === 'count'
      ? { ...cur, numBars: Math.max(minBars(cur.barSize), cur.numBars + dir) }
      : { ...cur, barSize: barSizeStep(cur.barSize, dir) };
    onSetEndThirdBot(group.id, [next]);
  };

  const openFc: FaceCurtailment | null = openFace === 'top' ? cu?.top ?? null : openFace === 'bot' ? cu?.bot ?? null : null;
  const pinned = openFace === 'top' ? group.notePinned.top : openFace === 'bot' ? group.notePinned.bot : false;

  const errN = group.errorBeamCount;
  const warnN = group.warnBeamCount;
  const reviewClick = (on: boolean) =>
    onSetReviewed ? (e: React.MouseEvent) => { e.stopPropagation(); onSetReviewed(group.id, on); } : undefined;

  /**
   * Error / warning tally → click to sign the group off as "Reviewed" (engineer
   * override). Reviewed groups read "✓ Reviewed" in green and drop out of the
   * tallies; click again to clear.
   *
   * Built once and placed by layout, because the two layouts want it in different
   * places. In `split` it sits beside the group NAME: that row has panel width to
   * spare, and the count belongs with the thing it counts — the group — rather than
   * hanging under three DCR chips it is not derived from. The 248px grid card cannot
   * afford it there (the name row is already dot + label + 👁 + three chips, and
   * adding ~60px would truncate the label to two letters), so `stack` keeps it under
   * the chips where the width is free.
   */
  const statusTally = reviewed ? (
    <span
      onClick={reviewClick(false)}
      title={`Reviewed — ${errN} NG${warnN ? ` / ${warnN} warned` : ''} beam${errN + warnN === 1 ? '' : 's'} accepted by the engineer.${onSetReviewed ? ' Click to clear.' : ''}`}
      style={{ fontSize: 10, fontWeight: 700, ...MONO_NUM, color: STATUS.ok, display: 'flex', alignItems: 'center', gap: 3, cursor: onSetReviewed ? 'pointer' : 'default' }}
    >
      <span style={{ fontSize: 10 }}>✓</span>Reviewed
    </span>
  ) : errN > 0 ? (
    <span
      onClick={reviewClick(true)}
      title={`${errN} of ${group.beamCount} beam${group.beamCount === 1 ? '' : 's'} fail (NG)${onSetReviewed ? ' — click to mark the group Reviewed' : ''}`}
      style={{ fontSize: 10, fontWeight: 700, ...MONO_NUM, color: STATUS.fail, display: 'flex', alignItems: 'center', gap: 3, cursor: onSetReviewed ? 'pointer' : 'default' }}
    >
      <span style={{ fontSize: 10 }}>▲</span>{errN} error{errN === 1 ? '' : 's'}
    </span>
  ) : warnN > 0 ? (
    <span
      onClick={reviewClick(true)}
      title={`${warnN} of ${group.beamCount} beam${group.beamCount === 1 ? '' : 's'} warned${onSetReviewed ? ' — click to mark the group Reviewed' : ''}`}
      style={{ fontSize: 10, fontWeight: 700, ...MONO_NUM, color: STATUS.warn, display: 'flex', alignItems: 'center', gap: 3, cursor: onSetReviewed ? 'pointer' : 'default' }}
    >
      <span style={{ fontSize: 10 }}>⚠</span>{warnN} warning{warnN === 1 ? '' : 's'}
    </span>
  ) : (
    <span
      title="All beams pass"
      style={{ fontSize: 10, fontWeight: 700, ...MONO_NUM, color: INK.muted, display: 'flex', alignItems: 'center', gap: 3 }}
    >
      <span style={{ fontSize: 10 }}>△</span>0 errors
    </span>
  );

  return (
    <div
      onDoubleClick={onSelect}
      title="Double-click to isolate this group on the plan"
      style={{
        position: 'relative',
        border: flat
          ? 'none'
          : `1px solid ${selected ? ACCENT.primary : reviewed ? STATUS.okBorder : ng ? STATUS.failBorder : BORDER.default}`,
        // Flat keeps the status TINT — a failing group should still read red — but drops
        // the frame. Losing the tint as well would make the one thing the card exists to
        // signal disappear the moment it got more room.
        background: reviewed ? STATUS.okBg : ng ? STATUS.failBg : flat ? 'transparent' : selected ? ACCENT.softBg : 'white',
        borderRadius: flat ? 0 : 10, padding: flat ? 0 : 8, cursor: flat ? 'default' : 'pointer',
        display: 'flex', flexDirection: 'column', gap: 6,
        boxShadow: !flat && selected ? `0 0 0 1px ${ACCENT.primary}` : 'none',
      }}
    >
      {/* Name row + the group's worst per-mode DCRs (M⁺ / M⁻ / V). The status tally
          sits beside the NAME in `split` and under the chips in `stack` — see
          `statusTally`. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: group.color ?? INK.muted, flexShrink: 0, marginTop: 2 }} />
        <span style={{ minWidth: 0, fontSize: 12, fontWeight: 700, color: INK.strong, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...(split ? null : { flex: 1 }) }}>
          {group.label}
          {group.face && (
            <span
              title={group.face === 'top' ? 'Top (M⁻ / hogging) governed' : 'Bottom (M⁺ / sagging) governed'}
              style={{ marginLeft: 4, fontSize: 10, fontWeight: 700, color: ACCENT.primary }}
            >({group.face === 'top' ? 'T' : 'B'})</span>
          )}
        </span>
        {/* Beside the name, not under the DCRs. `flex: 1` moves off the label and onto
            this spacer so the tally hugs the name however long the name is, instead of
            being flung to the far side of a stretched label. */}
        {split && <span style={{ flexShrink: 0, marginTop: 1 }}>{statusTally}</span>}
        {split && <span style={{ flex: 1, minWidth: 0 }} />}
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
          {!split && statusTally}
        </span>
      </div>

      {/* Section drawing — bars + stirrups are click-editable. ⚑ = L/3 curtailment,
          ◨ = opposite-end top steel. Clicking elsewhere selects the group.

          Dimensions need gutters the grid card does not: the h arrow and its rotated
          label live in padL, and the b arrow plus its text sit in padB. At the card's own
          14/16 the width label falls outside the SVG and simply is not drawn. */}
      {/* Drawing and detail. In `stack` (the card's own layout, and the default) both
          wrappers are `display: contents`, so their children fall straight into the
          card's flex column exactly as they did before this split existed — the grid
          card is untouched.

          In `split` this becomes a row: the detail blocks collect into a fixed column on
          the LEFT and the drawing takes everything else. The detail rows are each one
          line of text and were spanning the full width of a whole panel to say it, while
          the drawing — the thing you are actually looking at — was squeezed between them.
          Ordered with CSS rather than by moving 130 lines of JSX, so the two layouts can
          never drift apart. */}
      <div style={split ? { display: 'flex', gap: 10, alignItems: 'stretch', minWidth: 0 } : { display: 'contents' }}>
        <div style={{ display: 'flex', justifyContent: 'center', ...(split ? { flex: 1, minWidth: 0, alignItems: 'flex-start' } : null) }}>
          <SectionView
            section={group.section}
            rebar={group.rebar}
            width={width} height={height}
            showDims={showDims} barLabels editBarSize editStirrup
            padL={showDims ? 60 : 48} padR={104}
            padT={showDims ? 20 : 14} padB={showDims ? 38 : 16}
            onRebarChange={r => onApplyRebar(group.id, r)}
          onSectionChange={onApplySection ? (sec => onApplySection(group.id, sec)) : undefined}
          editedDims={editedDims}
            topFlag={faceFlag('top')}
            botFlag={faceFlag('bot')}
            topFlag2={topFlag2}
          />
        </div>

        <div style={split
          ? { order: -1, flex: '0 0 var(--sc-side, 196px)', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }
          : { display: 'contents' }}>

      {/* Opposite-end top reinforcement — editable when set. */}
      {opp?.hasOpposite && oppBar && (
        <div
          onClick={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, ...MONO_NUM,
            // One line, always. These rows live in a 196px side column when the card is
            // split, and without this the label, the bar text and the DCR each wrap
            // independently — three lines of chrome around one number. nowrap keeps the
            // row intact; the flexible spacer before ✕ is what absorbs the slack.
            whiteSpace: 'nowrap',
            padding: '3px 6px', borderRadius: 6, cursor: 'default',
            border: `1px solid ${opp.oppositeDcrMet ? OPP_BLUE : STATUS.fail}`,
            background: opp.oppositeDcrMet ? '#eff6ff' : STATUS.failBg,
          }}
        >
          <span style={{ color: opp.oppositeDcrMet ? OPP_BLUE : STATUS.fail, fontWeight: 700 }}>◨</span>
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
            display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, ...MONO_NUM,
            // One line, always. These rows live in a 196px side column when the card is
            // split, and without this the label, the bar text and the DCR each wrap
            // independently — three lines of chrome around one number. nowrap keeps the
            // row intact; the flexible spacer before ✕ is what absorbs the slack.
            whiteSpace: 'nowrap',
            padding: '3px 6px', borderRadius: 6, cursor: 'default',
            border: `1px solid ${midMeets ? MID_TEAL : STATUS.fail}`,
            background: midMeets ? '#f0fdfa' : STATUS.failBg,
          }}
        >
          <span style={{ color: midMeets ? MID_TEAL : STATUS.fail, fontWeight: 700 }}>⅓</span>
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
          <span title="Worst-beam flexural DCR of the middle-third top cage against the middle-third hogging demand" style={{ color: midMeets ? MID_TEAL : STATUS.fail, fontWeight: 700 }}>
            DCR {midDCR.toFixed(2)} {midMeets ? '✓' : '✗'}
          </span>
          <span style={{ flex: 1 }} />
          <span onClick={e => { e.stopPropagation(); onSetMidThirdTop?.(group.id, null); }} title="Remove middle-third curtailment" style={{ cursor: 'pointer', color: INK.muted, fontWeight: 700 }}>✕</span>
        </div>
      ) : (onSetMidThirdTop && cu?.top && (
        <button
          onClick={e => { e.stopPropagation(); toggleMid(); }}
          title="Curtail the top steel through the middle third to a chosen percentage (never below code As,min)"
          style={{
            alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 10, fontWeight: 700, color: MID_TEAL, ...MONO_NUM,
            border: `1px dashed ${MID_TEAL}`, background: '#f0fdfa', borderRadius: 6,
            padding: '2px 7px', cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: 11 }}>⅓</span> curtail mid-third top
        </button>
      ))}

      {/* End-third bottom reinforcement — the curtailed bottom cage kept through
          the two END thirds. Revealed by pinning the ⚑ bottom curtailment note;
          seeds from the auto ~continuous cage, then editable. Drives the moment
          diagram's φMn⁺ end-third step and the eye pop-out's support sections. */}
      {showEndBotRow && (
        <div
          onClick={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, ...MONO_NUM,
            // One line, always. These rows live in a 196px side column when the card is
            // split, and without this the label, the bar text and the DCR each wrap
            // independently — three lines of chrome around one number. nowrap keeps the
            // row intact; the flexible spacer before ✕ is what absorbs the slack.
            whiteSpace: 'nowrap',
            padding: '3px 6px', borderRadius: 6, cursor: 'default',
            border: `1px solid ${endBotMeets ? BOT_BLUE : STATUS.fail}`,
            background: endBotMeets ? '#eff6ff' : STATUS.failBg,
          }}
        >
          <span style={{ color: endBotMeets ? BOT_BLUE : STATUS.fail, fontWeight: 700 }}>⅓</span>
          <span style={{ color: INK.secondary }}>End ⅓ bot</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <span
              onClick={e => { e.stopPropagation(); bumpEndBot('count', 1); }}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); bumpEndBot('count', -1); }}
              style={{ cursor: 'pointer', textDecoration: 'underline', fontWeight: 700, color: INK.strong }}
            >{endBotBar?.numBars ?? 0}</span>
            <span style={{ color: INK.muted }}>-</span>
            <span
              onClick={e => { e.stopPropagation(); bumpEndBot('size', 1); }}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); bumpEndBot('size', -1); }}
              style={{ cursor: 'pointer', textDecoration: 'underline', fontWeight: 700, color: INK.strong }}
            >{formatBarLabel(endBotBar?.barSize ?? 8)}</span>
          </span>
          <span title="Worst-beam flexural DCR of the end-third bottom cage against the end-third sagging demand" style={{ color: endBotMeets ? BOT_BLUE : STATUS.fail, fontWeight: 700 }}>
            DCR {endBotDCR.toFixed(2)} {endBotMeets ? '✓' : '✗'}
          </span>
          <span style={{ flex: 1 }} />
          {endBotExplicit && (
            <span onClick={e => { e.stopPropagation(); onSetEndThirdBot?.(group.id, null); }} title="Reset to the auto end-third cage" style={{ cursor: 'pointer', color: INK.muted, fontWeight: 700 }}>↺</span>
          )}
        </div>
      )}

      {/* ρ and steel weight. Wraps in the split column, where 196px cannot hold four
          figures on one line; unchanged in the card, where it has the full width. */}
      <div style={{ display: 'flex', gap: 10, fontSize: 10, color: INK.secondary, ...MONO_NUM, ...(split ? { flexWrap: 'wrap' as const, marginTop: 'auto' } : null) }}>
        <span title="Bottom steel ratio">ρ⁺ {group.rhoBot.toFixed(2)}%</span>
        <span title="Top steel ratio">ρ⁻ {group.rhoTop.toFixed(2)}%</span>
        <span title="Longitudinal steel weight">{group.steelWtLbFt.toFixed(1)} lb/ft</span>
        {/* The beam count identifies a card among a grid of them. Filling a panel there
            is only one group on screen and its size is already in the panel's own header,
            so repeating it here is a line of text that answers nothing. */}
        {!flat && (
          <span style={{ marginLeft: 'auto', color: INK.muted }}>{group.beamCount} beam{group.beamCount === 1 ? '' : 's'}</span>
        )}
      </div>

        </div>{/* end detail column */}
      </div>{/* end drawing + detail */}

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
        <span style={{ color, fontWeight: 700, fontSize: 13 }}>⚑</span>
        <span style={{ fontWeight: 700, fontSize: 12, color: INK.strong }}>{faceName} · {where}</span>
        <div style={{ flex: 1 }} />
        <span onClick={onClose} title="Close" style={{ cursor: 'pointer', color: INK.muted, fontSize: 13, lineHeight: 1 }}>✕</span>
      </div>

      <div style={{ fontSize: 11, color: INK.secondary, lineHeight: 1.5 }}>
        <span style={{ color, fontWeight: 700, fontSize: 13, ...MONO_NUM }}>{pct}%</span>{' '}
        of the provided {face === 'top' ? 'top' : 'bottom'} steel is required through the {where}.
      </div>

      <div style={{ fontSize: 10, color: INK.muted, ...MONO_NUM }}>
        As,req {fc.asRequired.toFixed(2)} / As,prov {fc.asProvided.toFixed(2)} in²
        {fc.governedBy === 'code-min' ? ' · code As,min governs' : ` · Mregion ${Math.round(fc.demandMoment)} k·ft`}
      </div>

      <div style={{ fontSize: 10, color, fontWeight: 600, lineHeight: 1.45 }}>
        {red
          ? '50% of the bars would NOT cover this — keep more than half continuous.'
          : '50% of the bars is more than enough here — the balance may be curtailed.'}
      </div>

      {canPin && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: INK.secondary, cursor: 'pointer', marginTop: 2 }}>
          <input type="checkbox" checked={pinned} onChange={e => onPin(e.target.checked)} style={{ cursor: 'pointer' }} />
          Add this % to the beam schedule notes
        </label>
      )}
    </div>
  );
}

/** Pop-out: the section drawn at each L/3 region — mark end, middle third and
 *  opposite end — reflecting BOTH the top cage (full at the supports, curtailed
 *  through mid-span) and the bottom cage (full at mid-span, curtailed toward the
 *  supports via the ⚑ bottom curtailment), with ρ⁻/ρ⁺ under each. */
function RegionSectionsModal({ group, onClose }: { group: DashboardGroup; onClose: () => void }) {
  const { section, rebar } = group;
  const areaOf = (bars?: BarGroup[]) =>
    (bars ?? []).reduce((s, b) => s + Math.max(0, b.numBars) * getBarArea(b.barSize), 0);
  const asTopMark = areaOf(rebar.topBars) || 1e-9;
  const asBotMark = areaOf(rebar.botBars) || 1e-9;
  // ρ scales with each face's steel area (same section + d across regions), anchored
  // to the card's mark-end ratios so the numbers match what the card shows.
  const rhoTopOf = (bars?: BarGroup[]) => group.rhoTop * (areaOf(bars) / asTopMark);
  const rhoBotOf = (bars?: BarGroup[]) => group.rhoBot * (areaOf(bars) / asBotMark);
  const desc = (bars?: BarGroup[]) => {
    const a = (bars ?? []).filter(b => b.numBars > 0);
    return a.length ? a.map(b => `${b.numBars}-${formatBarLabel(b.barSize)}`).join(' + ') : '—';
  };
  // Bottom (sagging) steel: full at mid-span, curtailed toward the supports —
  // an explicit end-third bottom cage (End ⅓ bot row) wins; else the auto
  // ~continuous cage the ⚑ bottom flag represents.
  const reducedBot = continuousCage(rebar.botBars, group.asMin);
  const explicitEndBot = group.endThirdBotBars?.length ? group.endThirdBotBars : null;
  const botReduces = areaOf(reducedBot) < asBotMark - 1e-6;
  const endBot = explicitEndBot ?? (botReduces ? reducedBot : rebar.botBars);
  const midTop = group.midThirdTopBars?.length ? group.midThirdTopBars : rebar.topBars;
  const oppTop = group.oppositeTopBars?.length ? group.oppositeTopBars : rebar.topBars;
  const regions: { key: string; title: string; top: BarGroup[]; bot: BarGroup[] }[] = [
    { key: 'mark', title: 'Mark End', top: rebar.topBars, bot: endBot },        // support: top full, bottom curtailed
    { key: 'mid',  title: 'Middle ⅓', top: midTop,        bot: rebar.botBars }, // mid-span: top curtailed, bottom full
    { key: 'opp',  title: 'Opp. End', top: oppTop,        bot: endBot },        // support: top reduced, bottom curtailed
  ];
  const TEAL = '#0d9488';
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
          <span style={{ fontSize: 16, fontWeight: 700, color: INK.strong }}>{group.label}</span>
          <span style={{ fontSize: 12, color: INK.muted }}>— section by L/3 region</span>
          <div style={{ flex: 1 }} />
          <span onClick={onClose} title="Close" style={{ cursor: 'pointer', color: INK.muted, fontSize: 16, lineHeight: 1 }}>✕</span>
        </div>
        <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
          {regions.map(r => (
            <div key={r.key} style={{ textAlign: 'center', width: 168 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: ACCENT.primary }}>{r.title}</div>
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 3 }}>
                <SectionView
                  section={section}
                  rebar={{ ...rebar, topBars: r.top, botBars: r.bot }}
                  width={168} height={210}
                  showDims={false}
                  padL={14} padR={14} padT={12} padB={12}
                />
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, ...MONO_NUM, marginTop: 5, color: ACCENT.primary }}>
                ρ⁻ {rhoTopOf(r.top).toFixed(2)}% <span style={{ color: INK.muted, fontWeight: 400 }}>· {desc(r.top)} top</span>
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, ...MONO_NUM, marginTop: 2, color: TEAL }}>
                ρ⁺ {rhoBotOf(r.bot).toFixed(2)}% <span style={{ color: INK.muted, fontWeight: 400 }}>· {desc(r.bot)} bot</span>
              </div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 10, color: INK.muted, marginTop: 10, textAlign: 'center', maxWidth: 540 }}>
          Top steel governs at the supports and is curtailed through mid-span; bottom steel governs at mid-span and is curtailed toward the supports (the ⚑ bottom flag).
        </div>
      </div>
    </div>
  );
}
