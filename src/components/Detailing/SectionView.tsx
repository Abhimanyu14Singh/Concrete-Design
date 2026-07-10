import { formatBarLabel, barSizeStep } from '../../utils/rebar';
import type { ReactElement } from 'react';
import type { SectionDimensions, RebarLayout, DesignResults, TieZone } from '../../types';
import { getBarDiam, getBarArea } from '../../utils/concreteDesign';
import { useUnits } from '../../contexts/UnitsContext';
import { BARS, DCR, FONT } from '../../theme';

interface Props {
  section: SectionDimensions;
  rebar: RebarLayout;
  result?: DesignResults;
  width?: number;
  height?: number;
  showDims?: boolean;
  /** Render bar/stirrup labels even when dimension arrows are hidden (thumbnails). Defaults to showDims. */
  barLabels?: boolean;
  /** Enable per-layer count AND bar-size stepping on the labels (left = up, right = down). */
  editBarSize?: boolean;
  /** Enable clickable stirrup size + spacing editing and a ⅓ zoned-spacing toggle. */
  editStirrup?: boolean;
  /** SVG paddings; defaults hold the dimension arrows + right-gutter labels. Tighten for a small card. */
  padL?: number;
  padR?: number;
  padT?: number;
  padB?: number;
  onRebarChange?: (r: RebarLayout) => void;
}

