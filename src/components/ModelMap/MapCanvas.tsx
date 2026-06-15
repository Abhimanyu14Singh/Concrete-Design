/**
 * MapCanvas — generalized plan-view SVG canvas for model frames.
 * Supports coloring by DCR, group, or section; lasso multi-select; zoom/pan;
 * V/M diagram overlays; and a rich hover tooltip showing DCR split + rebar.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import type { MapFrame, DesignGroup, AutoGroupBin } from '../../types';
import { dcrToColor } from '../EtabsImport/dcrColors';
import { valueToRampColor, rampStops } from './colorRamp';

export type ColorMode = 'dcr' | 'group' | 'section' | 'flexSteel' | 'stirrups' | 'weight' | 'autoGroup';
export type DiagramMode = 'off' | 'moment' | 'shear';

/** Rich per-member info shown in the tooltip. */
export interface FrameInfo {
  dcr: number;
  dcrFlex: number;
  dcrShear: number;
  top: string;
  bot: string;
  stirrups: string;
  /** Steel weight intensity, e.g. "23.4 lb/ft (L 16.1 + S 7.3)". */
  weight?: string;
  error?: string;
}

const GROUP_PALETTE = [
  '#2563eb','#16a34a','#d97706','#9333ea','#0891b2',
  '#dc2626','#65a30d','#7c3aed','#0284c7','#be185d',
];

const DIAGRAM_MAX_PX = 18; // max perpendicular offset for diagram in SVG user-space pixels

interface Props {
  frames: MapFrame[];
  dcrById?: Record<string, number>;
  infoById?: Record<string, FrameInfo>;
  designGroups?: DesignGroup[];
  story?: string;
  colorMode?: ColorMode;
  selected: Set<string>;
  onSelectionChange: (names: Set<string>) => void;
  onDoubleClick?: (memberId: string) => void;
  /** When provided and returns true, default selection change is suppressed. */
  onFrameClick?: (frameName: string) => boolean;
  /** Called on single click in inspect mode; provides screen coords. */
  onBeamInspect?: (memberId: string, clientX: number, clientY: number) => void;
  /** Called on right-click on a designed frame. */
  onBeamContextMenu?: (memberId: string, frameName: string, clientX: number, clientY: number) => void;
  width?: number;
  height?: number;
  diagramMode?: DiagramMode;
  diagramDataById?: Record<string, { x: number; v: number }[]>;
  /** For 'flexSteel' / 'stirrups' modes: metric value by memberId. */
  metricById?: Record<string, number>;
  metricRange?: { min: number; max: number };
  metricLabel?: string;
  /** Auto-group overlay bins for 'autoGroup' color mode. */
  autoGroupOverlay?: AutoGroupBin[];
  /** Member ids to hide from the canvas. */
  hiddenMemberIds?: Set<string>;
  /** Stories to hide from the canvas. */
  hiddenStories?: Set<string>;
  /** Whether click-to-inspect is active. */
  inspectMode?: boolean;
  /** Member currently shown in the rich inspect card (tooltip suppressed for it). */
  inspectedMemberId?: string | null;
}

