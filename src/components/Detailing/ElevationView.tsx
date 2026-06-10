import { formatBarLabel } from '../../utils/rebar';
import type { Member } from '../../types';

interface Props {
  member: Member;
  width?: number;
  height?: number;
}

export default function ElevationView({ member, width = 600, height = 160 }: Props) {
  const pad = { l: 50, r: 30, t: 40, b: 40 };
  const drawW = width - pad.l - pad.r;
  const drawH = height - pad.t - pad.b;
  const span = (member.span ?? 20) * 12; // to inches
  const scaleX = drawW / span;
  const h = member.section.h ?? 24;
  const scaleY = drawH / h;
  const ox = pad.l;
  const oy = pad.t;

  const ties = member.rebar.ties;
  const numTies = ties ? Math.ceil(span / ties.spacing) : 0;

  return (
    <svg width={width} height={height} className="bg-gray-900 rounded-lg">
      <defs>
        <pattern id="elvgrid" width="30" height="30" patternUnits="userSpaceOnUse">
          <path d="M 30 0 L 0 0 0 30" fill="none" stroke="#1e293b" strokeWidth="0.5" />
        </pattern>
        <marker id="arrowE" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="#94a3b8" />
        </marker>
      </defs>
      <rect width={width} height={height} fill="url(#elvgrid)" rx="6" />

      {/* Beam outline */}
      <rect x={ox} y={oy} width={drawW} height={drawH}
        fill="#334155" stroke="#60a5fa" strokeWidth="2" rx="1" />

      {/* Stirrups */}
      {ties && Array.from({ length: numTies + 1 }, (_, i) => {
        const x = ox + (i / numTies) * drawW;
        return (
          <line key={i} x1={x} y1={oy + 3} x2={x} y2={oy + drawH - 3}
            stroke="#fbbf24" strokeWidth="1" opacity={0.6} />
        );
      })}

      {/* Top rebar lines */}
      {member.rebar.topBars.map((grp, gi) => (
        <line key={`top-${gi}`}
          x1={ox + 4} y1={oy + 6 + gi * 6}
          x2={ox + drawW - 4} y2={oy + 6 + gi * 6}
          stroke="#4a90d9" strokeWidth="2.5" />
      ))}

      {/* Bottom rebar lines */}
      {member.rebar.botBars.map((grp, gi) => (
        <line key={`bot-${gi}`}
          x1={ox + 4} y1={oy + drawH - 6 - gi * 6}
          x2={ox + drawW - 4} y2={oy + drawH - 6 - gi * 6}
          stroke="#4a90d9" strokeWidth="2.5" />
      ))}

      {/* Dimension: span */}
      <line x1={ox} y1={oy + drawH + 20} x2={ox + drawW} y2={oy + drawH + 20}
        stroke="#94a3b8" strokeWidth="1"
        markerStart="url(#arrowE)" markerEnd="url(#arrowE)" />
      <text x={ox + drawW / 2} y={oy + drawH + 33}
        textAnchor="middle" fontSize="11" fill="#94a3b8" fontFamily="monospace">
        L = {member.span ?? 20} ft
      </text>

      {/* Label */}
      <text x={ox + 4} y={oy - 10}
        fontSize="11" fill="#a78bfa" fontFamily="monospace" fontWeight="bold">
        {member.label}
      </text>

      {/* Bar labels */}
      <text x={ox - 5} y={oy + 10}
        textAnchor="end" fontSize="9" fill="#4a90d9" fontFamily="monospace">
        {member.rebar.topBars[0] ? `${member.rebar.topBars[0].numBars}${formatBarLabel(member.rebar.topBars[0].barSize)}` : ''}
      </text>
      <text x={ox - 5} y={oy + drawH - 4}
        textAnchor="end" fontSize="9" fill="#4a90d9" fontFamily="monospace">
        {member.rebar.botBars[0] ? `${member.rebar.botBars[0].numBars}${formatBarLabel(member.rebar.botBars[0].barSize)}` : ''}
      </text>
    </svg>
  );
}
