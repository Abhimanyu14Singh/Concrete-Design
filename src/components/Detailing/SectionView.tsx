import { formatBarLabel } from '../../utils/rebar';
import type { ReactElement } from 'react';
import type { SectionDimensions, RebarLayout, DesignResults } from '../../types';
import { getBarDiam, getBarArea } from '../../utils/concreteDesign';
import { useUnits } from '../../contexts/UnitsContext';
import { BARS, DCR } from '../../theme';

interface Props {
  section: SectionDimensions;
  rebar: RebarLayout;
  result?: DesignResults;
  width?: number;
  height?: number;
  showDims?: boolean;
  onRebarChange?: (r: RebarLayout) => void;
}

export default function SectionView({
  section, rebar, result,
  width = 320, height = 270,
  showDims = true,
  onRebarChange,
}: Props) {
  const { fmt } = useUnits();
  const pL = 40, pR = 78, pT = 28, pB = 46;
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
  const stOff = (section.coverClear + tieD / 2) * scale;
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
    return bars.flatMap((grp, gi) => {
      const usableW0 = scaledW - 2 * stOff;
      const r = fitRadius(grp.barSize, grp.numBars, usableW0);
      const usableW = scaledW - 2 * (stOff + r);
      const barY = row === 'top' ? oy + stOff + r : oy + scaledH - stOff - r;
      const spacing = grp.numBars > 1 ? usableW / (grp.numBars - 1) : 0;
      const startX = ox + stOff + r;
      return Array.from({ length: grp.numBars }, (_, i) => {
        const bx = grp.numBars === 1 ? ox + scaledW / 2 : startX + i * spacing;
        const ry = row === 'top' ? barY + gi * (r * 2 + 2) : barY - gi * (r * 2 + 2);
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

  const topBarR = Math.max(3, (getBarDiam(rebar.topBars[0]?.barSize ?? 8) / 2) * scale);
  const botBarR = Math.max(3, (getBarDiam(rebar.botBars[0]?.barSize ?? 8) / 2) * scale);
  const topLabelY = oy + stOff + topBarR;
  const botLabelY = oy + scaledH - stOff - botBarR;

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
          {barDots(rebar.topBars, 'top')}
          {barDots(rebar.botBars, 'bot')}
          {rebar.sideBars?.flatMap((grp, gi) => {
            const r = Math.max(2.5, (getBarDiam(grp.barSize) / 2) * scale);
            // Columns: pairs at evenly spaced heights between face layers (engine convention)
            const rows = isColumn ? Math.max(1, Math.round(grp.numBars / 2)) : grp.numBars;
            const yTop = oy + stOff + topBarR;
            const yBot = oy + scaledH - stOff - botBarR;
            return Array.from({ length: rows }, (_, i) => {
              const t = (i + 1) / (rows + 1);
              const by = isColumn ? yTop + t * (yBot - yTop) : oy + (scaledH / (grp.numBars + 1)) * (i + 1);
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
            fontSize="10" fill="#374151" fontFamily="monospace">
            Ø = {fmt(secW, 'length', 1)}
          </text>
          {/* Bar + tie labels */}
          <text x={ox + scaledW + 8} y={cy - 8}
            fontSize="10" fill={BARS.bot} fontFamily="monospace" {...labelEvents('bot')}>
            {circTotal > 0 ? `${circTotal}-${formatBarLabel(circBarSize)}` : '—'}
          </text>
          {rebar.ties && (
            <text x={ox + scaledW + 8} y={cy + 8}
              fontSize="10" fill={BARS.tie} fontFamily="monospace" {...labelEvents('stir')}>
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
            fontSize="10" fill="#374151" fontFamily="monospace">
            {isT ? `bw = ${fmt(bw, 'length', 1)}` : `b = ${fmt(secW, 'length', 1)}`}
          </text>

          {/* Height dim */}
          <line x1={ox - 14} y1={oy} x2={ox - 14} y2={oy + scaledH}
            stroke="#9ca3af" strokeWidth="1" markerEnd="url(#sv-arr)" markerStart="url(#sv-arrl)" />
          <text x={ox - 26} y={oy + scaledH / 2} textAnchor="middle"
            fontSize="10" fill="#374151" fontFamily="monospace"
            transform={`rotate(-90,${ox - 26},${oy + scaledH / 2})`}>
            h = {fmt(secH, 'length', 1)}
          </text>

          {/* Top bars — left-click +1 bar, right-click -1 bar */}
          <text x={ox + scaledW + 8} y={topLabelY + 4}
            fontSize="10" fill={BARS.top} fontFamily="monospace"
            {...labelEvents('top')}>
            {rebar.topBars[0] ? `${rebar.topBars[0].numBars}-${formatBarLabel(rebar.topBars[0].barSize)}` : '—'}
          </text>
          <text x={ox + scaledW + 8} y={topLabelY + 16}
            fontSize="8" fill="#9ca3af" fontFamily="monospace" style={{ pointerEvents: 'none' }}>
            {interactive ? 'L+1 / R−1' : 'top'}
          </text>

          {/* Bottom bars */}
          <text x={ox + scaledW + 8} y={botLabelY + 4}
            fontSize="10" fill={BARS.bot} fontFamily="monospace"
            {...labelEvents('bot')}>
            {rebar.botBars[0] ? `${rebar.botBars[0].numBars}-${formatBarLabel(rebar.botBars[0].barSize)}` : '—'}
          </text>
          <text x={ox + scaledW + 8} y={botLabelY + 16}
            fontSize="8" fill="#9ca3af" fontFamily="monospace" style={{ pointerEvents: 'none' }}>
            {interactive ? 'L+1 / R−1' : 'bot'}
          </text>
          {/* Side bar label (columns) */}
          {isColumn && rebar.sideBars?.[0] && rebar.sideBars[0].numBars > 0 && (
            <text x={ox + scaledW + 8} y={(topLabelY + botLabelY) / 2 + 18}
              fontSize="10" fill={BARS.side} fontFamily="monospace" style={{ pointerEvents: 'none' }}>
              {`${rebar.sideBars[0].numBars}-${formatBarLabel(rebar.sideBars[0].barSize)} side`}
            </text>
          )}
          {result && !isColumn && (() => {
            const asBot = rebar.botBars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
            const reqBot = result.As_req_pos;
            const ok = asBot >= reqBot;
            return (
              <>
                <text x={ox + scaledW + 8} y={botLabelY + 27} fontSize="8" fill="#6b7280" fontFamily="monospace" style={{ pointerEvents: 'none' }}>
                  {`As=${asBot.toFixed(2)}in²`}
                </text>
                <text x={ox + scaledW + 8} y={botLabelY + 37} fontSize="8" fill={ok ? DCR.pass : DCR.fail} fontFamily="monospace" style={{ pointerEvents: 'none' }}>
                  {`Req:${reqBot.toFixed(2)} ${ok ? '✓' : '⚠'}`}
                </text>
              </>
            );
          })()}

          {/* Stirrup label — left-click decreases spacing, right-click increases */}
          {rebar.ties && (
            <>
              <text x={ox + scaledW + 8} y={oy + scaledH / 2 + 4}
                fontSize="10" fill={BARS.tie} fontFamily="monospace"
                {...labelEvents('stir')}>
                {formatBarLabel(rebar.ties.barSize)}@{fmt(rebar.ties.spacing, 'length', 1)}
              </text>
              <text x={ox + scaledW + 8} y={oy + scaledH / 2 + 16}
                fontSize="8" fill="#9ca3af" fontFamily="monospace" style={{ pointerEvents: 'none' }}>
                {interactive ? 'L−s / R+s' : 'stir'}
              </text>
            </>
          )}
        </>
      )}
    </svg>
  );
}
