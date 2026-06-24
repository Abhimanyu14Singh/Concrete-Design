import { formatBarLabel } from '../../utils/rebar';
import type { Member } from '../../types';
import { useUnits } from '../../contexts/UnitsContext';
import { BARS } from '../../theme';

interface Props {
  member: Member;
  width?: number;
  height?: number;
  /** Visual zoom: the SVG is laid out at width×height and displayed at zoom× that size. */
  zoom?: number;
}

export default function ElevationView({ member, width = 600, height = 160, zoom = 1 }: Props) {
  const { fmt } = useUnits();
  const pad = { l: 50, r: 30, t: 40, b: 40 };
  const drawW = width - pad.l - pad.r;
  const drawH = height - pad.t - pad.b;
  const span = (member.span ?? 20) * 12; // to inches
  const ox = pad.l;
  const oy = pad.t;

  // Cap the number of drawn stirrups so a tiny/zero spacing can't spawn
  // thousands of SVG nodes (which freezes the renderer). The drawing is
  // schematic — once lines are sub-pixel apart, more add no information.
  const MAX_STIRRUP_LINES = 80;
  const ties = member.rebar.ties;
  // Guard against zero/negative spacing before dividing.
  const safeSpacing = ties && ties.spacing > 0 ? ties.spacing : span;
  const numTies = ties ? Math.min(MAX_STIRRUP_LINES, Math.max(1, Math.ceil(span / safeSpacing))) : 0;
  const tieZones = member.rebar.tieZones;

  // Stirrup x-positions for the zoned layout: each third uses its own pitch
  const zonedStirrupXs: number[] = [];
  if (ties && tieZones) {
    const third = span / 3;
    for (let zi = 0; zi < 3; zi++) {
      const s = tieZones[zi].spacing > 0 ? tieZones[zi].spacing : third;
      const z0 = zi * third;
      // Cap per-zone count; step evenly if the spacing is too dense to draw.
      const count = Math.min(MAX_STIRRUP_LINES, Math.max(1, Math.ceil(third / s)));
      const step = third / count;
      for (let k = 0; k < count; k++) zonedStirrupXs.push(z0 + k * step);
    }
    zonedStirrupXs.push(span);
  }

  return (
    <svg width={width * zoom} height={height * zoom} viewBox={`0 0 ${width} ${height}`}
      style={{ background: '#f8fafc', borderRadius: 8 }}>
      <defs>
        <pattern id="elvgrid" width="30" height="30" patternUnits="userSpaceOnUse">
          <path d="M 30 0 L 0 0 0 30" fill="none" stroke="#e5e7eb" strokeWidth="0.5" />
        </pattern>
        <marker id="arrowE" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="#9ca3af" />
        </marker>
      </defs>
      <rect width={width} height={height} fill="url(#elvgrid)" rx="6" />

      {/* Beam outline */}
      <rect x={ox} y={oy} width={drawW} height={drawH}
        fill={BARS.concrete} stroke={BARS.concreteEdge} strokeWidth="2" rx="1" />

      {/* Stirrups — zoned (3 spacings over thirds) or uniform */}
      {ties && tieZones ? (
        <>
          {zonedStirrupXs.map((sx, i) => (
            <line key={i}
              x1={ox + (sx / span) * drawW} y1={oy + 3}
              x2={ox + (sx / span) * drawW} y2={oy + drawH - 3}
              stroke={BARS.tie} strokeWidth="1" opacity={0.5} />
          ))}
          {/* Zone separators at L/3 and 2L/3 */}
          {[1, 2].map(i => (
            <line key={`sep-${i}`}
              x1={ox + (i / 3) * drawW} y1={oy - 6}
              x2={ox + (i / 3) * drawW} y2={oy + drawH + 6}
              stroke="#d97706" strokeWidth="1" strokeDasharray="4 3" />
          ))}
          {/* Zone spacing labels */}
          {tieZones.map((z, i) => (
            <text key={`zl-${i}`}
              x={ox + ((i + 0.5) / 3) * drawW} y={oy + drawH + 14}
              textAnchor="middle" fontSize="9" fill="#d97706" fontFamily="monospace">
              {formatBarLabel(ties.barSize)}@{fmt(z.spacing, 'length')}
            </text>
          ))}
        </>
      ) : ties && Array.from({ length: numTies + 1 }, (_, i) => {
        const x = ox + (i / numTies) * drawW;
        return (
          <line key={i} x1={x} y1={oy + 3} x2={x} y2={oy + drawH - 3}
            stroke={BARS.tie} strokeWidth="1" opacity={0.5} />
        );
      })}

      {/* Top rebar lines */}
      {member.rebar.topBars.map((_grp, gi) => (
        <line key={`top-${gi}`}
          x1={ox + 4} y1={oy + 6 + gi * 6}
          x2={ox + drawW - 4} y2={oy + 6 + gi * 6}
          stroke={BARS.top} strokeWidth="2.5" />
      ))}

      {/* Bottom rebar lines */}
      {member.rebar.botBars.map((_grp, gi) => (
        <line key={`bot-${gi}`}
          x1={ox + 4} y1={oy + drawH - 6 - gi * 6}
          x2={ox + drawW - 4} y2={oy + drawH - 6 - gi * 6}
          stroke={BARS.bot} strokeWidth="2.5" />
      ))}

      {/* Dimension: span */}
      <line x1={ox} y1={oy + drawH + 20} x2={ox + drawW} y2={oy + drawH + 20}
        stroke="#9ca3af" strokeWidth="1"
        markerStart="url(#arrowE)" markerEnd="url(#arrowE)" />
      <text x={ox + drawW / 2} y={oy + drawH + 33}
        textAnchor="middle" fontSize="11" fill="#6b7280" fontFamily="monospace">
        L = {fmt(member.span ?? 20, 'spanLength', 1)}
      </text>

      {/* Label */}
      <text x={ox + 4} y={oy - 10}
        fontSize="11" fill="#374151" fontFamily="monospace" fontWeight="bold">
        {member.label}
      </text>

      {/* Bar labels */}
      <text x={ox - 5} y={oy + 10}
        textAnchor="end" fontSize="9" fill={BARS.top} fontFamily="monospace">
        {member.rebar.topBars[0] ? `${member.rebar.topBars[0].numBars}${formatBarLabel(member.rebar.topBars[0].barSize)}` : ''}
      </text>
      <text x={ox - 5} y={oy + drawH - 4}
        textAnchor="end" fontSize="9" fill={BARS.bot} fontFamily="monospace">
        {member.rebar.botBars[0] ? `${member.rebar.botBars[0].numBars}${formatBarLabel(member.rebar.botBars[0].barSize)}` : ''}
      </text>
    </svg>
  );
}
