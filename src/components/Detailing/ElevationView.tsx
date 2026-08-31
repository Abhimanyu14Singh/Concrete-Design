import { formatBarLabel } from '../../utils/rebar';
import { getBarArea } from '../../utils/concreteDesign';
import type { BarGroup, Member } from '../../types';
import { useUnits } from '../../contexts/UnitsContext';
import { BARS, FONT, STATUS } from '../../theme';

/** The cage actually detailed in one L/3 region. */
export interface ElevationRegion {
  /** Shown above the third; "Mark End", "Middle ⅓", "Opp. End". */
  title: string;
  top: BarGroup[];
  bot: BarGroup[];
}

interface Props {
  member: Member;
  width?: number;
  height?: number;
  /** Visual zoom: the SVG is laid out at width×height and displayed at zoom× that size. */
  zoom?: number;
  /**
   * Per-L/3 cages — mark end, middle third, opposite end. When given, the top and bottom
   * steel is drawn and labelled PER THIRD rather than as one line across the span, which
   * is what the beam is actually detailed as: top governs at the supports and is
   * curtailed through mid-span, bottom governs at mid-span and is curtailed toward the
   * supports. Same three regions the group card's L/3 pop-out draws in section.
   *
   * Omitted (the default) keeps the original single-cage drawing.
   */
  regions?: [ElevationRegion, ElevationRegion, ElevationRegion];
}