export default function SectionView({
  section, rebar, result,
  width = 320, height = 270,
  showDims = true,
  barLabels,
  editBarSize = false,
  editStirrup = false,
  padL = 40, padR = 78, padT = 28, padB = 46,
  onRebarChange,
}: Props) {
  const { fmt } = useUnits();
  const pL = padL, pR = padR, pT = padT, pB = padB;
  const showLabels = barLabels ?? showDims;
  const drawW = width - pL - pR;
  const drawH = height - pT - pB;

  const isCircular = section.type === 'circular_column';
  const isColumn = section.type.endsWith('_column');
  const secW = isCircular ? (section.diameter ?? section.b) : section.b;
  const secH = isCircular ? (section.diameter ?? section.b) : (section.h ?? 12);

  const scale = Math.min(drawW / secW, drawH / secH);
  const scaledW = secW * scale;
  const scaledH = secH * scale;
  const ox = pL + (drawW - scaledW) / 2;
  const oy = pT + (drawH - scaledH) / 2;

  const tieD = getBarDiam(section.stirrupDia);
  // Clamp the cover offset so a mis-scaled / degenerate section (cover ≥ half the
  // depth — e.g. a beam imported with the wrong units) still renders a visible
  // stirrup hoop and bars instead of collapsing to an empty rectangle. For normal
  // sections cover ≪ size, so the clamp never bites.
  const stOff = Math.min((section.coverClear + tieD / 2) * scale, scaledW * 0.4, scaledH * 0.4);
  const bw = section.bw ?? secW;
  const hf = section.hf ?? 0;
  const isT = section.type === 'T_beam' || section.type === 'L_beam';
  const interactive = !!onRebarChange;

  /** Bar radius, shrunk when bars would overlap in the row. */
  function fitRadius(barSize: number, numBars: number, rowWidth: number): number {
    const r = Math.max(3, (getBarDiam(barSize) / 2) * scale);
    if (numBars <= 1) return r;
    const maxR = (rowWidth / (numBars - 1) - 2) / 2;
    return Math.max(2.5, Math.min(r, maxR));
  }

  function barDots(bars: { numBars: number; barSize: number }[], row: 'top' | 'bot'): ReactElement[] {
    const color = row === 'top' ? BARS.top : BARS.bot;
    const sClear = (rebar.layerClearSpacing ?? 1.0) * scale;
    let inset = 0; // true-scale offset from the stirrup line to the current layer
    return bars.flatMap((grp, gi) => {
      const usableW0 = scaledW - 2 * stOff;
      const r = fitRadius(grp.barSize, grp.numBars, usableW0);
      const dbScaled = getBarDiam(grp.barSize) * scale;
      const faceY = row === 'top' ? oy + stOff : oy + scaledH - stOff;
      const ry = row === 'top' ? faceY + inset + r : faceY - inset - r;
      inset += dbScaled + sClear;
      const usableW = scaledW - 2 * (stOff + r);
      const spacing = grp.numBars > 1 ? usableW / (grp.numBars - 1) : 0;
      const startX = ox + stOff + r;
      return Array.from({ length: grp.numBars }, (_, i) => {
        const bx = grp.numBars === 1 ? ox + scaledW / 2 : startX + i * spacing;
        return <circle key={`${row}-${gi}-${i}`} cx={bx} cy={ry} r={r} fill={color} stroke="#fff" strokeWidth="0.5" />;
      });
    });
  }

  function bump(e: React.MouseEvent, key: 'top' | 'bot' | 'stir') {
    if (!onRebarChange) return;
    e.preventDefault();
    const isRight = e.type === 'contextmenu';
    if (key === 'top') {
      const grp = rebar.topBars[0] ?? { numBars: 1, barSize: 8 };
      onRebarChange({ ...rebar, topBars: [{ ...grp, numBars: Math.max(1, grp.numBars + (isRight ? -1 : 1)) }] });
    } else if (key === 'bot') {
      const grp = rebar.botBars[0] ?? { numBars: 1, barSize: 8 };
      onRebarChange({ ...rebar, botBars: [{ ...grp, numBars: Math.max(1, grp.numBars + (isRight ? -1 : 1)) }] });
    } else if (rebar.ties) {
      const newS = Math.max(2, rebar.ties.spacing + (isRight ? 1 : -1));
      onRebarChange({ ...rebar, ties: { ...rebar.ties, spacing: newS } });
    }
  }

  function labelEvents(key: 'top' | 'bot' | 'stir') {
    if (!interactive) return {};
    return {
      style: { cursor: 'pointer', userSelect: 'none' as const },
      onClick: (e: React.MouseEvent) => bump(e, key),
      onContextMenu: (e: React.MouseEvent) => bump(e, key),
    };
  }

  // Per-layer count / bar-size stepping for the editable card labels: left-click
  // (onClick) = +1 bar / larger size, right-click (onContextMenu) = -1 / smaller.
  function bumpBars(face: 'top' | 'bot', layer: number, field: 'count' | 'size', dir: 1 | -1) {
    if (!onRebarChange) return;
    const arr = face === 'top' ? rebar.topBars : rebar.botBars;
    const grp = arr[layer];
    if (!grp) return;
    let newArr: typeof arr;
    if (field === 'count') {
      const nextCount = grp.numBars + dir;
      // Decrementing the last bar (1 → 0) drops the whole layer.
      newArr = nextCount <= 0
        ? arr.filter((_, i) => i !== layer)
        : arr.map((g, i) => (i === layer ? { ...g, numBars: nextCount } : g));
    } else {
      newArr = arr.map((g, i) => (i === layer ? { ...g, barSize: barSizeStep(g.barSize, dir) } : g));
    }
    onRebarChange(face === 'top' ? { ...rebar, topBars: newArr } : { ...rebar, botBars: newArr });
  }

  // Add / remove a reinforcement layer on a face. Multi-layer cages are modeled as
  // multiple BarGroup entries; a new layer copies the innermost layer's bar size.
  function addLayer(face: 'top' | 'bot') {
    if (!onRebarChange) return;
    const arr = face === 'top' ? rebar.topBars : rebar.botBars;
    const last = arr[arr.length - 1];
    const layer = { numBars: 2, barSize: last?.barSize ?? 8 };
    const newArr = [...arr, layer];
    onRebarChange(face === 'top' ? { ...rebar, topBars: newArr } : { ...rebar, botBars: newArr });
  }
  function removeLayer(face: 'top' | 'bot') {
    if (!onRebarChange) return;
    const arr = face === 'top' ? rebar.topBars : rebar.botBars;
    if (arr.length <= 1) return;
    const newArr = arr.slice(0, -1);
    onRebarChange(face === 'top' ? { ...rebar, topBars: newArr } : { ...rebar, botBars: newArr });
  }

  // Stirrup editing (card): step the tie bar size or spacing, and toggle a zoned
  // [end · middle · end] spacing layout over the span thirds. Left-click a spacing
  // token tightens it, right-click loosens; the single `ties.spacing` tracks the
  // tightest zone so the shear check keys off the governing (end-zone) spacing.
  function bumpTie(field: 'size' | 'spacing', dir: 1 | -1, zoneIdx?: number) {
    if (!onRebarChange || !rebar.ties) return;
    if (field === 'size') {
      onRebarChange({ ...rebar, ties: { ...rebar.ties, barSize: barSizeStep(rebar.ties.barSize, dir) } });
      return;
    }
    if (rebar.tieZones && zoneIdx !== undefined) {
      const zones = rebar.tieZones.map((z, i) => (i === zoneIdx ? { spacing: Math.max(2, z.spacing + dir) } : z)) as [TieZone, TieZone, TieZone];
      const gov = Math.min(...zones.map(z => z.spacing));
      onRebarChange({ ...rebar, tieZones: zones, ties: { ...rebar.ties, spacing: gov } });
    } else {
      onRebarChange({ ...rebar, ties: { ...rebar.ties, spacing: Math.max(2, rebar.ties.spacing + dir) } });
    }
  }
  function toggleTieZones() {
    if (!onRebarChange || !rebar.ties) return;
    if (rebar.tieZones) {
      // Collapse back to a single spacing = the tightest zone.
      const gov = Math.min(...rebar.tieZones.map(z => z.spacing));
      const { tieZones: _drop, ...rest } = rebar;
      void _drop;
      onRebarChange({ ...rest, ties: { ...rebar.ties, spacing: gov } });
    } else {
      const s = rebar.ties.spacing;
      const end = Math.max(2, Math.round(s / 2)); // denser at the supports by default
      const zones: [TieZone, TieZone, TieZone] = [{ spacing: end }, { spacing: s }, { spacing: end }];
      onRebarChange({ ...rebar, tieZones: zones, ties: { ...rebar.ties, spacing: end } });
    }
  }

  // pointerEvents:'auto' re-enables hit-testing even when the token sits inside a
  // parent <text> that set pointer-events:none (e.g. the '＋layer' token on the
  // hint line) — otherwise the click passes through to the card and never fires.
  const editTspan = { cursor: 'pointer', userSelect: 'none' as const, pointerEvents: 'auto' as const } as React.CSSProperties;
  const noHit = { pointerEvents: 'none' } as React.CSSProperties;

  /** Editable face label: per-layer clickable count and bar-size tokens (e.g. "3-#8 + 2-#6"). */
  function editableFaceLabel(face: 'top' | 'bot', x: number, y: number, fill: string): ReactElement {
    const bars = face === 'top' ? rebar.topBars : rebar.botBars;
    const firstIdx = bars.findIndex(g => g.numBars > 0);
    if (firstIdx === -1) return <text x={x} y={y} fontSize="10" fill={fill} fontFamily={FONT.mono}>—</text>;
    return (
      <text x={x} y={y} fontSize="10" fill={fill} fontFamily={FONT.mono}>
        {bars.map((g, li) => g.numBars > 0 ? (
          <tspan key={li}>
            {li > firstIdx && <tspan style={noHit}> + </tspan>}
            <tspan style={editTspan} textDecoration="underline"
              onClick={e => { e.stopPropagation(); bumpBars(face, li, 'count', 1); }}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); bumpBars(face, li, 'count', -1); }}
            >{g.numBars}</tspan>
            <tspan style={noHit}>-</tspan>
            <tspan style={editTspan} textDecoration="underline"
              onClick={e => { e.stopPropagation(); bumpBars(face, li, 'size', 1); }}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); bumpBars(face, li, 'size', -1); }}
            >{formatBarLabel(g.barSize)}</tspan>
          </tspan>
        ) : null)}
      </text>
    );
  }

  /** Editable stirrup label: clickable bar-size + spacing tokens and a ⅓ zoned-spacing
   *  toggle. Zoned mode shows three span-third spacings "end/mid/end". */
  function editableStirrupLabel(x: number, y: number): ReactElement | null {
    const t = rebar.ties;
    if (!t) return null;
    const dec = rebar.tieZones ? 0 : 1; // three zoned values need to stay compact
    const spacingTspan = (val: number, key: string, zoneIdx?: number) => (
      <tspan key={key} style={editTspan} textDecoration="underline"
        onClick={e => { e.stopPropagation(); bumpTie('spacing', -1, zoneIdx); }}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); bumpTie('spacing', 1, zoneIdx); }}
      >{fmt(val, 'length', dec)}</tspan>
    );
    return (
      <text x={x} y={y} fontSize="10" fill={BARS.tie} fontFamily={FONT.mono}>
        <tspan style={editTspan} textDecoration="underline"
          onClick={e => { e.stopPropagation(); bumpTie('size', 1); }}
          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); bumpTie('size', -1); }}
        >{formatBarLabel(t.barSize)}</tspan>
        <tspan style={noHit}>@</tspan>
        {rebar.tieZones
          ? [spacingTspan(rebar.tieZones[0].spacing, 'z0', 0),
             <tspan key="s1" style={noHit}>/</tspan>,
             spacingTspan(rebar.tieZones[1].spacing, 'z1', 1),
             <tspan key="s2" style={noHit}>/</tspan>,
             spacingTspan(rebar.tieZones[2].spacing, 'z2', 2)]
          : spacingTspan(t.spacing, 'z')}
        {t.legs > 2 && <tspan style={noHit}> ×{t.legs}L</tspan>}
        <tspan style={{ ...editTspan, fontWeight: 700 }} fill={rebar.tieZones ? '#7c3aed' : '#9ca3af'}
          onClick={e => { e.stopPropagation(); toggleTieZones(); }}> ⅓</tspan>
      </text>
    );
  }

  const topBarR = Math.max(3, (getBarDiam(rebar.topBars[0]?.barSize ?? 8) / 2) * scale);
  const botBarR = Math.max(3, (getBarDiam(rebar.botBars[0]?.barSize ?? 8) / 2) * scale);
  const topLabelY = oy + stOff + topBarR;
  const botLabelY = oy + scaledH - stOff - botBarR;

  // Innermost longitudinal-layer centers — the bottom-most TOP layer and the
  // top-most BOTTOM layer. Face/skin bars are spaced in the clear web BETWEEN
  // these two, never over the top/bottom bars. Mirrors barDots' layer stacking:
  // each prior layer drops by bar Ø + clear spacing (so multi-layer top/bottom
  // groups push the band inward correctly; single-layer ⇒ same as the outer y).
  const sClearPx = (rebar.layerClearSpacing ?? 1.0) * scale;
  const layerDrop = (bars: { barSize: number }[]) =>
    bars.slice(0, -1).reduce((s, g) => s + getBarDiam(g.barSize) * scale + sClearPx, 0);
  const lastTop = rebar.topBars[rebar.topBars.length - 1];
  const lastBot = rebar.botBars[rebar.botBars.length - 1];
  const yTopInner = oy + stOff + layerDrop(rebar.topBars)
    + Math.max(3, (getBarDiam(lastTop?.barSize ?? 8) / 2) * scale);
  const yBotInner = oy + scaledH - stOff - layerDrop(rebar.botBars)
    - Math.max(3, (getBarDiam(lastBot?.barSize ?? 8) / 2) * scale);

  // Circular columns: pool ALL bar groups onto the ring (matches engine layout)
  const circGroups = [...rebar.topBars, ...rebar.botBars, ...(rebar.sideBars ?? [])]
    .filter(g => g.numBars > 0);
  const circTotal = circGroups.reduce((s, g) => s + g.numBars, 0);
  const circBarSize = circGroups[0]?.barSize ?? 8;

  const cx = ox + scaledW / 2, cy = oy + scaledH / 2;

  return (
    <svg width={width} height={height} style={{ background: '#f8fafc', borderRadius: 8 }}>
      <defs>
        <marker id="sv-arr" markerWidth="5" markerHeight="5" refX="4.5" refY="2.5" orient="auto">
          <path d="M0,0 L5,2.5 L0,5 z" fill="#9ca3af" />
        </marker>
        <marker id="sv-arrl" markerWidth="5" markerHeight="5" refX="0.5" refY="2.5" orient="auto-start-reverse">
          <path d="M0,0 L5,2.5 L0,5 z" fill="#9ca3af" />
        </marker>
      </defs>

      {isCircular ? (
        <>
          <circle cx={cx} cy={cy} r={scaledW / 2} fill={BARS.concrete} stroke={BARS.concreteEdge} strokeWidth="2" />
          {/* Tie / spiral hoop at the stirrup centerline */}
          <circle cx={cx} cy={cy} r={scaledW / 2 - stOff}
            fill="none" stroke={BARS.tie} strokeWidth="2"
            strokeDasharray={rebar.tieType === 'spiral' ? '6,3' : undefined} />
          {/* All longitudinal bars pooled evenly on the ring (engine convention) */}
          {circTotal > 0 && (() => {
            const rb = Math.max(3, (getBarDiam(circBarSize) / 2) * scale);
            const R = scaledW / 2 - stOff - rb - 1;
            return Array.from({ length: circTotal }, (_, i) => {
              const ang = (2 * Math.PI * i) / circTotal - Math.PI / 2;
              return <circle key={`c-${i}`}
                cx={cx + R * Math.cos(ang)} cy={cy + R * Math.sin(ang)}
                r={rb} fill={BARS.bot} stroke="#fff" strokeWidth="0.5" />;
            });
          })()}
        </>
      ) : (
        <>
          {isT && (
            <rect x={ox} y={oy} width={scaledW} height={hf * scale} fill={BARS.concrete} stroke={BARS.concreteEdge} strokeWidth="1.5" />
          )}
          <rect
            x={isT ? ox + (secW - bw) / 2 * scale : ox}
            y={isT ? oy + hf * scale : oy}
            width={(isT ? bw : secW) * scale}
            height={(isT ? secH - hf : secH) * scale}
            fill={BARS.concrete} stroke={BARS.concreteEdge} strokeWidth="1.5"
          />
          {/* Tie / stirrup hoop at the centerline */}
          <rect
            x={isT ? ox + (secW - bw) / 2 * scale + stOff : ox + stOff}
            y={oy + (isT ? hf * scale : 0) + stOff}
            width={(isT ? bw : secW) * scale - 2 * stOff}
            height={(isT ? secH - hf : secH) * scale - 2 * stOff}
            fill="none" stroke={BARS.tie} strokeWidth="2" rx="4"
          />
          {/* Interior crosstie legs when legs > 2 — evenly spaced verticals with 135° hook ticks */}
          {rebar.ties && rebar.ties.legs > 2 && (() => {
            const hoopX = isT ? ox + (secW - bw) / 2 * scale + stOff : ox + stOff;
            const hoopW = (isT ? bw : secW) * scale - 2 * stOff;
            const hoopY = oy + (isT ? hf * scale : 0) + stOff;
            const hoopH = (isT ? secH - hf : secH) * scale - 2 * stOff;
            const n = rebar.ties.legs - 2;
            const hook = Math.min(8, hoopW * 0.08);
            return Array.from({ length: n }, (_, i) => {
              const lx = hoopX + (hoopW * (i + 1)) / (n + 1);
              return (
                <g key={`leg-${i}`} stroke={BARS.tie} strokeWidth="1.5" fill="none">
                  <line x1={lx} y1={hoopY} x2={lx} y2={hoopY + hoopH} />
                  <line x1={lx} y1={hoopY} x2={lx + hook} y2={hoopY + hook} />
                  <line x1={lx} y1={hoopY + hoopH} x2={lx - hook} y2={hoopY + hoopH - hook} />
                </g>
              );
            });
          })()}
          {barDots(rebar.topBars, 'top')}
          {barDots(rebar.botBars, 'bot')}
          {rebar.sideBars?.flatMap((grp, gi) => {
            const r = Math.max(2.5, (getBarDiam(grp.barSize) / 2) * scale);
            // Columns: pairs at evenly spaced heights between face layers (engine convention)
            const rows = isColumn ? Math.max(1, Math.round(grp.numBars / 2)) : grp.numBars;
            return Array.from({ length: rows }, (_, i) => {
              const t = (i + 1) / (rows + 1);
              // Evenly spaced in the clear web between the innermost top layer and
              // the innermost bottom layer — so face bars never overlap the top/
              // bottom bars (the same interpolation the column path already used).
              const by = yTopInner + t * (yBotInner - yTopInner);
              return [
                <circle key={`sl-${gi}-${i}`} cx={ox + stOff + r} cy={by} r={r} fill={BARS.side} stroke="#fff" strokeWidth="0.5" />,
                <circle key={`sr-${gi}-${i}`} cx={ox + scaledW - stOff - r} cy={by} r={r} fill={BARS.side} stroke="#fff" strokeWidth="0.5" />,
              ];
            }).flat();
          })}
        </>
      )}

      {/* Dimensions + labels */}
      {showDims && isCircular && (
        <>
          {/* Diameter dim */}
          <line x1={ox} y1={oy + scaledH + 14} x2={ox + scaledW} y2={oy + scaledH + 14}
            stroke="#9ca3af" strokeWidth="1" markerEnd="url(#sv-arr)" markerStart="url(#sv-arrl)" />
          <text x={cx} y={oy + scaledH + 27} textAnchor="middle"
            fontSize="10" fill="#374151" fontFamily={FONT.mono}>
            Ø = {fmt(secW, 'length', 1)}
          </text>
        </>
      )}
      {showLabels && isCircular && (
        <>
          {/* Bar + tie labels */}
          <text x={ox + scaledW + 8} y={cy - 8}
            fontSize="10" fill={BARS.bot} fontFamily={FONT.mono} {...labelEvents('bot')}>
            {circTotal > 0 ? `${circTotal}-${formatBarLabel(circBarSize)}` : '—'}
          </text>
          {rebar.ties && (
            <text x={ox + scaledW + 8} y={cy + 8}
              fontSize="10" fill={BARS.tie} fontFamily={FONT.mono} {...labelEvents('stir')}>
              {rebar.tieType === 'spiral' ? 'Sp ' : ''}{formatBarLabel(rebar.ties.barSize)}@{fmt(rebar.ties.spacing, 'length', 1)}
            </text>
          )}
        </>
      )}

      {showDims && !isCircular && (
        <>
          {/* Width dim */}
          <line x1={ox} y1={oy + scaledH + 14} x2={ox + scaledW} y2={oy + scaledH + 14}
            stroke="#9ca3af" strokeWidth="1" markerEnd="url(#sv-arr)" markerStart="url(#sv-arrl)" />
          <text x={ox + scaledW / 2} y={oy + scaledH + 27} textAnchor="middle"
            fontSize="10" fill="#374151" fontFamily={FONT.mono}>
            {isT ? `bw = ${fmt(bw, 'length', 1)}` : `b = ${fmt(secW, 'length', 1)}`}
          </text>

          {/* Height dim */}
          <line x1={ox - 14} y1={oy} x2={ox - 14} y2={oy + scaledH}
            stroke="#9ca3af" strokeWidth="1" markerEnd="url(#sv-arr)" markerStart="url(#sv-arrl)" />
          <text x={ox - 26} y={oy + scaledH / 2} textAnchor="middle"
            fontSize="10" fill="#374151" fontFamily={FONT.mono}
            transform={`rotate(-90,${ox - 26},${oy + scaledH / 2})`}>
            h = {fmt(secH, 'length', 1)}
          </text>
        </>
      )}

      {showLabels && !isCircular && (
        <>
          {/* Top bars — left-click +1, right-click −1 (count and, when editable, size) */}
          {editBarSize
            ? editableFaceLabel('top', ox + scaledW + 8, topLabelY + 4, BARS.top)
            : (
              <text x={ox + scaledW + 8} y={topLabelY + 4}
                fontSize="10" fill={BARS.top} fontFamily={FONT.mono}
                {...labelEvents('top')}>
                {rebar.topBars.length ? rebar.topBars.filter(g => g.numBars > 0).map(g => `${g.numBars}-${formatBarLabel(g.barSize)}`).join(' + ') : '—'}
              </text>
            )}
          <text x={ox + scaledW + 8} y={topLabelY + 16}
            fontSize="8" fill="#9ca3af" fontFamily={FONT.mono} style={{ pointerEvents: 'none' }}>
            {interactive ? (editBarSize ? 'L+ / R− ' : 'L+1 / R−1') : 'top'}
            {editBarSize && interactive && (
              <tspan style={editTspan} fill="#7c3aed" textDecoration="underline"
                onClick={e => { e.stopPropagation(); addLayer('top'); }}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); removeLayer('top'); }}>＋layer</tspan>
            )}
          </text>

          {/* Bottom bars */}
          {editBarSize
            ? editableFaceLabel('bot', ox + scaledW + 8, botLabelY + 4, BARS.bot)
            : (
              <text x={ox + scaledW + 8} y={botLabelY + 4}
                fontSize="10" fill={BARS.bot} fontFamily={FONT.mono}
                {...labelEvents('bot')}>
                {rebar.botBars.length ? rebar.botBars.filter(g => g.numBars > 0).map(g => `${g.numBars}-${formatBarLabel(g.barSize)}`).join(' + ') : '—'}
              </text>
            )}
          <text x={ox + scaledW + 8} y={botLabelY + 16}
            fontSize="8" fill="#9ca3af" fontFamily={FONT.mono} style={{ pointerEvents: 'none' }}>
            {interactive ? (editBarSize ? 'L+ / R− ' : 'L+1 / R−1') : 'bot'}
            {editBarSize && interactive && (
              <tspan style={editTspan} fill="#7c3aed" textDecoration="underline"
                onClick={e => { e.stopPropagation(); addLayer('bot'); }}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); removeLayer('bot'); }}>＋layer</tspan>
            )}
          </text>
          {/* Side bar label (columns) */}
          {isColumn && rebar.sideBars?.[0] && rebar.sideBars[0].numBars > 0 && (
            <text x={ox + scaledW + 8} y={(topLabelY + botLabelY) / 2 + 18}
              fontSize="10" fill={BARS.side} fontFamily={FONT.mono} style={{ pointerEvents: 'none' }}>
              {`${rebar.sideBars[0].numBars}-${formatBarLabel(rebar.sideBars[0].barSize)} side`}
            </text>
          )}
          {showDims && result && !isColumn && (() => {
            const asBot = rebar.botBars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
            const reqBot = result.As_req_pos;
            const ok = asBot >= reqBot;
            return (
              <>
                <text x={ox + scaledW + 8} y={botLabelY + 27} fontSize="8" fill="#6b7280" fontFamily={FONT.mono} style={{ pointerEvents: 'none' }}>
                  {`As=${fmt(asBot, 'area')}`}
                </text>
                <text x={ox + scaledW + 8} y={botLabelY + 37} fontSize="8" fill={ok ? DCR.pass : DCR.fail} fontFamily={FONT.mono} style={{ pointerEvents: 'none' }}>
                  {`Req:${reqBot.toFixed(2)} ${ok ? '✓' : '⚠'}`}
                </text>
              </>
            );
          })()}

          {/* Stirrup label — left-click decreases spacing, right-click increases.
              In editStirrup mode the size is clickable too and a ⅓ toggle enables
              zoned [end · middle · end] spacing over the span thirds. */}
          {rebar.ties && (
            <>
              {editStirrup
                ? editableStirrupLabel(ox + scaledW + 8, oy + scaledH / 2 + 4)
                : (
                  <text x={ox + scaledW + 8} y={oy + scaledH / 2 + 4}
                    fontSize="10" fill={BARS.tie} fontFamily={FONT.mono}
                    {...labelEvents('stir')}>
                    {formatBarLabel(rebar.ties.barSize)}@{fmt(rebar.ties.spacing, 'length', 1)}{rebar.ties.legs > 2 ? ` ×${rebar.ties.legs}L` : ''}
                  </text>
                )}
              <text x={ox + scaledW + 8} y={oy + scaledH / 2 + 16}
                fontSize="8" fill="#9ca3af" fontFamily={FONT.mono} style={{ pointerEvents: 'none' }}>
                {editStirrup ? 'size · L−s/R+s · ⅓' : interactive ? 'L−s / R+s' : 'stir'}
              </text>
            </>
          )}
        </>
      )}
    </svg>
  );
}
