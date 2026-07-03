/**
 * TakeoffPanel — read-only quantity takeoff for the whole model: gross concrete
 * volume, reinforcement weight, and (when a gross floor area is entered) per-GFA
 * intensities. Beams and columns both contribute.
 *
 * Imperial-native (yd³, tons) like the source tool, with SI display (m³, tonnes)
 * when the project is in SI. GFA is a local input — it is not persisted.
 */
import { useMemo, useState } from 'react';
import type { Member } from '../../types';
import { projectTakeoff } from '../../utils/takeoff';
import { useUnits } from '../../contexts/UnitsContext';
import { BORDER, INK, LABEL_STYLE, MONO_NUM } from '../../theme';

interface Props { members: Member[] }

// Unit conversions (imperial → SI).
const FT3_TO_M3 = 0.0283168;
const FT3_PER_YD3 = 27;
const LB_TO_KG = 0.453592;
const FT2_TO_M2 = 0.092903;

const cardStyle: React.CSSProperties = {
  background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 10, padding: '12px 14px', marginBottom: 10,
};
const headingStyle: React.CSSProperties = { ...LABEL_STYLE, marginBottom: 8 };
const num = (n: number, d = 1) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ flex: '1 1 90px', minWidth: 90 }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: INK.strong, ...MONO_NUM }}>{value}</div>
      <div style={{ fontSize: 10, color: INK.secondary }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: INK.muted }}>{sub}</div>}
    </div>
  );
}

export default function TakeoffPanel({ members }: Props) {
  const { units } = useUnits();
  const si = units === 'si';
  const [gfaStr, setGfaStr] = useState('');

  // GFA is entered in the active system (ft² imperial, m² SI); store as ft².
  const gfaFt2 = useMemo(() => {
    const v = parseFloat(gfaStr);
    if (!Number.isFinite(v) || v <= 0) return undefined;
    return si ? v / FT2_TO_M2 : v;
  }, [gfaStr, si]);

  const t = useMemo(() => projectTakeoff(members, gfaFt2), [members, gfaFt2]);

  const vol = (ft3: number) => si ? `${num(ft3 * FT3_TO_M3, 1)} m³` : `${num(ft3 / FT3_PER_YD3, 1)} yd³`;
  const wt = (lb: number) => si ? `${num(lb * LB_TO_KG, 0)} kg` : `${num(lb, 0)} lb`;
  const wtBig = (lb: number) => si ? `${num(lb * LB_TO_KG / 1000, 2)} t` : `${num(lb / 2000, 2)} ton`;
  const volUnit = si ? 'm³' : 'yd³';

  const rows: { key: 'beam' | 'column'; label: string }[] = [
    { key: 'beam', label: 'Beams' },
    { key: 'column', label: 'Columns' },
  ];

  return (
    <div style={{ padding: '12px 14px' }}>
      <div style={cardStyle}>
        <div style={headingStyle}>Model Quantities</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Stat label="Concrete" value={vol(t.concreteFt3)} />
          <Stat label="Reinforcement" value={wtBig(t.steelLb)} sub={wt(t.steelLb)} />
          <Stat
            label="Rebar intensity"
            value={si ? `${num(t.steelLbPerYd3 * LB_TO_KG / FT3_TO_M3 / FT3_PER_YD3, 0)} kg/m³` : `${num(t.steelLbPerYd3, 0)} lb/yd³`}
            sub={`per ${volUnit} concrete`}
          />
        </div>
        <div style={{ fontSize: 10, color: INK.muted, marginTop: 8 }}>
          Gross section × member length; no rebar-displacement deduction. {members.length} member{members.length !== 1 ? 's' : ''}.
        </div>
      </div>

      <div style={cardStyle}>
        <div style={headingStyle}>By Member Type</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ color: INK.muted, textAlign: 'right' }}>
              <th style={{ textAlign: 'left', fontWeight: 600, padding: '2px 4px' }}>Type</th>
              <th style={{ fontWeight: 600, padding: '2px 4px' }}>#</th>
              <th style={{ fontWeight: 600, padding: '2px 4px' }}>Concrete ({volUnit})</th>
              <th style={{ fontWeight: 600, padding: '2px 4px' }}>Steel</th>
            </tr>
          </thead>
          <tbody style={{ ...MONO_NUM, color: INK.base }}>
            {rows.filter(r => t.byType[r.key].count > 0).map(r => {
              const b = t.byType[r.key];
              return (
                <tr key={r.key} style={{ borderTop: '1px solid #f3f4f6', textAlign: 'right' }}>
                  <td style={{ textAlign: 'left', padding: '3px 4px' }}>{r.label}</td>
                  <td style={{ padding: '3px 4px' }}>{b.count}</td>
                  <td style={{ padding: '3px 4px' }}>{si ? num(b.concreteFt3 * FT3_TO_M3, 1) : num(b.concreteFt3 / FT3_PER_YD3, 1)}</td>
                  <td style={{ padding: '3px 4px' }}>{wt(b.steelLb)}</td>
                </tr>
              );
            })}
            {members.length === 0 && (
              <tr><td colSpan={4} style={{ padding: '8px 4px', color: INK.muted, textAlign: 'center' }}>No members yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={cardStyle}>
        <div style={headingStyle}>Per Gross Floor Area</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <label style={{ fontSize: 11, color: INK.secondary }}>GFA</label>
          <input
            type="number" min={0} value={gfaStr} placeholder="0"
            onChange={e => setGfaStr(e.target.value)}
            style={{ flex: 1, minWidth: 0, padding: '4px 8px', border: `1px solid ${BORDER.strong}`, borderRadius: 6, fontSize: 12, ...MONO_NUM }}
          />
          <span style={{ fontSize: 11, color: INK.muted, width: 28 }}>{si ? 'm²' : 'ft²'}</span>
        </div>
        {t.gfaFt2 ? (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Stat
              label="Concrete / floor"
              value={si ? `${num((t.concreteFt3PerGfa ?? 0) * FT3_TO_M3 / FT2_TO_M2 * 1000, 0)} mm` : `${num((t.concreteFt3PerGfa ?? 0) * 12, 2)} in`}
              sub="avg thickness"
            />
            <Stat
              label="Steel / floor"
              value={si ? `${num((t.steelLbPerGfa ?? 0) * LB_TO_KG / FT2_TO_M2, 1)} kg/m²` : `${num(t.steelLbPerGfa ?? 0, 1)} psf`}
            />
          </div>
        ) : (
          <div style={{ fontSize: 10, color: INK.muted }}>Enter a gross floor area to see concrete and steel intensities.</div>
        )}
      </div>
    </div>
  );
}
