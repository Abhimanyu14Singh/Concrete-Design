/**
 * BeamInspectCard — floating card shown on beam click in inspect mode.
 * Single combined view: section sketch + rebar callouts, M/V envelope
 * sparklines, a zoned (End-L / Mid / End-R) DCR table, and a whole-member
 * envelope DCR summary.
 */
import { useMemo } from 'react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import type { Member, DesignResults, ComboForces, LoadCase, DesignCode } from '../../types';
import { getBarDiam } from '../../utils/concreteDesign';
import { formatBarLabel } from '../../utils/rebar';
import { steelWeightPerFt } from '../../utils/autoGroup';
import { runDesign } from '../../engines';
import { useUnits } from '../../contexts/UnitsContext';

interface Props {
  member: Member;
  designResults?: DesignResults;
  code: DesignCode;
  clientX: number;
  clientY: number;
  containerWidth: number;
  containerHeight: number;
  onClose: () => void;
}

const CARD_W = 340;

const dcrColor = (v?: number | null) =>
  v == null ? '#9ca3af' : v >= 1 ? '#dc2626' : v >= 0.9 ? '#d97706' : '#16a34a';

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

/** Build "2-#8 + 3-#6" style rebar string from layers. */
function rebarStr(bars: { numBars: number; barSize: number }[] | undefined): string {
  if (!bars || !bars.length) return '—';
  return bars.map(b => `${b.numBars}-${formatBarLabel(b.barSize)}`).join(' + ');
}

/** Build stirrup string: "#4 @ 6 in" or "#4 @ 9/12/9 in". */
function stirrupStr(
  rebar: Member['rebar'],
  fmtLen: (v: number) => string,
  lenLabel: string,
): string {
  const t = rebar.ties;
  if (!t) return '—';
  const bar = formatBarLabel(t.barSize);
  if (rebar.tieZones) {
    return `${bar} @ ${rebar.tieZones.map(z => fmtLen(z.spacing)).join('/')} ${lenLabel}`;
  }
  return `${bar} @ ${fmtLen(t.spacing)} ${lenLabel}`;
}

interface ZoneDCR {
  label: string;
  pos?: number;
  neg?: number;
  shear?: number;
}

function SectionSketch({ member }: { member: Member }) {
  const { fmtVal, label } = useUnits();
  const W = 150, H = 130;
  const sec = member.section;
  const b = (sec.type === 'T_beam' || sec.type === 'L_beam') ? (sec.bw ?? sec.b) : sec.b;
  const h = sec.h;
  const scale = Math.min((W - 20) / b, (H - 24) / h);
  const bPx = b * scale, hPx = h * scale;
  const ox = (W - bPx) / 2, oy = (H - hPx - 12) / 2;
  const cover = sec.coverClear ?? 1.5;
  const stirDia = (sec.stirrupDia ?? 3) / 8;
  const coverPx = (cover + stirDia) * scale;

  const topBars = member.rebar.topBars;
  const botBars = member.rebar.botBars;
  const sideBars = member.rebar.sideBars ?? [];
  const totalTop = topBars.reduce((s, b) => s + b.numBars, 0);
  const totalBot = botBars.reduce((s, b) => s + b.numBars, 0);
  const totalSide = sideBars.reduce((s, b) => s + b.numBars, 0);
  const barDTop = (getBarDiam(topBars[0]?.barSize ?? 8) / 8) * scale;
  const barDBot = (getBarDiam(botBars[0]?.barSize ?? 8) / 8) * scale;
  const barDSide = (getBarDiam(sideBars[0]?.barSize ?? 6) / 8) * scale;

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

  // Side/skin bars: split across the two vertical faces at mid-height region.
  function sideDots() {
    if (!totalSide) return null;
    const perFace = Math.ceil(totalSide / 2);
    const yTop = oy + coverPx;
    const yBot = oy + hPx - coverPx;
    const span = yBot - yTop;
    const place = (n: number, faceX: number) =>
      Array.from({ length: n }, (_, i) => {
        const t = n === 1 ? 0.5 : (i + 1) / (n + 1);
        return <circle key={`${faceX}-${i}`} cx={faceX} cy={yTop + t * span} r={barDSide / 2} fill="#374151" />;
      });
    const nLeft = Math.ceil(totalSide / 2);
    const nRight = totalSide - nLeft;
    return (
      <>
        {place(nLeft, ox + coverPx)}
        {place(nRight, ox + bPx - coverPx)}
      </>
    );
  }

  return (
    <svg width={W} height={H} style={{ display: 'block' }}>
      <rect x={ox} y={oy} width={bPx} height={hPx} fill="#f1f5f9" stroke="#374151" strokeWidth={1} />
      <rect x={ox + coverPx * 0.6} y={oy + coverPx * 0.6}
        width={bPx - coverPx * 1.2} height={hPx - coverPx * 1.2}
        fill="none" stroke="#6b7280" strokeWidth={0.8} />
      {barDots(totalTop, barDTop, oy + coverPx)}
      {barDots(totalBot, barDBot, oy + hPx - coverPx)}
      {sideDots()}
      <text x={W / 2} y={H - 2} textAnchor="middle" fontSize={9} fill="#9ca3af">{fmtVal(b, 'length')}×{fmtVal(h, 'length')} {label('length')}</text>
    </svg>
  );
}

