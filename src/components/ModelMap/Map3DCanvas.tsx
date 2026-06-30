/**
 * Map3DCanvas — a lightweight, dependency-free rotatable 3D view of the model.
 *
 * It reuses the ETABS node coordinates already on every frame (pt1/pt2 are real
 * model points in ft, including elevation z) and projects them with a plain
 * orthographic camera: spin about the vertical axis (yaw) + tilt (pitch). Drag to
 * orbit, wheel to zoom. Members are drawn as lines colored exactly like the 2D
 * plan canvas (DCR / group / section / metric / auto-group, via the shared
 * frameColorFor), and faint translucent quads mark each story's floor elevation so
 * columns read as the vertical members connecting them.
 *
 * No WebGL / three.js — just SVG, so it shares the canvas, the color logic, and
 * the look-and-feel of MapCanvas with zero new dependencies.
 */
import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import type { MapFrame, DesignGroup, AutoGroupBin, Point3D } from '../../types';
import { dcrToColor } from '../EtabsImport/dcrColors';
import { frameColorFor, buildGroupColorMap, buildAutoGroupColorMap, type ColorMode } from './frameColor';
import type { FrameInfo } from './MapCanvas';

interface Props {
  frames: MapFrame[];
  dcrById?: Record<string, number>;
  infoById?: Record<string, FrameInfo>;
  designGroups?: DesignGroup[];
  story?: string;
  colorMode?: ColorMode;
  onDoubleClick?: (memberId: string) => void;
  width?: number;
  height?: number;
  metricById?: Record<string, number>;
  metricRange?: { min: number; max: number };
  autoGroupOverlay?: AutoGroupBin[];
  hiddenMemberIds?: Set<string>;
  hiddenStories?: Set<string>;
  showErrors?: boolean;
  errorMemberIds?: Set<string>;
}

const DEG = Math.PI / 180;
const PAD = 48;
const PITCH_MIN = 6 * DEG;
const PITCH_MAX = 88 * DEG;