export default function ElevationView({ member, width = 600, height = 160, zoom = 1, regions }: Props) {
  const { fmt } = useUnits();
  // Per-third labels need a band above and below the beam. Only claimed when regions are
  // actually being drawn, so the plain elevation keeps its proportions.
  const pad = { l: 50, r: 30, t: regions ? 52 : 40, b: regions ? 64 : 40 };
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

  // The L/3 lines are drawn whenever there is anything that varies by third — zoned
  // links, or per-region cages. Without either, a beam is one detail end to end and the
  // separators would be decoration.
  const showThirds = !!(tieZones || regions);
  const areaOf = (bars: BarGroup[] | undefined) =>
    (bars ?? []).reduce((sum, b) => sum + Math.max(0, b.numBars) * getBarArea(b.barSize), 0);
  const desc = (bars: BarGroup[] | undefined) => {
    const a = (bars ?? []).filter(b => b.numBars > 0);
    return a.length ? a.map(b => `${b.numBars}-${formatBarLabel(b.barSize)}`).join('+') : '—';
  };
  // A region is drawn "reduced" against the biggest cage on ITS OWN face, so the eye
  // reads which thirds carry the full cage and which are curtailed.
  const maxTop = regions ? Math.max(...regions.map(r => areaOf(r.top))) : 0;
  const maxBot = regions ? Math.max(...regions.map(r => areaOf(r.bot))) : 0;
  const barStroke = (a: number, max: number) => (max > 0 && a < max - 1e-9 ? 1.6 : 3);

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

  // Same ground, same variable, same default as SectionView — see the note there. The two
  // drawings sit in the same workspace and often side by side, so one of them keeping a
  // slate tile while the other went transparent would be the more obvious seam.
  return (
    <svg width={width * zoom} height={height * zoom} viewBox={`0 0 ${width} ${height}`}
      style={{ background: 'var(--sv-bg, #f8fafc)', borderRadius: 8 }}>
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
          {/* Zone spacing labels */}
          {tieZones.map((z, i) => (
            <text key={`zl-${i}`}
              x={ox + ((i + 0.5) / 3) * drawW} y={oy + drawH + 14}
              textAnchor="middle" fontSize="9" fill={STATUS.warn} fontFamily={FONT.mono}>
              {formatBarLabel(ties.barSize)}@{fmt(z.spacing, 'length')}
            </text>
          ))}
        </>
      ) : ties && (
        <>
          {Array.from({ length: numTies + 1 }, (_, i) => {
            const x = ox + (i / numTies) * drawW;
            return (
              <line key={i} x1={x} y1={oy + 3} x2={x} y2={oy + drawH - 3}
                stroke={BARS.tie} strokeWidth="1" opacity={0.5} />
            );
          })}
          {/* Not zoned, so one spacing applies end to end — but it is still worth
              stating, in the same place the zoned labels appear, so the reader never has
              to work out whether a blank means "uniform" or "not detailed yet". */}
          <text x={ox + drawW / 2} y={oy + drawH + 14} textAnchor="middle"
            fontSize="9" fill={STATUS.warn} fontFamily={FONT.mono}>
            {formatBarLabel(ties.barSize)}@{fmt(ties.spacing, 'length')} throughout
          </text>
        </>
      )}

      {/* L/3 separators — one set, whether the thirds differ by links or by cage. */}
      {showThirds && [1, 2].map(i => (
        <line key={`sep-${i}`}
          x1={ox + (i / 3) * drawW} y1={oy - 6}
          x2={ox + (i / 3) * drawW} y2={oy + drawH + 6}
          stroke={STATUS.warn} strokeWidth="1" strokeDasharray="4 3" />
      ))}

      {regions ? (
        /* Steel PER THIRD: a segment per region, thinned and dashed where that third
           carries less than the heaviest cage on the same face, with the count above
           (top) and below (bottom) — the same centred-on-the-third placement the link
           spacing labels use, so the three callouts read as one column per region. */
        regions.map((r, i) => {
          const x1 = ox + (i / 3) * drawW + (i === 0 ? 4 : 1);
          const x2 = ox + ((i + 1) / 3) * drawW - (i === 2 ? 4 : 1);
          const cx = (x1 + x2) / 2;
          const aTop = areaOf(r.top), aBot = areaOf(r.bot);
          const cutTop = maxTop > 0 && aTop < maxTop - 1e-9;
          const cutBot = maxBot > 0 && aBot < maxBot - 1e-9;
          return (
            <g key={`rgn-${i}`}>
              <text x={cx} y={oy - 24} textAnchor="middle" fontSize="8.5" fill="#94a3b8"
                fontFamily={FONT.mono}>{r.title}</text>
              <line x1={x1} y1={oy + 6} x2={x2} y2={oy + 6} stroke={BARS.top}
                strokeWidth={barStroke(aTop, maxTop)} strokeDasharray={cutTop ? '7 4' : undefined} />
              <text x={cx} y={oy - 11} textAnchor="middle" fontSize="9.5" fill={BARS.top}
                fontFamily={FONT.mono} fontWeight={cutTop ? 400 : 700}>{desc(r.top)}</text>
              <line x1={x1} y1={oy + drawH - 6} x2={x2} y2={oy + drawH - 6} stroke={BARS.bot}
                strokeWidth={barStroke(aBot, maxBot)} strokeDasharray={cutBot ? '7 4' : undefined} />
              <text x={cx} y={oy + drawH + 27} textAnchor="middle" fontSize="9.5" fill={BARS.bot}
                fontFamily={FONT.mono} fontWeight={cutBot ? 400 : 700}>{desc(r.bot)}</text>
            </g>
          );
        })
      ) : (
        <>
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
        </>
      )}

      {/* Dimension: span */}
      <line x1={ox} y1={oy + drawH + (regions ? 38 : 20)} x2={ox + drawW} y2={oy + drawH + (regions ? 38 : 20)}
        stroke="#9ca3af" strokeWidth="1"
        markerStart="url(#arrowE)" markerEnd="url(#arrowE)" />
      <text x={ox + drawW / 2} y={oy + drawH + (regions ? 51 : 33)}
        textAnchor="middle" fontSize="11" fill="#6b7280" fontFamily={FONT.mono}>
        L = {fmt(member.span ?? 20, 'spanLength', 1)}
      </text>

      {/* Label */}
      <text x={ox + 4} y={oy - (regions ? 37 : 10)}
        fontSize="11" fill="#374151" fontFamily={FONT.mono} fontWeight="bold">
        {member.label}
      </text>

      {/* Bar labels — only in the single-cage drawing; with regions every third is
          already labelled and these would repeat the mark end. */}
      {!regions && <text x={ox - 5} y={oy + 10}
        textAnchor="end" fontSize="9" fill={BARS.top} fontFamily={FONT.mono}>
        {member.rebar.topBars[0] ? `${member.rebar.topBars[0].numBars}${formatBarLabel(member.rebar.topBars[0].barSize)}` : ''}
      </text>}
      {!regions && <text x={ox - 5} y={oy + drawH - 4}
        textAnchor="end" fontSize="9" fill={BARS.bot} fontFamily={FONT.mono}>
        {member.rebar.botBars[0] ? `${member.rebar.botBars[0].numBars}${formatBarLabel(member.rebar.botBars[0].barSize)}` : ''}
      </text>}
    </svg>
  );
}
