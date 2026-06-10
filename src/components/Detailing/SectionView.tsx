import { formatBarLabel } from '../../utils/rebar';
import type { ReactElement } from 'react';
import type { SectionDimensions, RebarLayout, DesignResults } from '../../types';
import { getBarDiam, getBarArea } from '../../utils/concreteDesign';

interface Props {
  section: SectionDimensions;
  rebar: RebarLayout;
  result?: DesignResults;
  width?: number;
  height?: number;
  showDims?: boolean;
  onRebarChange?: (r: RebarLayout) => void;
}

const TOP_COLOR = '#2e7d32';
const BOT_COLOR = '#1565c0';
const STR_COLOR = '#e91e8c';
const CON_FILL  = '#b0bec5';
const CON_EDGE  = '#546e7a';

export default function SectionView({
  section, rebar, result,
  width = 320, height = 270,
  showDims = true,
  onRebarChange,
}: Props) {
  const pL = 40, pR = 78, pT = 28, pB = 46;
  const drawW = width - pL - pR;
  const drawH = height - pT - pB;

  const isCircular = section.type === 'circular_column';
  const secW = section.b;
  const secH = section.h ?? section.diameter ?? 12;

  const scale = Math.min(drawW / secW, drawH / secH);
  const scaledW = secW * scale;
  const scaledH = secH * scale;
  const ox = pL + (drawW - scaledW) / 2;
  const oy = pT + (drawH - scaledH) / 2;

  const stOff = (section.coverClear + section.stirrupDia / 8 / 2) * scale;
  const bw = section.bw ?? secW;
  const hf = section.hf ?? 0;
  const isT = section.type === 'T_beam' || section.type === 'L_beam';
  const interactive = !!onRebarChange;

  function barDots(bars: { numBars: number; barSize: number }[], row: 'top' | 'bot'): ReactElement[] {
    const color = row === 'top' ? TOP_COLOR : BOT_COLOR;
    const barR = Math.max(3, (getBarDiam(bars[0]?.barSize ?? 8) / 2) * scale);
    const barY = row === 'top'
      ? oy + stOff + barR
      : oy + scaledH - stOff - barR;

    return bars.flatMap((grp, gi) => {
      const r = Math.max(3, (getBarDiam(grp.barSize) / 2) * scale);
      const usableW = scaledW - 2 * (stOff + r);
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
          <circle cx={ox + scaledW / 2} cy={oy + scaledH / 2} r={scaledW / 2} fill={CON_FILL} stroke={CON_EDGE} strokeWidth="2" />
          <circle cx={ox + scaledW / 2} cy={oy + scaledH / 2} r={scaledW / 2 - stOff}
            fill="none" stroke={STR_COLOR} strokeWidth="1.5" strokeDasharray="4,2" />
          {[...rebar.topBars, ...rebar.botBars].flatMap((grp, gi) => {
            const rb = Math.max(3, (getBarDiam(grp.barSize) / 2) * scale);
            const R = scaledW / 2 - stOff - rb;
            const color = gi === 0 ? TOP_COLOR : BOT_COLOR;
            return Array.from({ length: grp.numBars }, (_, i) => {
              const ang = (2 * Math.PI * i) / grp.numBars - Math.PI / 2;
              return <circle key={`c-${gi}-${i}`}
                cx={ox + scaledW / 2 + R * Math.cos(ang)} cy={oy + scaledH / 2 + R * Math.sin(ang)}
                r={rb} fill={color} stroke="#fff" strokeWidth="0.5" />;
            });
          })}
        </>
      ) : (
        <>
          {isT && (
            <rect x={ox} y={oy} width={scaledW} height={hf * scale} fill={CON_FILL} stroke={CON_EDGE} strokeWidth="1.5" />
          )}
          <rect
            x={isT ? ox + (secW - bw) / 2 * scale : ox}
            y={isT ? oy + hf * scale : oy}
            width={(isT ? bw : secW) * scale}
            height={(isT ? secH - hf : secH) * scale}
            fill={CON_FILL} stroke={CON_EDGE} strokeWidth="1.5"
          />
          <rect
            x={isT ? ox + (secW - bw) / 2 * scale + stOff : ox + stOff}
            y={oy + (isT ? hf * scale : 0) + stOff}
            width={(isT ? bw : secW) * scale - 2 * stOff}
            height={(isT ? secH - hf : secH) * scale - 2 * stOff}
            fill="none" stroke={STR_COLOR} strokeWidth="1.5" rx="2"
          />
          {barDots(rebar.topBars, 'top')}
          {barDots(rebar.botBars, 'bot')}
          {rebar.sideBars?.flatMap((grp, gi) => {
            const r = Math.max(2.5, (getBarDiam(grp.barSize) / 2) * scale);
            const spc = scaledH / (grp.numBars + 1);
            return Array.from({ length: grp.numBars }, (_, i) => {
              const by = oy + spc * (i + 1);
              return [
                <circle key={`sl-${gi}-${i}`} cx={ox + stOff + r} cy={by} r={r} fill="#8d6e63" stroke="#fff" strokeWidth="0.5" />,
                <circle key={`sr-${gi}-${i}`} cx={ox + scaledW - stOff - r} cy={by} r={r} fill="#8d6e63" stroke="#fff" strokeWidth="0.5" />,
              ];
            }).flat();
          })}
        </>
      )}

      {showDims && !isCircular && (
        <>
          {/* Width dim */}
          <line x1={ox} y1={oy + scaledH + 14} x2={ox + scaledW} y2={oy + scaledH + 14}
            stroke="#9ca3af" strokeWidth="1" markerEnd="url(#sv-arr)" markerStart="url(#sv-arrl)" />
          <text x={ox + scaledW / 2} y={oy + scaledH + 27} textAnchor="middle"
            fontSize="10" fill="#374151" fontFamily="monospace">
            {isT ? `bw = ${bw}"` : `b = ${secW}"`}
          </text>

          {/* Height dim */}
          <line x1={ox - 14} y1={oy} x2={ox - 14} y2={oy + scaledH}
            stroke="#9ca3af" strokeWidth="1" markerEnd="url(#sv-arr)" markerStart="url(#sv-arrl)" />
          <text x={ox - 26} y={oy + scaledH / 2} textAnchor="middle"
            fontSize="10" fill="#374151" fontFamily="monospace"
            transform={`rotate(-90,${ox - 26},${oy + scaledH / 2})`}>
            h = {secH}"
          </text>

          {/* Top bars — left-click +1 bar, right-click -1 bar */}
          <text x={ox + scaledW + 8} y={topLabelY + 4}
            fontSize="10" fill={TOP_COLOR} fontFamily="monospace"
            {...labelEvents('top')}>
            {rebar.topBars[0] ? `${rebar.topBars[0].numBars}-${formatBarLabel(rebar.topBars[0].barSize)}` : '—'}
          </text>
          <text x={ox + scaledW + 8} y={topLabelY + 16}
            fontSize="8" fill="#9ca3af" fontFamily="monospace" style={{ pointerEvents: 'none' }}>
            {interactive ? 'L+1 / R−1' : 'top'}
          </text>

          {/* Bottom bars */}
          <text x={ox + scaledW + 8} y={botLabelY + 4}
            fontSize="10" fill={BOT_COLOR} fontFamily="monospace"
            {...labelEvents('bot')}>
            {rebar.botBars[0] ? `${rebar.botBars[0].numBars}-${formatBarLabel(rebar.botBars[0].barSize)}` : '—'}
          </text>
          <text x={ox + scaledW + 8} y={botLabelY + 16}
            fontSize="8" fill="#9ca3af" fontFamily="monospace" style={{ pointerEvents: 'none' }}>
            {interactive ? 'L+1 / R−1' : 'bot'}
          </text>
          {result && (() => {
            const asBot = rebar.botBars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
            const reqBot = result.As_req_pos;
            const ok = asBot >= reqBot;
            return (
              <>
                <text x={ox + scaledW + 8} y={botLabelY + 27} fontSize="8" fill="#6b7280" fontFamily="monospace" style={{ pointerEvents: 'none' }}>
                  {`As=${asBot.toFixed(2)}in²`}
                </text>
                <text x={ox + scaledW + 8} y={botLabelY + 37} fontSize="8" fill={ok ? '#16a34a' : '#dc2626'} fontFamily="monospace" style={{ pointerEvents: 'none' }}>
                  {`Req:${reqBot.toFixed(2)} ${ok ? '✓' : '⚠'}`}
                </text>
              </>
            );
          })()}

          {/* Stirrup label — left-click decreases spacing, right-click increases */}
          {rebar.ties && (
            <>
              <text x={ox + scaledW + 8} y={oy + scaledH / 2 + 4}
                fontSize="10" fill={STR_COLOR} fontFamily="monospace"
                {...labelEvents('stir')}>
                {formatBarLabel(rebar.ties.barSize)}@{rebar.ties.spacing}"
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
