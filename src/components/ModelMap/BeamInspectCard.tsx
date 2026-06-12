/**
 * BeamInspectCard — floating card shown on beam click in inspect mode.
 * Shows a section sketch (SVG), V/M sparklines, and DCR values.
 */
import { useMemo } from 'react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import type { Member, DesignResults, ComboForces } from '../../types';
import { getBarDiam } from '../../utils/concreteDesign';

interface Props {
  member: Member;
  designResults?: DesignResults;
  clientX: number;
  clientY: number;
  containerWidth: number;
  containerHeight: number;
  onClose: () => void;
}

function stationEnvelope(stationForces: ComboForces[], type: 'M' | 'V') {
  const byX = new Map<number, number>();
  for (const cf of stationForces) {
    for (const s of cf.stations) {
      const val = Math.abs(type === 'M' ? s.M : s.V);
      byX.set(s.x, Math.max(byX.get(s.x) ?? 0, val));
    }
  }
  return [...byX.entries()].sort((a, b) => a[0] - b[0]).map(([x, v]) => ({ x, v }));
}

function SectionSketch({ member }: { member: Member }) {
  const W = 90, H = 70;
  const sec = member.section;
  const b = (sec.type === 'T_beam' || sec.type === 'L_beam') ? (sec.bw ?? sec.b) : sec.b;
  const h = sec.h;
  const scale = Math.min((W - 10) / b, (H - 10) / h);
  const bPx = b * scale, hPx = h * scale;
  const ox = (W - bPx) / 2, oy = (H - hPx) / 2;
  const cover = sec.coverClear ?? 1.5;
  const stirDia = (sec.stirrupDia ?? 3) / 8;
  const coverPx = (cover + stirDia) * scale;

  // Bar dots
  const topBars = member.rebar.topBars;
  const botBars = member.rebar.botBars;
  const totalTop = topBars.reduce((s, b) => s + b.numBars, 0);
  const totalBot = botBars.reduce((s, b) => s + b.numBars, 0);
  const barSizeTop = topBars[0]?.barSize ?? 8;
  const barSizeBot = botBars[0]?.barSize ?? 8;
  const barDTop = (getBarDiam(barSizeTop) / 8) * scale;
  const barDBot = (getBarDiam(barSizeBot) / 8) * scale;

  function barDots(count: number, barD: number, yCenter: number) {
    if (!count) return null;
    const spacingPx = (bPx - 2 * coverPx) / Math.max(count - 1, 1);
    return Array.from({ length: count }, (_, i) => (
      <circle key={i}
        cx={ox + coverPx + (count > 1 ? i * spacingPx : (bPx - 2 * coverPx) / 2)}
        cy={yCenter}
        r={barD / 2}
        fill="#374151"
      />
    ));
  }

  return (
    <svg width={W} height={H} style={{ display: 'block' }}>
      {/* Beam outline */}
      <rect x={ox} y={oy} width={bPx} height={hPx} fill="#f1f5f9" stroke="#374151" strokeWidth={1} />
      {/* Stirrup outline */}
      <rect x={ox + coverPx * 0.6} y={oy + coverPx * 0.6}
        width={bPx - coverPx * 1.2} height={hPx - coverPx * 1.2}
        fill="none" stroke="#6b7280" strokeWidth={0.8} />
      {/* Top bars */}
      {barDots(totalTop, barDTop, oy + coverPx)}
      {/* Bot bars */}
      {barDots(totalBot, barDBot, oy + hPx - coverPx)}
      {/* Dimension labels */}
      <text x={W / 2} y={H - 1} textAnchor="middle" fontSize={7} fill="#9ca3af">{b}″×{h}″</text>
    </svg>
  );
}

function Sparkline({ data, color }: { data: { x: number; v: number }[]; color: string }) {
  if (!data.length) return <div style={{ width: 100, height: 32, background: '#f3f4f6', borderRadius: 4 }} />;
  return (
    <ResponsiveContainer width={100} height={32}>
      <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <Line type="monotone" dataKey="v" stroke={color} dot={false} strokeWidth={1.5} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export default function BeamInspectCard({ member, designResults, clientX, clientY, containerWidth, containerHeight, onClose }: Props) {
  const CARD_W = 260, CARD_H = 195;
  const left = Math.min(clientX + 12, containerWidth - CARD_W - 8);
  const top = Math.min(clientY - 20, containerHeight - CARD_H - 8);

  const mData = useMemo(() => stationEnvelope(member.stationForces ?? [], 'M'), [member.stationForces]);
  const vData = useMemo(() => stationEnvelope(member.stationForces ?? [], 'V'), [member.stationForces]);

  const dcrPos = designResults?.DCR_flex_pos;
  const dcrNeg = designResults?.DCR_flex_neg;
  const dcrShear = designResults?.DCR_shear;

  const dcrColor = (v?: number) => !v ? '#9ca3af' : v >= 1 ? '#dc2626' : v >= 0.9 ? '#d97706' : '#16a34a';

  return (
    <div style={{
      position: 'absolute', left, top, width: CARD_W, zIndex: 200,
      background: 'white', border: '1px solid #e5e7eb', borderRadius: 10,
      boxShadow: '0 4px 20px rgba(0,0,0,0.12)', padding: '10px 12px',
      fontSize: 11, color: '#374151',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 12, color: '#111827' }}>{member.label || member.id}</div>
          <div style={{ color: '#9ca3af', fontSize: 10 }}>{member.etabs?.story ?? ''} · {member.etabs?.sectionName ?? member.section.type}</div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
      </div>

      {/* Section sketch + V/M sparklines */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8 }}>
        <SectionSketch member={member} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 2 }}>M envelope</div>
          <Sparkline data={mData} color="#7c3aed" />
          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4, marginBottom: 2 }}>V envelope</div>
          <Sparkline data={vData} color="#0891b2" />
        </div>
      </div>

      {/* DCR row */}
      {designResults ? (
        <div style={{ display: 'flex', gap: 12, background: '#f8fafc', borderRadius: 6, padding: '5px 8px', fontSize: 11 }}>
          <div>
            <div style={{ color: '#9ca3af', fontSize: 9 }}>Flex+</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700, color: dcrColor(dcrPos) }}>{dcrPos?.toFixed(2) ?? '—'}</div>
          </div>
          <div>
            <div style={{ color: '#9ca3af', fontSize: 9 }}>Flex−</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700, color: dcrColor(dcrNeg) }}>{dcrNeg?.toFixed(2) ?? '—'}</div>
          </div>
          <div>
            <div style={{ color: '#9ca3af', fontSize: 9 }}>Shear</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700, color: dcrColor(dcrShear) }}>{dcrShear?.toFixed(2) ?? '—'}</div>
          </div>
        </div>
      ) : (
        <div style={{ color: '#9ca3af', fontSize: 10 }}>No design results — run design first</div>
      )}
    </div>
  );
}
