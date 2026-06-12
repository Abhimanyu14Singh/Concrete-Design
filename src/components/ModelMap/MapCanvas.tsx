/**
 * MapCanvas — generalized plan-view SVG canvas for model frames.
 * Supports coloring by DCR, group, or section; lasso multi-select; zoom/pan.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import type { MapFrame, DesignGroup } from '../../types';
import { dcrToColor } from '../EtabsImport/dcrColors';

export type ColorMode = 'dcr' | 'group' | 'section';

const GROUP_PALETTE = [
  '#2563eb','#16a34a','#d97706','#9333ea','#0891b2',
  '#dc2626','#65a30d','#7c3aed','#0284c7','#be185d',
];

interface Props {
  frames: MapFrame[];
  /** DCR value keyed by memberId (undefined for unlinked frames) */
  dcrById?: Record<string, number>;
  designGroups?: DesignGroup[];
  story?: string; // 'All' or a specific story
  colorMode?: ColorMode;
  selected: Set<string>;            // frameName keys
  onSelectionChange: (names: Set<string>) => void;
  onDoubleClick?: (frameName: string) => void;
  width?: number;
  height?: number;
}

export default function MapCanvas({
  frames, dcrById = {}, designGroups = [], story = 'All',
  colorMode = 'dcr', selected, onSelectionChange, onDoubleClick,
  width = 640, height = 480,
}: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: width, h: height });
  const [lasso, setLasso] = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ mx: number; my: number; vx: number; vy: number } | null>(null);
  // Track whether the lasso started on a frame element (not the background).
  // If it did, background-click logic (clear selection) should be suppressed.
  const lassoBgOnly = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const visibleFrames = story === 'All' ? frames : frames.filter(f => f.story === story);

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

  // Reset viewBox when frames change
  useEffect(() => {
    setViewBox({ x: 0, y: 0, w: width, h: height });
  }, [frames, width, height]);

  const tx = (x: number) => pad + (x - minX) * scale;
  const ty = (y: number) => height - pad - (y - minY) * scale;

  // Group color lookup
  const groupColorMap = new Map<string, string>();
  designGroups.forEach((g, i) => {
    const color = g.color ?? GROUP_PALETTE[i % GROUP_PALETTE.length];
    g.memberIds.forEach(mid => groupColorMap.set(mid, color));
  });

  function frameColor(f: MapFrame): string {
    if (colorMode === 'group') {
      if (f.memberId) {
        const c = groupColorMap.get(f.memberId);
        if (c) return c;
      }
      return '#9ca3af';
    }
    if (colorMode === 'section') {
      // Simple hash of section name → color
      let h = 0;
      for (const ch of f.sectionName) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
      return `hsl(${(h * 137) % 360},60%,45%)`;
    }
    // DCR mode
    if (f.memberId) {
      const dcr = dcrById[f.memberId] ?? 0;
      return dcrToColor(dcr);
    }
    return '#d1d5db'; // unlinked = light grey
  }

  /**
   * Map a mouse event to base SVG user space. Uses the SVG's *rendered*
   * size (rect.width/height), not the attribute size, so the math stays
   * correct under the app's display-scale transform.
   */
  const mouseToSvg = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    return {
      x: viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.w,
      y: viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.h,
    };
  }, [viewBox]);

  // Wheel zoom — native non-passive listener so preventDefault actually
  // stops the page from scrolling (React attaches wheel passively).
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

  // Pan
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
      // True when the press starts on background (rect, svg root, grid pattern),
      // not on a frame <g> element. Frame clicks are handled by onClick on the <g>.
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
        // bare click on canvas background (not on a frame) → clear selection
        onSelectionChange(new Set());
      }
      setLasso(null);
    }
  }

  // End pan/lasso even if the mouse is released outside the SVG, and clear
  // selection on Escape without requiring the canvas to have focus.
  useEffect(() => {
    const onWinMouseUp = () => {
      if (isPanning) { setIsPanning(false); panStart.current = null; }
      // an in-progress lasso released off-canvas is just cancelled
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

  return (
    <div style={{ position: 'relative', userSelect: 'none' }}>
      <svg
        ref={svgRef}
        width={width} height={height}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        style={{ background: '#f8fafc', borderRadius: 10, border: '1px solid #e5e7eb', cursor: isPanning ? 'grabbing' : lasso ? 'crosshair' : 'default', display: 'block' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      >
        <defs>
          <pattern id="mmgrid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#eef2f7" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={width} height={height} fill="url(#mmgrid)" rx="10" />

        {visibleFrames.map(f => {
          const isSel = selected.has(f.frameName);
          const isHov = hover === f.frameName;
          const x1 = tx(f.pt1.x), y1 = ty(f.pt1.y);
          const x2 = tx(f.pt2.x), y2 = ty(f.pt2.y);
          const color = frameColor(f);
          const linked = !!f.memberId;
          return (
            <g key={f.frameName}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHover(f.frameName)}
              onMouseLeave={() => setHover(h => h === f.frameName ? null : h)}
              onClick={e => {
                e.stopPropagation();
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

      {/* Hover tooltip */}
      {hovered && (
        <div style={{
          position: 'absolute', top: 8, right: 8, background: 'white',
          border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px',
          fontSize: 11, color: '#374151', boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          pointerEvents: 'none', maxWidth: 220,
        }}>
          <div style={{ fontWeight: 700, color: '#111827' }}>{hovered.frameName}</div>
          <div>{hovered.story} · {hovered.sectionName}</div>
          {hovered.memberId && dcrById[hovered.memberId] !== undefined && (
            <div>DCR = <span style={{ fontFamily: 'monospace', fontWeight: 700, color: dcrToColor(dcrById[hovered.memberId]!) }}>
              {dcrById[hovered.memberId]!.toFixed(3)}
            </span></div>
          )}
          {!hovered.memberId && <div style={{ color: '#9ca3af' }}>Not yet designed</div>}
          <div style={{ color: '#9ca3af', marginTop: 2 }}>click=select · dbl=open · shift+click=add</div>
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
    </div>
  );
}