function Sparkline({ data, color }: { data: { x: number; v: number }[]; color: string }) {
  if (!data.length) return <div style={{ width: 140, height: 34, background: '#f3f4f6', borderRadius: 4 }} />;
  return (
    <ResponsiveContainer width={140} height={34}>
      <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <Line type="monotone" dataKey="v" stroke={color} dot={false} strokeWidth={1.5} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function DcrCell({ v }: { v?: number }) {
  return (
    <div style={{ fontFamily: 'monospace', fontWeight: 700, color: dcrColor(v), textAlign: 'center' }}>
      {v == null ? '—' : v.toFixed(2)}
    </div>
  );
}

export default function BeamInspectCard({ member, designResults, code, clientX, clientY, containerWidth, containerHeight, onClose }: Props) {
  const { fmtVal, label } = useUnits();
  const mData = useMemo(() => stationEnvelope(member.stationForces ?? [], 'M'), [member.stationForces]);
  const vData = useMemo(() => stationEnvelope(member.stationForces ?? [], 'V'), [member.stationForces]);

  // Zoned (thirds) DCR table — recomputed only when member/rebar/code change.
  const zones = useMemo<ZoneDCR[]>(() => {
    const sf = member.stationForces ?? [];
    const allStations = sf.flatMap(cf => cf.stations);
    if (!allStations.length) {
      // Fallback: single full-member column from designResults.
      return [{
        label: 'Member',
        pos: designResults?.DCR_flex_pos,
        neg: designResults?.DCR_flex_neg,
        shear: designResults?.DCR_shear,
      }];
    }
    const xmin = Math.min(...allStations.map(s => s.x));
    const xmax = Math.max(...allStations.map(s => s.x));
    const third = (xmax - xmin) / 3;
    const labels = ['End L', 'Mid', 'End R'];
    return labels.map((label, zi) => {
      const lo = xmin + zi * third;
      const hi = zi === 2 ? xmax + 1e-9 : xmin + (zi + 1) * third;
      let MuPos = 0, MuNeg = 0, Vu = 0;
      for (const s of allStations) {
        if (s.x < lo || s.x > hi) continue;
        MuPos = Math.max(MuPos, s.M);
        MuNeg = Math.max(MuNeg, -s.M);
        Vu = Math.max(Vu, Math.abs(s.V));
      }
      MuPos = Math.max(0, MuPos);
      MuNeg = Math.max(0, MuNeg);
      const lc: LoadCase = {
        id: `zone-${zi}`, label, Mu_pos: MuPos, Mu_neg: MuNeg, Vu, Tu: 0, Pu: 0,
      };
      try {
        const r = runDesign(member.section, member.material, member.rebar, lc, member.span, code, member.crackParams);
        return { label, pos: r.DCR_flex_pos, neg: r.DCR_flex_neg, shear: r.DCR_shear };
      } catch {
        return { label };
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member.id, member.rebar, code]);

  // Dynamic height estimate for clamping (card grows downward).
  const CARD_H = 430;
  const left = Math.max(8, Math.min(clientX + 12, containerWidth - CARD_W - 8));
  const top = Math.max(8, Math.min(clientY - 20, containerHeight - CARD_H - 8));

  const weight = useMemo(() => steelWeightPerFt(member), [member]);

  const callouts: [string, string][] = [
    ['Top', rebarStr(member.rebar.topBars)],
    ['Bot', rebarStr(member.rebar.botBars)],
    ['Side', rebarStr(member.rebar.sideBars)],
    ['Stirrups', stirrupStr(member.rebar, v => fmtVal(v, 'length'), label('length'))],
    ['Steel', `${fmtVal(weight.totalLbFt, 'steelWeightPerLength')} ${label('steelWeightPerLength')} (L ${fmtVal(weight.longLbFt, 'steelWeightPerLength')} + S ${fmtVal(weight.stirrupLbFt, 'steelWeightPerLength')})`],
  ];

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

      {/* Section sketch + rebar callouts */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8 }}>
        <SectionSketch member={member} />
        <div style={{ flex: 1, fontSize: 10, lineHeight: 1.6 }}>
          {callouts.map(([k, v]) => (
            <div key={k}>
              <span style={{ color: '#9ca3af' }}>{k}: </span>
              <span style={{ color: '#111827', fontFamily: k === 'Steel' ? 'monospace' : undefined }}>{v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* M / V envelope sparklines */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 2 }}>M envelope</div>
          <Sparkline data={mData} color="#7c3aed" />
        </div>
        <div>
          <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 2 }}>V envelope</div>
          <Sparkline data={vData} color="#0891b2" />
        </div>
      </div>

      {/* Zone DCR table */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 3 }}>DCR by zone</div>
        <div style={{
          display: 'grid', gridTemplateColumns: `46px repeat(${zones.length}, 1fr)`,
          gap: 2, background: '#f8fafc', borderRadius: 6, padding: '5px 8px', fontSize: 10,
        }}>
          <div />
          {zones.map(z => (
            <div key={z.label} style={{ color: '#6b7280', fontWeight: 600, textAlign: 'center' }}>{z.label}</div>
          ))}
          <div style={{ color: '#9ca3af' }}>Flex+</div>
          {zones.map(z => <DcrCell key={z.label} v={z.pos} />)}
          <div style={{ color: '#9ca3af' }}>Flex−</div>
          {zones.map(z => <DcrCell key={z.label} v={z.neg} />)}
          <div style={{ color: '#9ca3af' }}>Shear</div>
          {zones.map(z => <DcrCell key={z.label} v={z.shear} />)}
        </div>
      </div>

      {/* Whole-member envelope summary */}
      {designResults ? (
        <div style={{ display: 'flex', gap: 12, background: '#f1f5f9', borderRadius: 6, padding: '5px 8px', fontSize: 11 }}>
          <div style={{ color: '#9ca3af', fontSize: 9, alignSelf: 'center' }}>Envelope</div>
          <div>
            <div style={{ color: '#9ca3af', fontSize: 9 }}>Flex+</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700, color: dcrColor(designResults.DCR_flex_pos) }}>{designResults.DCR_flex_pos?.toFixed(2) ?? '—'}</div>
          </div>
          <div>
            <div style={{ color: '#9ca3af', fontSize: 9 }}>Flex−</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700, color: dcrColor(designResults.DCR_flex_neg) }}>{designResults.DCR_flex_neg?.toFixed(2) ?? '—'}</div>
          </div>
          <div>
            <div style={{ color: '#9ca3af', fontSize: 9 }}>Shear</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700, color: dcrColor(designResults.DCR_shear) }}>{designResults.DCR_shear?.toFixed(2) ?? '—'}</div>
          </div>
        </div>
      ) : (
        <div style={{ color: '#9ca3af', fontSize: 10 }}>No design results — run design first</div>
      )}
    </div>
  );
}