export default function MapCanvas({
  frames, dcrById = {}, infoById = {}, designGroups = [], story = 'All',
  colorMode = 'dcr', selected, onSelectionChange, onDoubleClick, onFrameClick,
  onBeamInspect, onBeamContextMenu,
  width = 640, height = 480,
  diagramMode = 'off', diagramDataById = {},
  metricById = {}, metricRange, metricLabel,
  autoGroupOverlay = [], hiddenMemberIds = new Set(), hiddenStories = new Set(),
  inspectMode = false, inspectedMemberId = null,
}: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: width, h: height });
  const [lasso, setLasso] = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ mx: number; my: number; vx: number; vy: number } | null>(null);
  const lassoBgOnly = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const visibleFrames = frames.filter(f =>
    (story === 'All' || f.story === story) &&
    !hiddenStories.has(f.story) &&
    !(f.memberId && hiddenMemberIds.has(f.memberId))
  );

  // Compute bounds
  const pts = visibleFrames.flatMap(f => [f.pt1, f.pt2]);
  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  const minX = xs.length ? Math.min(...xs) : 0;
  const maxX = xs.length ? Math.max(...xs) : 1;
  const minY = ys.length ? Math.min(...ys) : 0;
  const maxY = ys.length ? Math.max(...ys) : 1;

  const pad = 40;
  const scaleX = (width - 2 * pad) / Math.max(maxX - minX, 1);
  const scaleY = (height - 2 * pad) / Math.max(maxY - minY, 1);
  const scale = Math.min(scaleX, scaleY);

  useEffect(() => {
    setViewBox({ x: 0, y: 0, w: width, h: height });
  }, [frames, width, height]);

  const tx = (x: number) => pad + (x - minX) * scale;
  const ty = (y: number) => height - pad - (y - minY) * scale;

  // Group color lookup (by memberId)
  const groupColorMap = new Map<string, string>();
  designGroups.forEach((g, i) => {
    const color = g.color ?? GROUP_PALETTE[i % GROUP_PALETTE.length];
    g.memberIds.forEach(mid => groupColorMap.set(mid, color));
  });

  // Auto-group overlay color lookup
  const autoGroupColorMap = new Map<string, string>();
  autoGroupOverlay.forEach(bin => {
    bin.memberIds.forEach(mid => autoGroupColorMap.set(mid, bin.color));
  });

  function frameColor(f: MapFrame): string {
    if (colorMode === 'autoGroup') {
      if (f.memberId) {
        const c = autoGroupColorMap.get(f.memberId);
        if (c) return c;
      }
      return '#9ca3af';
    }
    if (colorMode === 'group') {
      if (f.memberId) {
        const c = groupColorMap.get(f.memberId);
        if (c) return c;
      }
      return '#9ca3af';
    }
    if ((colorMode === 'flexSteel' || colorMode === 'stirrups' || colorMode === 'weight') && f.memberId) {
      const v = metricById[f.memberId];
      if (v !== undefined && metricRange) {
        return valueToRampColor(v, metricRange.min, metricRange.max);
      }
      return '#d1d5db';
    }
    if (colorMode === 'section') {
      let h = 0;
      for (const ch of f.sectionName) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
      return `hsl(${(h * 137) % 360},60%,45%)`;
    }
    if (f.memberId) {
      const dcr = dcrById[f.memberId] ?? 0;
      return dcrToColor(dcr);
    }
    return '#d1d5db';
  }

  const mouseToSvg = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    return {
      x: viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.w,
      y: viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.h,
    };
  }, [viewBox]);

  // Wheel zoom — native non-passive
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.15 : 0.87;
      const pt = mouseToSvg(e.clientX, e.clientY);
      if (!pt) return;
      setViewBox(vb => ({
        x: pt.x - (pt.x - vb.x) * factor,
        y: pt.y - (pt.y - vb.y) * factor,
        w: vb.w * factor,
        h: vb.h * factor,
      }));
    };
    svg.addEventListener('wheel', handler, { passive: false });
    return () => svg.removeEventListener('wheel', handler);
  }, [mouseToSvg]);

  function onMouseDown(e: React.MouseEvent) {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      setIsPanning(true);
      panStart.current = { mx: e.clientX, my: e.clientY, vx: viewBox.x, vy: viewBox.y };
      e.preventDefault();
      return;
    }
    if (e.button === 0 && !e.altKey) {
      const pt = mouseToSvg(e.clientX, e.clientY);
      if (!pt) return;
      const tag = (e.target as Element).tagName.toLowerCase();
      lassoBgOnly.current = tag === 'svg' || tag === 'rect' || tag === 'pattern';
      setLasso({ sx: pt.x, sy: pt.y, ex: pt.x, ey: pt.y });
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    if (isPanning && panStart.current) {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || !rect.width) return;
      const dx = ((e.clientX - panStart.current.mx) / rect.width) * viewBox.w;
      const dy = ((e.clientY - panStart.current.my) / rect.height) * viewBox.h;
      setViewBox(vb => ({ ...vb, x: panStart.current!.vx - dx, y: panStart.current!.vy - dy }));
      return;
    }
    if (lasso) {
      const pt = mouseToSvg(e.clientX, e.clientY);
      if (!pt) return;
      setLasso(l => l ? { ...l, ex: pt.x, ey: pt.y } : null);
    }
  }

  function onMouseUp(e: React.MouseEvent) {
    if (isPanning) {
      setIsPanning(false);
      panStart.current = null;
      return;
    }
    if (lasso) {
      const { sx, sy, ex, ey } = lasso;
      const lx1 = Math.min(sx, ex), lx2 = Math.max(sx, ex);
      const ly1 = Math.min(sy, ey), ly2 = Math.max(sy, ey);
      const drag = Math.abs(ex - sx) > 4 || Math.abs(ey - sy) > 4;
      if (drag) {
        const hit = new Set<string>();
        for (const f of visibleFrames) {
          const x1 = tx(f.pt1.x), y1 = ty(f.pt1.y);
          const x2 = tx(f.pt2.x), y2 = ty(f.pt2.y);
          if (Math.min(x1, x2) >= lx1 && Math.max(x1, x2) <= lx2 &&
              Math.min(y1, y2) >= ly1 && Math.max(y1, y2) <= ly2) {
            hit.add(f.frameName);
          }
        }
        onSelectionChange(e.shiftKey ? new Set([...selected, ...hit]) : hit);
      } else if (!e.shiftKey && !e.ctrlKey && !e.metaKey && lassoBgOnly.current) {
        onSelectionChange(new Set());
      }
      setLasso(null);
    }
  }

  useEffect(() => {
    const onWinMouseUp = () => {
      if (isPanning) { setIsPanning(false); panStart.current = null; }
      setLasso(l => (l ? null : l));
    };
    const onWinKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSelectionChange(new Set());
    };
    window.addEventListener('mouseup', onWinMouseUp);
    window.addEventListener('keydown', onWinKeyDown);
    return () => {
      window.removeEventListener('mouseup', onWinMouseUp);
      window.removeEventListener('keydown', onWinKeyDown);
    };
  }, [isPanning, onSelectionChange]);

  function fitView() {
    setViewBox({ x: 0, y: 0, w: width, h: height });
  }

  const hovered = hover ? visibleFrames.find(f => f.frameName === hover) : null;
  const hoveredInfo = hovered?.memberId ? infoById[hovered.memberId] : null;

  // ── V/M diagram overlay ────────────────────────────────────────────────────
  // For each visible linked frame with diagram data, render a filled polygon
  // perpendicular to the beam axis, scaled to the global max.
  const diagramPolygons = (() => {
    if (diagramMode === 'off') return null;

    // Global max for normalization
    let globalMax = 0;
    for (const f of visibleFrames) {
      if (!f.memberId) continue;
      const data = diagramDataById[f.memberId];
      if (data) for (const pt of data) globalMax = Math.max(globalMax, pt.v);
    }
    if (globalMax === 0) return null;

    const color = diagramMode === 'moment' ? 'rgba(124,58,237,0.25)' : 'rgba(8,145,178,0.25)';
    const stroke = diagramMode === 'moment' ? '#7c3aed' : '#0891b2';

    return visibleFrames.map(f => {
      if (!f.memberId) return null;
      const data = diagramDataById[f.memberId];
      if (!data || data.length < 2) return null;

      const x1s = tx(f.pt1.x), y1s = ty(f.pt1.y);
      const x2s = tx(f.pt2.x), y2s = ty(f.pt2.y);
      const dx = x2s - x1s, dy = y2s - y1s;
      const len = Math.hypot(dx, dy);
      if (len < 1) return null;

      // Unit perpendicular (90° CCW from beam direction)
      const nx = -dy / len, ny = dx / len;

      // Map station x (ft from I-node) to SVG coordinates along the beam
      const beamLenFt = f.pt1 && f.pt2
        ? Math.hypot(f.pt2.x - f.pt1.x, f.pt2.y - f.pt1.y)
        : 0;
      if (beamLenFt < 0.001) return null;

      const pts: string[] = [];
      // Bottom edge (baseline along the beam)
      pts.push(`${x1s},${y1s}`);
      pts.push(`${x2s},${y2s}`);
      // Top edge (offset by diagram value)
      for (let i = data.length - 1; i >= 0; i--) {
        const t = data[i].x / beamLenFt; // 0..1
        const bx = x1s + t * dx;
        const by = y1s + t * dy;
        const off = (data[i].v / globalMax) * DIAGRAM_MAX_PX;
        pts.push(`${bx + nx * off},${by + ny * off}`);
      }

      return (
        <polygon key={f.frameName + '-diag'}
          points={pts.join(' ')}
          fill={color} stroke={stroke} strokeWidth={0.8} opacity={0.85}
          style={{ pointerEvents: 'none' }}
        />
      );
    });
  })();

  return (
    <div style={{ position: 'relative', userSelect: 'none' }}>
      <svg
        ref={svgRef}
        width={width} height={height}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        style={{ background: '#f8fafc', borderRadius: 10, border: '1px solid #e5e7eb', cursor: isPanning ? 'grabbing' : lasso ? 'crosshair' : inspectMode ? 'zoom-in' : 'default', display: 'block' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onContextMenu={e => {
          e.preventDefault();
          // Find which frame was right-clicked via data attribute
          const el = (e.target as Element).closest('[data-framename]');
          const frameName = el?.getAttribute('data-framename');
          if (!frameName) return;
          const frame = visibleFrames.find(f => f.frameName === frameName);
          if (frame?.memberId) onBeamContextMenu?.(frame.memberId, frameName, e.clientX, e.clientY);
        }}
      >
        <defs>
          <pattern id="mmgrid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#eef2f7" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={width} height={height} fill="url(#mmgrid)" rx="10" />

        {/* Diagram overlays (below beams) */}
        {diagramPolygons}

        {visibleFrames.map(f => {
          const isSel = selected.has(f.frameName);
          const isHov = hover === f.frameName;
          const x1 = tx(f.pt1.x), y1 = ty(f.pt1.y);
          const x2 = tx(f.pt2.x), y2 = ty(f.pt2.y);
          const color = frameColor(f);
          const linked = !!f.memberId;
          return (
            <g key={f.frameName}
              data-framename={f.frameName}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHover(f.frameName)}
              onMouseLeave={() => setHover(h => h === f.frameName ? null : h)}
              onClick={e => {
                e.stopPropagation();
                // Inspect mode: show beam card instead of selecting
                if (inspectMode && f.memberId) {
                  onBeamInspect?.(f.memberId, e.clientX, e.clientY);
                  return;
                }
                // Group-edit mode: delegate to onFrameClick; it returns true if handled
                if (onFrameClick && onFrameClick(f.frameName)) return;
                const additive = e.shiftKey || e.ctrlKey || e.metaKey;
                if (additive) {
                  const next = new Set(selected);
                  if (next.has(f.frameName)) next.delete(f.frameName); else next.add(f.frameName);
                  onSelectionChange(next);
                } else {
                  onSelectionChange(new Set([f.frameName]));
                }
              }}
              onDoubleClick={() => f.memberId && onDoubleClick?.(f.memberId)}
            >
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} />
              {isSel && <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#2563eb" strokeWidth={9} opacity={0.35} strokeLinecap="round" />}
              <line x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={color}
                strokeWidth={isHov ? 5 : 3}
                strokeLinecap="round"
                strokeDasharray={linked ? undefined : '6 4'}
                opacity={linked ? 1 : 0.6}
              />
            </g>
          );
        })}

        {/* Lasso rect */}
        {lasso && (() => {
          const { sx, sy, ex, ey } = lasso;
          return (
            <rect
              x={Math.min(sx, ex)} y={Math.min(sy, ey)}
              width={Math.abs(ex - sx)} height={Math.abs(ey - sy)}
              fill="rgba(37,99,235,0.08)" stroke="#2563eb" strokeWidth={1} strokeDasharray="4 2"
            />
          );
        })()}
      </svg>

      {/* Toolbar overlay */}
      <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 4 }}>
        <button onClick={fitView} style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 8px', fontSize: 11, cursor: 'pointer', color: '#374151' }} title="Fit to view">⊡ Fit</button>
      </div>

      {/* Hover tooltip — suppressed for the beam currently shown in the rich card. */}
      {hovered && !(inspectMode && hovered.memberId === inspectedMemberId) && (
        <div style={{
          position: 'absolute', top: 8, right: 8, background: 'white',
          border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px',
          fontSize: 11, color: '#374151', boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          pointerEvents: 'none', maxWidth: 240,
        }}>
          <div style={{ fontWeight: 700, color: '#111827', marginBottom: 3 }}>{hovered.frameName}</div>
          <div style={{ color: '#6b7280', marginBottom: 4 }}>{hovered.story} · {hovered.sectionName}</div>
          {hoveredInfo ? (
            hoveredInfo.error ? (
              <div style={{ color: '#dc2626', fontSize: 10 }}>DCR unavailable: {hoveredInfo.error}</div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 3 }}>
                  <span>Flex <span style={{ fontFamily: 'monospace', fontWeight: 700, color: dcrToColor(hoveredInfo.dcrFlex) }}>{hoveredInfo.dcrFlex.toFixed(3)}</span></span>
                  <span>Shear <span style={{ fontFamily: 'monospace', fontWeight: 700, color: dcrToColor(hoveredInfo.dcrShear) }}>{hoveredInfo.dcrShear.toFixed(3)}</span></span>
                </div>
                <div style={{ fontSize: 10, color: '#6b7280', lineHeight: 1.6 }}>
                  <div>Top: <span style={{ color: '#111827' }}>{hoveredInfo.top}</span></div>
                  <div>Bot: <span style={{ color: '#111827' }}>{hoveredInfo.bot}</span></div>
                  <div>Stirrups: <span style={{ color: '#111827' }}>{hoveredInfo.stirrups}</span></div>
                  {hoveredInfo.weight && (
                    <div>Steel: <span style={{ color: '#111827', fontFamily: 'monospace' }}>{hoveredInfo.weight}</span></div>
                  )}
                </div>
              </>
            )
          ) : (
            <div style={{ color: '#9ca3af' }}>Not yet designed</div>
          )}
          {(colorMode === 'flexSteel' || colorMode === 'stirrups' || colorMode === 'weight') && hovered?.memberId && metricById[hovered.memberId] !== undefined && (
            <div style={{ marginTop: 4, fontSize: 10 }}>
              <span style={{ color: '#374151' }}>{metricLabel ?? 'Metric'}: </span>
              <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{metricById[hovered.memberId].toFixed(3)}</span>
            </div>
          )}
          <div style={{ color: '#9ca3af', marginTop: 4, fontSize: 10 }}>click=select · dbl=open · shift+click=add</div>
        </div>
      )}

      {/* DCR legend when in DCR mode */}
      {colorMode === 'dcr' && (
        <div style={{ position: 'absolute', bottom: 8, left: 8, display: 'flex', gap: 10, background: 'white', borderRadius: 6, padding: '4px 10px', border: '1px solid #e5e7eb', fontSize: 10, color: '#6b7280' }}>
          {[['<0.70','#16a34a'],['0.70–0.90','#84cc16'],['0.90–1.00','#f59e0b'],['≥1.00','#dc2626'],['Unlinked','#d1d5db']].map(([l, c]) => (
            <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ display: 'inline-block', width: 14, height: 3, background: c, borderRadius: 2 }} />
              {l}
            </span>
          ))}
        </div>
      )}

      {/* Metric ramp legend */}
      {(colorMode === 'flexSteel' || colorMode === 'stirrups' || colorMode === 'weight') && metricRange && (
        <div style={{ position: 'absolute', bottom: 8, left: 8, background: 'white', borderRadius: 6, padding: '6px 10px', border: '1px solid #e5e7eb', fontSize: 10, color: '#6b7280', minWidth: 140 }}>
          <div style={{ marginBottom: 4, fontWeight: 600 }}>{metricLabel ?? ''}</div>
          <div style={{ position: 'relative', height: 10, borderRadius: 4, overflow: 'hidden', background: `linear-gradient(to right, ${rampStops(metricRange.min, metricRange.max).map(s => s.color).join(',')})` }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
            <span>{metricRange.min.toFixed(2)}</span>
            <span>{((metricRange.min + metricRange.max) / 2).toFixed(2)}</span>
            <span>{metricRange.max.toFixed(2)}</span>
          </div>
        </div>
      )}

      {/* Diagram legend */}
      {diagramMode !== 'off' && (
        <div style={{ position: 'absolute', bottom: 8, right: 8, background: 'white', borderRadius: 6, padding: '4px 10px', border: '1px solid #e5e7eb', fontSize: 10, color: diagramMode === 'moment' ? '#7c3aed' : '#0891b2' }}>
          {diagramMode === 'moment' ? '▮ Moment envelope (max |M|)' : '▮ Shear envelope (max |V|)'}
        </div>
      )}
    </div>
  );
}
