/**
 * PlanMap — 2D plan view of imported ETABS beams (x–y projection), each beam
 * a clickable line colored by its worst DCR. Supports multi-select for
 * design-group editing and a minimum-DCR display filter.
 */
import { useState } from 'react';
import type { Member } from '../../types';
import { dcrToColor } from './dcrColors';
import { useUnits } from '../../contexts/UnitsContext';
import { FONT, INK, MAP_DCR_BANDS } from '../../theme';

interface Props {
  members: Member[];                 // beams with etabs link
  dcrById: Record<string, number>;
  selected: Set<string>;
  onToggleSelect: (id: string, additive: boolean) => void;
  onPick: (id: string) => void;      // double-click → open in main app
  minDCR?: number;                   // hide beams below this DCR (0 = show all)
  width?: number;
  height?: number;
}

export default function PlanMap({
  members, dcrById, selected, onToggleSelect, onPick, minDCR = 0,
  width = 560, height = 420,
}: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const { fmt } = useUnits();

  const pts = members.flatMap(m => m.etabs ? [m.etabs.pt1, m.etabs.pt2] : []);
  if (!pts.length) return null;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 30;
  const scale = Math.min(
    (width - 2 * pad) / Math.max(maxX - minX, 1),
    (height - 2 * pad) / Math.max(maxY - minY, 1),
  );
  // SVG y grows downward; plan y grows up
  const tx = (x: number) => pad + (x - minX) * scale;
  const ty = (y: number) => height - pad - (y - minY) * scale;

  const hovered = members.find(m => m.id === hover);

  return (
    <div style={{ position: 'relative' }}>
      <svg width={width} height={height} style={{ background: '#f8fafc', borderRadius: 10, border: '1px solid #e5e7eb' }}>
        {/* grid */}
        <defs>
          <pattern id="plangrid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#eef2f7" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={width} height={height} fill="url(#plangrid)" rx="10" />

        {members.map(m => {
          if (!m.etabs) return null;
          const dcr = dcrById[m.id] ?? 0;
          if (dcr < minDCR) return null;
          const isSel = selected.has(m.id);
          const isHover = hover === m.id;
          const x1 = tx(m.etabs.pt1.x), y1 = ty(m.etabs.pt1.y);
          const x2 = tx(m.etabs.pt2.x), y2 = ty(m.etabs.pt2.y);
          return (
            <g key={m.id}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHover(m.id)}
              onMouseLeave={() => setHover(h => (h === m.id ? null : h))}
              onClick={e => onToggleSelect(m.id, e.shiftKey || e.ctrlKey || e.metaKey)}
              onDoubleClick={() => onPick(m.id)}
            >
              {/* fat invisible hit area */}
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} />
              {isSel && (
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#2563eb" strokeWidth={8} opacity={0.3} strokeLinecap="round" />
              )}
              <line x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={dcrToColor(dcr)}
                strokeWidth={isHover ? 5 : 3.5}
                strokeLinecap="round" />
            </g>
          );
        })}

        {/* legend — rendered from the shared bands (matches dcrToColor) */}
        {MAP_DCR_BANDS.map((b, i) => (
          <g key={b.label} transform={`translate(${10 + i * 92}, ${height - 16})`}>
            <line x1={0} y1={0} x2={18} y2={0} stroke={b.color} strokeWidth={4} strokeLinecap="round" />
            <text x={23} y={3} fontSize={9} fill={INK.secondary} fontFamily={FONT.mono}>DCR {b.label}</text>
          </g>
        ))}
      </svg>

      {hovered?.etabs && (
        <div style={{
          position: 'absolute', top: 8, right: 8, background: 'white',
          border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px',
          fontSize: 11, color: '#374151', boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          pointerEvents: 'none',
        }}>
          <div style={{ fontWeight: 700, color: '#111827' }}>{hovered.etabs.frameName}</div>
          <div>{hovered.etabs.story} · {hovered.etabs.sectionName} · L = {hovered.span != null ? fmt(hovered.span, 'spanLength') : '—'}</div>
          <div>
            DCR = <span style={{ fontFamily: 'monospace', fontWeight: 700, color: dcrToColor(dcrById[hovered.id] ?? 0) }}>
              {(dcrById[hovered.id] ?? 0).toFixed(3)}
            </span>
          </div>
          <div style={{ color: '#9ca3af', marginTop: 2 }}>click = select · double-click = open</div>
        </div>
      )}
    </div>
  );
}
