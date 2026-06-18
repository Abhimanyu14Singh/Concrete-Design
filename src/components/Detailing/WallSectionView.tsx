/**
 * WallSectionView — SVG plan-view cross-section of a shear wall
 * Shows: wall outline, distributed vertical bars, horizontal bars,
 * SBZ regions (highlighted), SBZ confinement ties, dimensions/labels
 */

import type { SectionDimensions, WallRebarLayout } from '../../types';
import { getBarDiam } from '../../utils/concreteDesign';
import {
  sbzTrigger,
  sbzDesign,
  wallReinfRatios,
} from '../../utils/wallDesign';
import { useUnits } from '../../contexts/UnitsContext';

interface Props {
  section: SectionDimensions;
  wallRebar: WallRebarLayout;
  Pu?: number;     // kips
  Mu?: number;     // kip-ft
  c_demand?: number; // neutral axis depth from analysis
  fc?: number;
  fyt?: number;
  width?: number;
  height?: number;
}

export default function WallSectionView({
  section,
  wallRebar,
  Pu = 0,
  Mu = 0,
  c_demand = 0,
  fc = 4000,
  fyt = 60000,
  width = 680,
  height = 220,
}: Props) {
  const { fmt } = useUnits();
  const lw = section.lw ?? section.b;
  const tw = section.tw ?? section.h;
  const hw = section.hw ?? (lw * 2);
  const driftRatio = wallRebar.driftRatio ?? 0.015;

  const sbz = c_demand > 0
    ? sbzTrigger(lw, tw, hw, fc, c_demand, driftRatio, Pu, Mu)
    : null;

  const sbzResult = sbz?.required && c_demand > 0
    ? sbzDesign(lw, tw, fc, fyt, c_demand, wallRebar)
    : null;

  const lbe = sbzResult?.lbe ?? 0;

  // Drawing area
  const pad = { l: 50, r: 30, t: 50, b: 45 };
  const drawW = width - pad.l - pad.r;
  const drawH = height - pad.t - pad.b;

  // Wall drawn as plan view: lw = horizontal, tw = vertical
  const scaleX = drawW / lw;
  const scaleY = drawH / tw;
  const ox = pad.l;
  const oy = pad.t;

  // Wall body dimensions in SVG coords
  const wallW = lw * scaleX;
  const wallH = tw * scaleY;

  // Cover and tie clearance
  const cover = section.coverClear;
  const tieD = getBarDiam(4); // assumed #4 tie
  const clearX = (cover + tieD) * scaleX;
  const clearY = (cover + tieD) * scaleY;

  // Bar radii (visual)
  const rVert = Math.max(3, Math.min(8, getBarDiam(wallRebar.vertBarSize) * scaleY * 0.8));
  const rHoriz = Math.max(2.5, Math.min(6, getBarDiam(wallRebar.horizBarSize) * scaleY * 0.6));
  const rSBZ = Math.max(4, Math.min(10, getBarDiam(wallRebar.sbzBarSize ?? wallRebar.vertBarSize) * scaleY * 0.9));

  // Compute distributed vertical bar positions along lw
  const vertBars: { x: number; front: boolean }[] = [];
  const sv = wallRebar.vertSpacing;
  const nVert = Math.max(1, Math.floor((lw - 2 * (cover + tieD + getBarDiam(wallRebar.vertBarSize) / 2)) / sv) + 1);

  const x0_bar = cover + tieD + getBarDiam(wallRebar.vertBarSize) / 2;
  const xSpan = lw - 2 * x0_bar;
  const actualSv = nVert > 1 ? xSpan / (nVert - 1) : 0;

  for (let i = 0; i < nVert; i++) {
    const bx = ox + (x0_bar + i * actualSv) * scaleX;
    vertBars.push({ x: bx, front: false });
  }

  // Compute SBZ boundary extents
  const sbzPxL = lbe * scaleX; // SBZ width at left end
  const sbzPxR = lbe * scaleX; // SBZ width at right end (symmetric)

  // SBZ bar positions (concentrated at boundaries)
  const hasSBZ = sbz?.required && (wallRebar.sbzNumBars ?? 0) > 0;
  const sbzBarPositions: { x: number; y: number }[] = [];

  if (hasSBZ && sbzResult) {
    const nSBZ = wallRebar.sbzNumBars ?? 4;
    const sbzBarSize = wallRebar.sbzBarSize ?? wallRebar.vertBarSize;
    const sbzCoverX = (cover + tieD + getBarDiam(sbzBarSize) / 2) * scaleX;
    const sbzCoverY = (cover + tieD + getBarDiam(sbzBarSize) / 2) * scaleY;

    // Arrange SBZ bars in rectangular pattern within lbe × tw
    const cols = Math.max(2, Math.ceil(Math.sqrt(nSBZ)));
    const rows = Math.ceil(nSBZ / cols);

    // Left SBZ boundary (near x=0)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (idx >= nSBZ) break;
        const bx = ox + sbzCoverX + c * ((sbzPxL - 2 * sbzCoverX) / Math.max(1, cols - 1));
        const by = oy + sbzCoverY + r * ((wallH - 2 * sbzCoverY) / Math.max(1, rows - 1));
        sbzBarPositions.push({ x: bx, y: by });
      }
    }

    // Right SBZ boundary (near x=lw)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (idx >= nSBZ) break;
        const bx = ox + wallW - sbzCoverX - c * ((sbzPxR - 2 * sbzCoverX) / Math.max(1, cols - 1));
        const by = oy + sbzCoverY + r * ((wallH - 2 * sbzCoverY) / Math.max(1, rows - 1));
        sbzBarPositions.push({ x: bx, y: by });
      }
    }
  }

  // Horizontal bars: shown as dots at front/back face (two rows)
  const yFront = oy + clearY;
  const yBack = oy + wallH - clearY;
  const sh = wallRebar.horizSpacing;
  const nHoriz = Math.max(1, Math.floor(lw / sh) + 1);
  const horizXSpan = lw - 2 * (cover + tieD + getBarDiam(wallRebar.horizBarSize) / 2);
  const x0_horiz = cover + tieD + getBarDiam(wallRebar.horizBarSize) / 2;
  const actualSh = nHoriz > 1 ? horizXSpan / (nHoriz - 1) : 0;

  const horizBars: number[] = [];
  for (let i = 0; i < nHoriz; i++) {
    horizBars.push(ox + (x0_horiz + i * actualSh) * scaleX);
  }

  // SBZ tie rects
  const sbzTieRects: { x: number; width: number }[] = [];
  if (hasSBZ && sbzResult) {
    const tieInset = (cover + tieD / 2) * scaleX;
    const tieInsetY = (cover + tieD / 2) * scaleY;
    sbzTieRects.push(
      { x: ox + tieInset, width: sbzPxL - 2 * tieInset },
      { x: ox + wallW - sbzPxR + tieInset, width: sbzPxR - 2 * tieInset }
    );
  }

  return (
    <svg width={width} height={height} style={{ background: '#0f172a', borderRadius: 8 }}>
      <defs>
        <pattern id="wallgrid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#1e293b" strokeWidth="0.5" />
        </pattern>
        <marker id="arrowW" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#64748b" />
        </marker>
        <marker id="arrowWR" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto-start-reverse">
          <path d="M0,0 L6,3 L0,6 Z" fill="#64748b" />
        </marker>
      </defs>
      <rect width={width} height={height} fill="url(#wallgrid)" rx="8" />

      {/* SBZ highlighted zone — drawn first (behind bars) */}
      {hasSBZ && sbzResult && (
        <>
          <rect x={ox} y={oy} width={sbzPxL} height={wallH}
            fill="rgba(245,158,11,0.15)" stroke="none" />
          <rect x={ox + wallW - sbzPxR} y={oy} width={sbzPxR} height={wallH}
            fill="rgba(245,158,11,0.15)" stroke="none" />
        </>
      )}

      {/* Wall concrete body */}
      <rect x={ox} y={oy} width={wallW} height={wallH}
        fill="#1e3a5f" stroke="#60a5fa" strokeWidth="2" />

      {/* SBZ boundary markers (dashed border) */}
      {hasSBZ && sbzResult && (
        <>
          <rect x={ox} y={oy} width={sbzPxL} height={wallH}
            fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="5,3" />
          <rect x={ox + wallW - sbzPxR} y={oy} width={sbzPxR} height={wallH}
            fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="5,3" />
        </>
      )}

      {/* Stirrup/tie outline (outer perimeter tie) */}
      <rect
        x={ox + clearX} y={oy + clearY}
        width={wallW - 2 * clearX} height={wallH - 2 * clearY}
        fill="none" stroke="#fbbf24" strokeWidth="1" strokeDasharray="3,2"
      />

      {/* SBZ confinement tie rects */}
      {sbzTieRects.map((r, i) => (
        <rect key={`stie-${i}`}
          x={r.x} y={oy + (cover + tieD / 2) * scaleY}
          width={Math.max(0, r.width)} height={wallH - 2 * (cover + tieD / 2) * scaleY}
          fill="none" stroke="#f97316" strokeWidth="1.5"
        />
      ))}

      {/* Distributed vertical bars */}
      {vertBars.map((bar, i) => {
        const inSBZ = hasSBZ && sbzResult &&
          (bar.x < ox + sbzPxL + rVert || bar.x > ox + wallW - sbzPxR - rVert);
        if (inSBZ) return null; // SBZ bars drawn separately
        return (
          <circle key={`vb-${i}`}
            cx={bar.x}
            cy={oy + wallH / 2}
            r={rVert}
            fill="#1a2744" stroke="#4a90d9" strokeWidth="1.2"
          />
        );
      })}

      {/* Horizontal bars (front and back faces) */}
      {horizBars.map((hx, i) => (
        <g key={`hb-${i}`}>
          <circle cx={hx} cy={yFront} r={rHoriz} fill="#1a2744" stroke="#22c55e" strokeWidth="1" />
          {wallRebar.numCurtains === 2 && (
            <circle cx={hx} cy={yBack} r={rHoriz} fill="#1a2744" stroke="#22c55e" strokeWidth="1" />
          )}
        </g>
      ))}

      {/* SBZ bars */}
      {sbzBarPositions.map((pos, i) => (
        <circle key={`sbz-${i}`}
          cx={pos.x} cy={pos.y}
          r={rSBZ}
          fill="#1a2744" stroke="#f59e0b" strokeWidth="1.5"
        />
      ))}

      {/* ── Dimension annotations ── */}
      {/* lw dimension at bottom */}
      <line x1={ox} y1={oy + wallH + 18} x2={ox + wallW} y2={oy + wallH + 18}
        stroke="#64748b" strokeWidth="1"
        markerStart="url(#arrowWR)" markerEnd="url(#arrowW)" />
      <text x={ox + wallW / 2} y={oy + wallH + 30}
        textAnchor="middle" fontSize="11" fill="#94a3b8" fontFamily="monospace">
        lw = {fmt(lw, 'length')}
      </text>

      {/* tw dimension at right */}
      <line x1={ox + wallW + 12} y1={oy} x2={ox + wallW + 12} y2={oy + wallH}
        stroke="#64748b" strokeWidth="1"
        markerStart="url(#arrowWR)" markerEnd="url(#arrowW)" />
      <text x={ox + wallW + 24} y={oy + wallH / 2}
        textAnchor="start" fontSize="11" fill="#94a3b8" fontFamily="monospace"
        dominantBaseline="middle">
        tw={fmt(tw, 'length')}
      </text>

      {/* SBZ length dimension */}
      {hasSBZ && sbzResult && (
        <>
          <line x1={ox} y1={oy - 16} x2={ox + sbzPxL} y2={oy - 16}
            stroke="#f59e0b" strokeWidth="1"
            markerStart="url(#arrowWR)" markerEnd="url(#arrowW)" />
          <text x={ox + sbzPxL / 2} y={oy - 22}
            textAnchor="middle" fontSize="9" fill="#f59e0b" fontFamily="monospace">
            lbe={fmt(lbe, 'length')}
          </text>
          <line x1={ox + wallW - sbzPxR} y1={oy - 16} x2={ox + wallW} y2={oy - 16}
            stroke="#f59e0b" strokeWidth="1"
            markerStart="url(#arrowWR)" markerEnd="url(#arrowW)" />
          <text x={ox + wallW - sbzPxR / 2} y={oy - 22}
            textAnchor="middle" fontSize="9" fill="#f59e0b" fontFamily="monospace">
            lbe={fmt(lbe, 'length')}
          </text>
        </>
      )}

      {/* Bar labels */}
      <text x={ox} y={oy - 6}
        fontSize="10" fill="#4a90d9" fontFamily="monospace">
        V: #{wallRebar.vertBarSize}@{fmt(wallRebar.vertSpacing, 'length')} ({wallRebar.numCurtains}C)
      </text>

      <text x={ox + wallW * 0.5} y={oy - 6}
        textAnchor="middle" fontSize="10" fill="#22c55e" fontFamily="monospace">
        H: #{wallRebar.horizBarSize}@{fmt(wallRebar.horizSpacing, 'length')}
      </text>

      {hasSBZ && (
        <text x={ox + wallW} y={oy - 6}
          textAnchor="end" fontSize="10" fill="#f59e0b" fontFamily="monospace" fontWeight="bold">
          SBZ: {wallRebar.sbzNumBars ?? 0}-#{wallRebar.sbzBarSize ?? 0}
        </text>
      )}

      {/* Legend */}
      <g transform={`translate(${ox}, ${oy + wallH + 36})`}>
        <circle cx={6} cy={4} r={4} fill="#1a2744" stroke="#4a90d9" strokeWidth="1" />
        <text x={14} y={8} fontSize="9" fill="#4a90d9" fontFamily="monospace">Vert.</text>
        <circle cx={60} cy={4} r={3.5} fill="#1a2744" stroke="#22c55e" strokeWidth="1" />
        <text x={68} y={8} fontSize="9" fill="#22c55e" fontFamily="monospace">Horiz.</text>
        {hasSBZ && (
          <>
            <circle cx={118} cy={4} r={4.5} fill="#1a2744" stroke="#f59e0b" strokeWidth="1.5" />
            <text x={127} y={8} fontSize="9" fill="#f59e0b" fontFamily="monospace">SBZ bars</text>
            <rect x={190} y={0} width={12} height={8} fill="rgba(245,158,11,0.2)" stroke="#f59e0b" strokeWidth="1" />
            <text x={206} y={8} fontSize="9" fill="#f59e0b" fontFamily="monospace">SBZ zone</text>
          </>
        )}
      </g>
    </svg>
  );
}
