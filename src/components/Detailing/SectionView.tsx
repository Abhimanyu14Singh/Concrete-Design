import type { ReactElement } from 'react';
import type { SectionDimensions, RebarLayout } from '../../types';
import { getBarDiam } from '../../utils/concreteDesign';

interface Props {
  section: SectionDimensions;
  rebar: RebarLayout;
  width?: number;
  height?: number;
  showDims?: boolean;
}

export default function SectionView({ section, rebar, width = 320, height = 280, showDims = true }: Props) {
  const pad = 40;
  const drawW = width - pad * 2;
  const drawH = height - pad * 2;

  const isCircular = section.type === 'circular_column';
  const secW = section.b;
  const secH = section.h ?? section.diameter ?? 12;
  const diam = section.diameter ?? secW;

  const scale = Math.min(drawW / secW, drawH / secH);
  const scaledW = secW * scale;
  const scaledH = secH * scale;
  const ox = pad + (drawW - scaledW) / 2;
  const oy = pad + (drawH - scaledH) / 2;

  const cover = section.coverClear;
  const stDia = section.stirrupDia / 8; // bar size to diameter in inches = barSize/8
  const stOff = (cover + section.stirrupDia / 8 / 2) * scale;

  // Flange for T/L beam
  const bw = section.bw ?? secW;
  const hf = section.hf ?? 0;
  const isT = section.type === 'T_beam' || section.type === 'L_beam';

  function barDots(bars: { numBars: number; barSize: number }[], _y: number, row: 'top' | 'bot') {
    const dots: ReactElement[] = [];
    let barY = row === 'top'
      ? oy + stOff + getBarDiam(bars[0]?.barSize ?? 8) * scale / 2
      : oy + scaledH - stOff - getBarDiam(bars[0]?.barSize ?? 8) * scale / 2;

    bars.forEach((grp, gi) => {
      const r = Math.max(3, (getBarDiam(grp.barSize) / 2) * scale);
      const usableW = scaledW - 2 * (stOff + r);
      const spacing = grp.numBars > 1 ? usableW / (grp.numBars - 1) : 0;
      const startX = ox + stOff + r;

      for (let i = 0; i < grp.numBars; i++) {
        const bx = grp.numBars === 1 ? ox + scaledW / 2 : startX + i * spacing;
        const rowY = row === 'top'
          ? barY + gi * (r * 2 + 2 * scale)
          : barY - gi * (r * 2 + 2 * scale);
        dots.push(
          <g key={`${gi}-${i}`}>
            <circle cx={bx} cy={rowY} r={r} fill="#1a1a2e" stroke="#4a90d9" strokeWidth="0.5" />
          </g>
        );
      }
    });
    return dots;
  }

  function sideBars() {
    if (!rebar.sideBars?.length) return null;
    return rebar.sideBars.map((grp, gi) => {
      const r = Math.max(2.5, (getBarDiam(grp.barSize) / 2) * scale);
      const elements: ReactElement[] = [];
      const spacing = scaledH / (grp.numBars + 1);
      for (let i = 0; i < grp.numBars; i++) {
        const by = oy + spacing * (i + 1);
        // Left side
        elements.push(
          <circle key={`sl-${gi}-${i}`} cx={ox + stOff + r} cy={by} r={r} fill="#1a1a2e" stroke="#4a90d9" strokeWidth="0.5" />,
          <circle key={`sr-${gi}-${i}`} cx={ox + scaledW - stOff - r} cy={by} r={r} fill="#1a1a2e" stroke="#4a90d9" strokeWidth="0.5" />
        );
      }
      return elements;
    });
  }

  return (
    <svg width={width} height={height} className="bg-gray-900 rounded-lg">
      {/* Background grid */}
      <defs>
        <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#1e293b" strokeWidth="0.5" />
        </pattern>
      </defs>
      <rect width={width} height={height} fill="url(#grid)" rx="8" />

      {isCircular ? (
        <>
          <circle
            cx={ox + scaledW / 2}
            cy={oy + scaledH / 2}
            r={scaledW / 2}
            fill="#2d3748"
            stroke="#60a5fa"
            strokeWidth="2"
          />
          {/* Spiral/ties indicator */}
          <circle
            cx={ox + scaledW / 2}
            cy={oy + scaledH / 2}
            r={scaledW / 2 - stOff}
            fill="none"
            stroke="#fbbf24"
            strokeWidth="1"
            strokeDasharray="4,2"
          />
          {/* Circular bars */}
          {[...rebar.topBars, ...rebar.botBars].flatMap((grp, gi) => {
            const r_bar = Math.max(3, (getBarDiam(grp.barSize) / 2) * scale);
            const R = scaledW / 2 - stOff - r_bar;
            return Array.from({ length: grp.numBars }, (_, i) => {
              const angle = (2 * Math.PI * i) / grp.numBars - Math.PI / 2;
              const bx = ox + scaledW / 2 + R * Math.cos(angle);
              const by = oy + scaledH / 2 + R * Math.sin(angle);
              return (
                <circle key={`c-${gi}-${i}`} cx={bx} cy={by} r={r_bar}
                  fill="#1a1a2e" stroke="#4a90d9" strokeWidth="0.5" />
              );
            });
          })}
        </>
      ) : (
        <>
          {/* T/L beam flange */}
          {isT && (
            <rect
              x={ox}
              y={oy}
              width={scaledW}
              height={hf * scale}
              fill="#2d3748"
              stroke="#60a5fa"
              strokeWidth="2"
            />
          )}
          {/* Section body */}
          <rect
            x={isT ? ox + (secW - bw) / 2 * scale : ox}
            y={isT ? oy + hf * scale : oy}
            width={(isT ? bw : secW) * scale}
            height={(isT ? secH - hf : secH) * scale}
            fill="#334155"
            stroke="#60a5fa"
            strokeWidth="2"
          />
          {/* Stirrup rectangle */}
          <rect
            x={isT ? ox + (secW - bw) / 2 * scale + stOff : ox + stOff}
            y={oy + (isT ? hf * scale : 0) + stOff}
            width={(isT ? bw : secW) * scale - 2 * stOff}
            height={(isT ? secH - hf : secH) * scale - 2 * stOff}
            fill="none"
            stroke="#fbbf24"
            strokeWidth="1.5"
            strokeDasharray="3,1"
            rx="2"
          />
          {/* Top bars */}
          {barDots(rebar.topBars, 0, 'top')}
          {/* Bottom bars */}
          {barDots(rebar.botBars, 0, 'bot')}
          {/* Side bars */}
          {sideBars()}
        </>
      )}

      {/* Dimension annotations */}
      {showDims && (
        <>
          {/* Width */}
          <line x1={ox} y1={oy + scaledH + 15} x2={ox + scaledW} y2={oy + scaledH + 15}
            stroke="#94a3b8" strokeWidth="1" markerEnd="url(#arrow)" />
          <text x={ox + scaledW / 2} y={oy + scaledH + 28}
            textAnchor="middle" fontSize="11" fill="#94a3b8" fontFamily="monospace">
            {isCircular ? `Ø${diam}"` : `b = ${secW}"`}
          </text>

          {/* Height */}
          <line x1={ox - 15} y1={oy} x2={ox - 15} y2={oy + scaledH}
            stroke="#94a3b8" strokeWidth="1" />
          <text x={ox - 20} y={oy + scaledH / 2}
            textAnchor="middle" fontSize="11" fill="#94a3b8" fontFamily="monospace"
            transform={`rotate(-90, ${ox - 20}, ${oy + scaledH / 2})`}>
            {isCircular ? `Ø${diam}"` : `h = ${secH}"`}
          </text>

          {/* Bar count label */}
          <text x={ox + scaledW / 2} y={oy - 8}
            textAnchor="middle" fontSize="10" fill="#a78bfa" fontFamily="monospace">
            {rebar.topBars[0] ? `${rebar.topBars[0].numBars}-#${rebar.topBars[0].barSize} Top` : ''}
          </text>
          <text x={ox + scaledW / 2} y={oy + scaledH + 44}
            textAnchor="middle" fontSize="10" fill="#a78bfa" fontFamily="monospace">
            {rebar.botBars[0] ? `${rebar.botBars[0].numBars}-#${rebar.botBars[0].barSize} Bot` : ''}
          </text>

          {/* Stirrup label */}
          {rebar.ties && (
            <text x={ox + scaledW + 5} y={oy + scaledH / 2}
              fontSize="9" fill="#fbbf24" fontFamily="monospace">
              #{rebar.ties.barSize}@{rebar.ties.spacing}"
            </text>
          )}
        </>
      )}
    </svg>
  );
}