interface View { yaw: number; pitch: number; zoom: number }
const DEFAULT_VIEW: View = { yaw: 28 * DEG, pitch: 32 * DEG, zoom: 1 };
const PRESETS: Record<string, View> = {
  Iso: DEFAULT_VIEW,
  Top: { yaw: 0, pitch: PITCH_MAX, zoom: 1 },
  Front: { yaw: 0, pitch: PITCH_MIN, zoom: 1 },
  Side: { yaw: 90 * DEG, pitch: PITCH_MIN, zoom: 1 },
};

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export default function Map3DCanvas({
  frames, dcrById = {}, infoById = {}, designGroups = [], story = 'All',
  colorMode = 'dcr', onDoubleClick, width = 640, height = 480,
  metricById = {}, metricRange, autoGroupOverlay = [],
  hiddenMemberIds = new Set(), hiddenStories = new Set(),
  showErrors = false, errorMemberIds = new Set(),
}: Props) {
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const visibleFrames = useMemo(() => frames.filter(f =>
    (story === 'All' || f.story === story) &&
    !hiddenStories.has(f.story) &&
    !(f.memberId && hiddenMemberIds.has(f.memberId))
  ), [frames, story, hiddenStories, hiddenMemberIds]);

  // Model centre (for centring the orbit) and plan X-Y extent (for story quads).
  const { center, planBox } = useMemo(() => {
    if (!visibleFrames.length) return { center: { x: 0, y: 0, z: 0 }, planBox: { minX: 0, maxX: 1, minY: 0, maxY: 1 } };
    // Reduce (not Math.min(...spread)) so very large models can't overflow the stack.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const see = (p: Point3D) => {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    };
    for (const f of visibleFrames) { see(f.pt1); see(f.pt2); }
    return {
      center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
      planBox: { minX, maxX, minY, maxY },
    };
  }, [visibleFrames]);

  // Per-story floor elevation, from (near-)horizontal frames only so columns
  // (which span two levels) don't skew the plane height.
  const storyPlanes = useMemo(() => {
    const byStory = new Map<string, number[]>();
    for (const f of visibleFrames) {
      if (Math.abs(f.pt1.z - f.pt2.z) > 0.5) continue; // skip non-horizontal (columns/braces)
      const z = (f.pt1.z + f.pt2.z) / 2;
      const arr = byStory.get(f.story);
      if (arr) arr.push(z); else byStory.set(f.story, [z]);
    }
    return [...byStory.entries()].map(([s, zs]) => ({ story: s, z: median(zs) }));
  }, [visibleFrames]);

  // Orthographic projection: centre → yaw about vertical → pitch tilt → drop depth.
  const project = useCallback((p: Point3D) => {
    const x = p.x - center.x, y = p.y - center.y, z = p.z - center.z;
    const cyaw = Math.cos(view.yaw), syaw = Math.sin(view.yaw);
    const rx = x * cyaw - y * syaw;
    const ry = x * syaw + y * cyaw;
    const cpit = Math.cos(view.pitch), spit = Math.sin(view.pitch);
    return {
      px: rx,
      py: -(ry * spit + z * cpit), // world "up" → screen up (SVG y grows downward)
      depth: ry * cpit - z * spit, // along view axis — for painter ordering
    };
  }, [center, view.yaw, view.pitch]);

  // Project everything once — independent of zoom — and keep the fit bounds + base
  // scale. Orbit changes `project` (re-projects); zoom does NOT, so it stays out of
  // these deps and the heavy per-frame projection / Math.min spreads don't re-run on scroll.
  const projected = useMemo(() => {
    const projFrames = visibleFrames.map(f => {
      const a = project(f.pt1), b = project(f.pt2);
      return { f, a, b, depth: (a.depth + b.depth) / 2 };
    });
    const planes = storyPlanes.map(pl => {
      const c = [
        project({ x: planBox.minX, y: planBox.minY, z: pl.z }),
        project({ x: planBox.maxX, y: planBox.minY, z: pl.z }),
        project({ x: planBox.maxX, y: planBox.maxY, z: pl.z }),
        project({ x: planBox.minX, y: planBox.maxY, z: pl.z }),
      ];
      return { story: pl.story, corners: c, depth: c.reduce((s, p) => s + p.depth, 0) / 4 };
    });
    // Reduce (not spread) so very large models don't overflow the call stack.
    let minPx = Infinity, maxPx = -Infinity, minPy = Infinity, maxPy = -Infinity;
    const see = (px: number, py: number) => {
      if (px < minPx) minPx = px; if (px > maxPx) maxPx = px;
      if (py < minPy) minPy = py; if (py > maxPy) maxPy = py;
    };
    for (const p of projFrames) { see(p.a.px, p.a.py); see(p.b.px, p.b.py); }
    for (const pl of planes) for (const c of pl.corners) see(c.px, c.py);
    if (!Number.isFinite(minPx)) { minPx = 0; maxPx = 1; minPy = 0; maxPy = 1; }
    const base = Math.min((width - 2 * PAD) / Math.max(maxPx - minPx, 1e-6), (height - 2 * PAD) / Math.max(maxPy - minPy, 1e-6));
    return { projFrames, planes, minPx, maxPx, minPy, maxPy, base };
  }, [visibleFrames, storyPlanes, planBox, project, width, height]);

  // Zoom-only transform (O(1)): scale the already-projected bounds and centre.
  const { sx, sy } = useMemo(() => {
    const scale = projected.base * view.zoom;
    const offX = width / 2 - ((projected.minPx + projected.maxPx) / 2) * scale;
    const offY = height / 2 - ((projected.minPy + projected.maxPy) / 2) * scale;
    return { sx: (px: number) => px * scale + offX, sy: (py: number) => py * scale + offY };
  }, [projected, view.zoom, width, height]);

  const groupColorMap = useMemo(() => buildGroupColorMap(designGroups), [designGroups]);
  const autoGroupColorMap = useMemo(() => buildAutoGroupColorMap(autoGroupOverlay), [autoGroupOverlay]);
  const colorOf = (f: MapFrame) =>
    frameColorFor(f, { colorMode, dcrById, groupColorMap, autoGroupColorMap, metricById, metricRange });

  // Wheel zoom — native non-passive so we can preventDefault.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      setView(v => ({ ...v, zoom: Math.min(8, Math.max(0.2, v.zoom * factor)) }));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  // Orbit drag (window listeners so a fast drag that leaves the SVG still tracks).
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!drag.current) return;
      const dx = e.clientX - drag.current.x;
      const dy = e.clientY - drag.current.y;
      setView(v => ({
        ...v,
        yaw: drag.current!.yaw + dx * 0.01,
        pitch: Math.min(PITCH_MAX, Math.max(PITCH_MIN, drag.current!.pitch + dy * 0.01)),
      }));
    };
    const onUp = () => { drag.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // Named handler (not an inline arrow) so the ref write is recognised as an
  // event handler, matching MapCanvas's pattern.
  function startOrbit(e: React.MouseEvent) {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch };
  }

  const hoveredInfo = hover ? (() => {
    const f = visibleFrames.find(x => x.frameName === hover);
    return f?.memberId ? infoById[f.memberId] : null;
  })() : null;
  const hoveredFrame = hover ? visibleFrames.find(x => x.frameName === hover) : null;

  // Far-to-near so nearer members overlay; planes always behind the members.
  // Memoised on the projection so hover/zoom re-renders don't re-sort.
  const sortedFrames = useMemo(() => [...projected.projFrames].sort((p, q) => q.depth - p.depth), [projected.projFrames]);
  const sortedPlanes = useMemo(() => [...projected.planes].sort((p, q) => q.depth - p.depth), [projected.planes]);

  return (
    <div style={{ position: 'relative', userSelect: 'none' }}>
      <svg
        ref={svgRef}
        width={width} height={height}
        style={{ background: '#0b1220', borderRadius: 10, border: '1px solid #1f2937', display: 'block', cursor: 'grab' }}
        onMouseDown={startOrbit}
      >
        {/* Story floor planes (drawn first → behind the members) */}
        {sortedPlanes.map(pl => (
          <polygon
            key={`plane-${pl.story}`}
            points={pl.corners.map(c => `${sx(c.px)},${sy(c.py)}`).join(' ')}
            fill="rgba(56,189,248,0.06)" stroke="rgba(56,189,248,0.22)" strokeWidth={1}
            style={{ pointerEvents: 'none' }}
          />
        ))}

        {/* Members */}
        {sortedFrames.map(({ f, a, b }) => {
          const x1 = sx(a.px), y1 = sy(a.py), x2 = sx(b.px), y2 = sy(b.py);
          const isHov = hover === f.frameName;
          const linked = !!f.memberId;
          const color = colorOf(f);
          const flagged = showErrors && !!f.memberId && errorMemberIds.has(f.memberId);
          return (
            <g key={f.frameName}
              style={{ cursor: linked ? 'pointer' : 'default' }}
              onMouseEnter={() => setHover(f.frameName)}
              onMouseLeave={() => setHover(h => h === f.frameName ? null : h)}
              onDoubleClick={() => f.memberId && onDoubleClick?.(f.memberId)}
            >
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} />
              {flagged && <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#dc2626" strokeWidth={isHov ? 9 : 7} opacity={0.4} strokeLinecap="round" />}
              <line
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={color}
                strokeWidth={isHov ? 5 : 3}
                strokeLinecap="round"
                strokeDasharray={linked ? undefined : '5 4'}
                opacity={linked ? 1 : 0.55}
              />
            </g>
          );
        })}
      </svg>

      {/* View presets + reset */}
      <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 4 }}>
        {Object.keys(PRESETS).map(name => (
          <button key={name} onClick={() => setView(PRESETS[name])}
            style={presetBtn} title={`${name} view`}>{name}</button>
        ))}
      </div>

      {/* Orbit hint */}
      <div style={{ position: 'absolute', bottom: 8, left: 8, fontSize: 10, color: '#64748b', background: 'rgba(15,23,42,0.7)', borderRadius: 6, padding: '3px 8px' }}>
        drag = orbit · wheel = zoom · dbl-click = open
      </div>

      {/* Hover tooltip */}
      {hoveredFrame && (
        <div style={{
          position: 'absolute', top: 8, right: 8, background: '#111827',
          border: '1px solid #1f2937', borderRadius: 8, padding: '8px 12px',
          fontSize: 11, color: '#e5e7eb', boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          pointerEvents: 'none', maxWidth: 260,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>{hoveredFrame.frameName}</div>
          <div style={{ color: '#94a3b8', marginBottom: hoveredInfo ? 4 : 0 }}>{hoveredFrame.story} · {hoveredFrame.sectionName}</div>
          {hoveredInfo && !hoveredInfo.error && (
            <div style={{ display: 'flex', gap: 8 }}>
              <span>Flex <span style={{ fontFamily: 'monospace', fontWeight: 700, color: dcrToColor(hoveredInfo.dcrFlex) }}>{hoveredInfo.dcrFlex.toFixed(2)}</span></span>
              <span>Shear <span style={{ fontFamily: 'monospace', fontWeight: 700, color: dcrToColor(hoveredInfo.dcrShear) }}>{hoveredInfo.dcrShear.toFixed(2)}</span></span>
            </div>
          )}
        </div>
      )}

      {visibleFrames.length === 0 && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: 13, pointerEvents: 'none' }}>
          No frames to show in 3D (check story / visibility filters).
        </div>
      )}
    </div>
  );
}

const presetBtn: React.CSSProperties = {
  background: '#1e293b', border: '1px solid #334155', borderRadius: 6,
  padding: '4px 8px', fontSize: 11, cursor: 'pointer', color: '#cbd5e1', fontWeight: 600,
};
