/**
 * SectionView — accurate ACI 318-19 cross-section drawing.
 *
 * Bar positions derived from actual clear cover, stirrup diameter, and bar diameter.
 * All geometry in inches, converted to SVG pixels via a single scale factor.
 */
import type { SectionDimensions, RebarLayout } from '../../types';
import { getBarDiam } from '../../utils/concreteDesign';

interface Props {
  section: SectionDimensions;
  rebar:   RebarLayout;
  width?:  number;
  height?: number;
}

// ── Colours ──────────────────────────────────────────────────────────────────
const C = {
  concrete:  '#2d3a4a',
  concreteEdge: '#4a9eff',
  flange:    '#263244',
  stirrup:   '#f59e0b',
  bar:       '#e2e8f0',
  barStroke: '#60a5fa',
  dim:       '#64748b',
  dimText:   '#94a3b8',
  label:     '#a78bfa',
  cover:     'rgba(251,191,36,0.08)',
  bg:        '#0f172a',
  grid:      '#1e293b',
};

export default function SectionView({ section, rebar, width = 340, height = 300 }: Props) {
  const PAD = { t: 38, b: 44, l: 44, r: 36 };
  const drawW = width  - PAD.l - PAD.r;
  const drawH = height - PAD.t - PAD.b;

  const isCirc = section.type === 'circular_column';
  const isT    = section.type === 'T_beam' || section.type === 'L_beam';

  const secW = section.b;
  const secH = section.h ?? section.diameter ?? 12;
  const bw   = section.bw ?? secW;
  const hf   = section.hf ?? 0;

  // Uniform scale — preserve aspect ratio
  const scale = Math.min(drawW / secW, drawH / secH);
  const sW    = secW * scale;
  const sH    = secH * scale;

  // Top-left of section outline in SVG space
  const ox = PAD.l + (drawW - sW) / 2;
  const oy = PAD.t + (drawH - sH) / 2;

  // ── Web origin (for T-beam, web starts at (secW−bw)/2 from left) ──
  const webX_in  = isT ? (secW - bw) / 2 : 0;   // inches
  const webOx    = ox + webX_in * scale;           // px
  const webOy    = oy + hf * scale;                // px (below flange)
  const webW     = bw * scale;
  const webH     = (secH - hf) * scale;

  // ── Stirrup / cover geometry ──────────────────────────────────────────────
  const cc        = section.coverClear;           // clear cover (in)
  const dStir     = getBarDiam(section.stirrupDia); // stirrup bar diam (in)
  const stir_r    = dStir / 2;

  // Stirrup inner rectangle corners, in section coordinates from web face
  const stir_margin_h = cc + stir_r;             // horizontal from web face
  const stir_margin_v = cc + stir_r;             // vertical from top (or bottom for T)

  // Stirrup rect in px (relative to web)
  const stirX = webOx + stir_margin_h * scale;
  const stirY_top = isT
    ? webOy + stir_margin_v * scale
    : oy    + stir_margin_v * scale;
  const stirW = webW - 2 * stir_margin_h * scale;
  const stirH = (isT ? webH : sH) - 2 * stir_margin_v * scale;

  // ── Bar position helpers ──────────────────────────────────────────────────

  /**
   * Returns x-centre positions (in px) for n bars of given size
   * evenly spaced within the web, respecting cover + stirrup + bar radius.
   */
  function barXPositions(n: number, barSize: number): number[] {
    const dBar = getBarDiam(barSize);
    const r    = dBar / 2;
    // Left and right bar centres within web
    const xL = webOx + (cc + dStir + r) * scale;
    const xR = webOx + webW - (cc + dStir + r) * scale;
    if (n <= 0)  return [];
    if (n === 1) return [(xL + xR) / 2];
    const step = (xR - xL) / (n - 1);
    return Array.from({ length: n }, (_, i) => xL + i * step);
  }

  /** Y-centre for bottom bars (row 0 = closest to bottom) */
  function botBarY(row: number, barSize: number): number {
    const dBar = getBarDiam(barSize);
    const r    = dBar / 2;
    const base = oy + sH - (cc + dStir + r) * scale;   // first row from bottom
    return base - row * (dBar + Math.max(1, dBar)) * scale;
  }

  /** Y-centre for top bars (row 0 = closest to top) */
  function topBarY(row: number, barSize: number): number {
    const dBar = getBarDiam(barSize);
    const r    = dBar / 2;
    const base = (isT ? webOy : oy) + (cc + dStir + r) * scale;
    return base + row * (dBar + Math.max(1, dBar)) * scale;
  }

  /** Circular column: bar positions on a ring */
  function circleBarPositions(totalBars: number, barSize: number) {
    const diam  = section.diameter ?? secW;
    const dBar  = getBarDiam(barSize);
    const R_in  = diam / 2 - cc - dStir - dBar / 2;     // radius to bar centres (in)
    const R_px  = R_in * scale;
    const cx    = ox + sW / 2;
    const cy    = oy + sH / 2;
    return Array.from({ length: totalBars }, (_, i) => {
      const angle = (2 * Math.PI * i) / totalBars - Math.PI / 2;
      return { x: cx + R_px * Math.cos(angle), y: cy + R_px * Math.sin(angle) };
    });
  }

  // ── Annotation helpers ────────────────────────────────────────────────────

  function dimLine(x1: number, y1: number, x2: number, y2: number, text: string, side: 'above'|'below'|'left'|'right' = 'below') {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const off = 10;
    let tx = mx, ty = my;
    if (side === 'below') ty = my + off;
    if (side === 'above') ty = my - off;
    if (side === 'left')  tx = mx - off;
    if (side === 'right') tx = mx + off;
    return (
      <g>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.dim} strokeWidth="1"
          markerStart="url(#dimArrow)" markerEnd="url(#dimArrow)" />
        <text x={tx} y={ty} textAnchor="middle" dominantBaseline="middle"
          fontSize="9.5" fill={C.dimText} fontFamily="monospace">{text}</text>
      </g>
    );
  }

  // ── Build bar elements ────────────────────────────────────────────────────

  const botBarEls: React.ReactNode[] = [];
  rebar.botBars.forEach((grp, row) => {
    const r_px = Math.max(2.5, getBarDiam(grp.barSize) / 2 * scale);
    const xs   = barXPositions(grp.numBars, grp.barSize);
    const y    = botBarY(row, grp.barSize);
    xs.forEach((x, i) => {
      botBarEls.push(
        <g key={`bot-${row}-${i}`}>
          <circle cx={x} cy={y} r={r_px + 1} fill={C.concrete} />
          <circle cx={x} cy={y} r={r_px}     fill={C.bar} stroke={C.barStroke} strokeWidth="0.8" />
        </g>
      );
    });
  });

  const topBarEls: React.ReactNode[] = [];
  rebar.topBars.forEach((grp, row) => {
    const r_px = Math.max(2.5, getBarDiam(grp.barSize) / 2 * scale);
    const xs   = barXPositions(grp.numBars, grp.barSize);
    const y    = topBarY(row, grp.barSize);
    xs.forEach((x, i) => {
      topBarEls.push(
        <g key={`top-${row}-${i}`}>
          <circle cx={x} cy={y} r={r_px + 1} fill={C.concrete} />
          <circle cx={x} cy={y} r={r_px}     fill={C.bar} stroke={C.barStroke} strokeWidth="0.8" />
        </g>
      );
    });
  });

  const sideBarEls: React.ReactNode[] = [];
  rebar.sideBars?.forEach((grp, gi) => {
    const r_px    = Math.max(2, getBarDiam(grp.barSize) / 2 * scale);
    const totalH  = isT ? webH : sH;
    const yStart  = (isT ? webOy : oy) + stir_margin_v * scale;
    const yEnd    = yStart + totalH - 2 * stir_margin_v * scale;
    const step    = (yEnd - yStart) / (grp.numBars + 1);
    for (let i = 1; i <= grp.numBars; i++) {
      const y = yStart + i * step;
      [stirX, stirX + stirW].forEach((x, j) => {
        sideBarEls.push(
          <circle key={`side-${gi}-${i}-${j}`} cx={x} cy={y} r={r_px}
            fill={C.bar} stroke={C.barStroke} strokeWidth="0.8" />
        );
      });
    }
  });

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <defs>
        <pattern id={`svGrid-${width}`} width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0L0 0 0 20" fill="none" stroke={C.grid} strokeWidth="0.5" />
        </pattern>
        <marker id="dimArrow" markerWidth="5" markerHeight="5" refX="2.5" refY="2.5" orient="auto">
          <polygon points="0,0 5,2.5 0,5" fill={C.dim} />
        </marker>
      </defs>

      {/* Background */}
      <rect width={width} height={height} fill={C.bg} rx="8" />
      <rect width={width} height={height} fill={`url(#svGrid-${width})`} rx="8" />

      {isCirc ? (
        // ── Circular column ──────────────────────────────────────────────
        <>
          <circle cx={ox + sW/2} cy={oy + sH/2} r={sW/2}
            fill={C.concrete} stroke={C.concreteEdge} strokeWidth="2" />
          {/* Spiral indicator */}
          <circle cx={ox + sW/2} cy={oy + sH/2}
            r={(section.diameter ?? secW) / 2 * scale - stir_margin_h * scale}
            fill="none" stroke={C.stirrup} strokeWidth="1.2" strokeDasharray="4,2.5" opacity="0.8" />
          {/* Bars on ring */}
          {(() => {
            const totalBars = [...rebar.topBars, ...rebar.botBars].reduce((s, g) => s + g.numBars, 0);
            const barSize   = rebar.topBars[0]?.barSize ?? rebar.botBars[0]?.barSize ?? 9;
            const r_px      = Math.max(2.5, getBarDiam(barSize) / 2 * scale);
            return circleBarPositions(totalBars, barSize).map((p, i) => (
              <g key={`circ-${i}`}>
                <circle cx={p.x} cy={p.y} r={r_px + 1} fill={C.concrete} />
                <circle cx={p.x} cy={p.y} r={r_px}     fill={C.bar} stroke={C.barStroke} strokeWidth="0.8" />
              </g>
            ));
          })()}
          {/* Diameter annotation */}
          {dimLine(ox, oy + sH / 2, ox + sW, oy + sH / 2,
            `Ø ${section.diameter ?? secW}"`, 'above')}
        </>
      ) : (
        // ── Rectangular / T-beam ─────────────────────────────────────────
        <>
          {/* Flange (T/L beam) */}
          {isT && (
            <rect x={ox} y={oy} width={sW} height={hf * scale}
              fill={C.flange} stroke={C.concreteEdge} strokeWidth="1.5" />
          )}
          {/* Web / main body */}
          <rect x={webOx} y={webOy} width={webW} height={webH}
            fill={C.concrete} stroke={C.concreteEdge} strokeWidth="2" />

          {/* Cover region shading */}
          <rect x={stirX} y={stirY_top} width={stirW} height={stirH}
            fill={C.cover} />

          {/* Stirrup outline */}
          <rect x={stirX} y={stirY_top} width={stirW} height={stirH}
            fill="none" stroke={C.stirrup} strokeWidth="1.5"
            strokeDasharray="3,1.5" rx="1" />

          {/* Bars */}
          {botBarEls}
          {topBarEls}
          {sideBarEls}

          {/* ── Dimension lines ── */}

          {/* Width (b) — below */}
          {dimLine(ox, oy + sH + 16, ox + sW, oy + sH + 16,
            isT ? `b = ${secW}"` : `b = ${secW}"`)}

          {/* Web width (bw) for T-beam — below flange */}
          {isT && dimLine(webOx, oy + sH + 28, webOx + webW, oy + sH + 28, `bw = ${bw}"`)}

          {/* Height (h) — left */}
          {dimLine(ox - 18, oy, ox - 18, oy + sH, `h = ${secH}"`, 'left')}

          {/* Flange thickness — left */}
          {isT && hf > 0 && (
            <g>
              <line x1={ox - 10} y1={oy} x2={ox - 10} y2={oy + hf * scale}
                stroke={C.dim} strokeWidth="0.8" strokeDasharray="2,1.5" />
              <text x={ox - 13} y={oy + (hf * scale) / 2}
                textAnchor="middle" dominantBaseline="middle"
                fontSize="8" fill={C.dimText} fontFamily="monospace"
                transform={`rotate(-90,${ox - 13},${oy + (hf * scale) / 2})`}>
                hf={hf}"
              </text>
            </g>
          )}

          {/* Cover callout */}
          {cc > 0 && (
            <g opacity="0.7">
              <line x1={webOx} y1={oy + sH - cc * scale}
                    x2={webOx + cc * scale} y2={oy + sH - cc * scale}
                stroke={C.stirrup} strokeWidth="0.6" strokeDasharray="2,1" />
              <text x={webOx + 2} y={oy + sH - cc * scale - 3}
                fontSize="8" fill={C.stirrup} fontFamily="monospace">
                cc={cc}"
              </text>
            </g>
          )}
        </>
      )}

      {/* ── Bar labels ─────────────────────────────────────────────────── */}
      {/* Top bar label */}
      {rebar.topBars[0] && (
        <text x={isCirc ? ox + sW/2 : ox + sW/2 + PAD.l/2} y={oy - 8}
          textAnchor="middle" fontSize="10" fill={C.label} fontFamily="monospace">
          {rebar.topBars.map(g => `${g.numBars}—#${g.barSize}`).join(' + ')} (T)
        </text>
      )}
      {/* Bottom bar label */}
      {rebar.botBars[0] && (
        <text x={isCirc ? ox + sW/2 : ox + sW/2 + PAD.l/2}
          y={isT ? oy + sH + (isT ? 40 : 38) : oy + sH + 38}
          textAnchor="middle" fontSize="10" fill={C.label} fontFamily="monospace">
          {rebar.botBars.map(g => `${g.numBars}—#${g.barSize}`).join(' + ')} (B)
        </text>
      )}
      {/* Stirrup label */}
      {rebar.ties && (
        <text x={webOx + webW + 5} y={(isT ? webOy : oy) + (isT ? webH : sH) / 2}
          fontSize="9" fill={C.stirrup} fontFamily="monospace" dominantBaseline="middle">
          #{rebar.ties.barSize}@{rebar.ties.spacing}"
        </text>
      )}
    </svg>
  );
}
