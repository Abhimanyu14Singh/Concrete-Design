/**
 * DesignView — three-column layout
 *   Left  : Input (section, material, rebar, loads)
 *   Center: Section detailing drawing + elevation
 *   Right : Results (DCRs, code checks, calc breakdown)
 */
import { useState } from 'react';
import type { Member, SectionType, DesignCode } from '../types';
import { getBarArea, getBarDiam } from '../utils/concreteDesign';
import { runDesign } from '../engines';
import SectionView from './Detailing/SectionView';
import ElevationView from './Detailing/ElevationView';
import CalcBreakdownModal from './Results/CalcBreakdownModal';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Cell,
} from 'recharts';

interface Props {
  member: Member;
  code?: DesignCode;
  onUpdate: (m: Member) => void;
}

const BAR_SIZES = [3, 4, 5, 6, 7, 8, 9, 10, 11];
const SECTION_TYPES: { value: SectionType; label: string }[] = [
  { value: 'rectangular_beam', label: 'Rect. Beam' },
  { value: 'T_beam',           label: 'T-Beam'     },
  { value: 'L_beam',           label: 'L-Beam'     },
];

const FLD: React.CSSProperties = {
  background: '#0a1628', border: '1px solid #1e293b', borderRadius: 5,
  padding: '5px 8px', color: '#e2e8f0', fontSize: 11, width: '100%',
  outline: 'none', boxSizing: 'border-box',
};
const LBL: React.CSSProperties = { fontSize: 10, color: '#475569', marginBottom: 2, display: 'block' };

function Row({ label, children, unit }: { label: string; children: React.ReactNode; unit?: string }) {
  return (
    <div style={{ marginBottom: 7 }}>
      <label style={LBL}>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <div style={{ flex: 1 }}>{children}</div>
        {unit && <span style={{ fontSize: 10, color: '#334155', flexShrink: 0 }}>{unit}</span>}
      </div>
    </div>
  );
}

function Num({ value, onChange, min, step = 1 }: { value: number; onChange: (v: number) => void; min?: number; step?: number }) {
  return (
    <input type="number" value={value} min={min} step={step}
      onChange={e => onChange(+e.target.value)}
      style={{ ...FLD }} />
  );
}

function Sel({ value, options, onChange }: { value: string | number; options: { value: string | number; label: string }[]; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={{ ...FLD }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div style={{ fontSize: 9, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: 1, padding: '10px 0 4px', borderTop: '1px solid #1e293b', marginTop: 6 }}>
      {title}
    </div>
  );
}

function dcrColor(dcr: number) {
  return dcr > 1 ? '#ef4444' : dcr > 0.9 ? '#f59e0b' : '#10b981';
}

function DCRRow({ label, dcr, demand, capacity, unit = 'kip-ft' }: { label: string; dcr: number; demand?: number; capacity?: number; unit?: string }) {
  const color = dcrColor(dcr);
  const pct   = Math.min(dcr, 1.15) / 1.15 * 100;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600 }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color, fontFamily: 'monospace' }}>
          {dcr.toFixed(3)}
          <span style={{ fontSize: 9, marginLeft: 4, fontWeight: 400, color: dcr > 1 ? '#ef4444' : '#475569' }}>
            {dcr > 1 ? ' ✗' : ' ✓'}
          </span>
        </span>
      </div>
      <div style={{ height: 6, background: '#0f172a', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.3s' }} />
      </div>
      {(demand !== undefined || capacity !== undefined) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
          {demand   !== undefined && <span style={{ fontSize: 9, color: '#334155' }}>D: {demand.toFixed(1)} {unit}</span>}
          {capacity !== undefined && <span style={{ fontSize: 9, color: '#334155' }}>C: {capacity.toFixed(1)} {unit}</span>}
        </div>
      )}
    </div>
  );
}

export default function DesignView({ member, code = 'ACI318-19', onUpdate }: Props) {
  const [activeLoadId, setActiveLoadId] = useState(member.loads[0]?.id);
  const [showCalc, setShowCalc] = useState(false);

  const load = member.loads.find(l => l.id === activeLoadId) ?? member.loads[0];
  const result = runDesign(member.section, member.material, member.rebar, load, member.span, code);

  const upd  = (patch: Partial<Member>) => onUpdate({ ...member, ...patch });
  const updS = (patch: Partial<Member['section']>) => upd({ section: { ...member.section, ...patch } });
  const updM = (patch: Partial<Member['material']>) => upd({ material: { ...member.material, ...patch } });
  const updT = (patch: Partial<NonNullable<Member['rebar']['ties']>>) =>
    upd({ rebar: { ...member.rebar, ties: { ...(member.rebar.ties ?? { barSize: 4, spacing: 6, legs: 2 }), ...patch } } });
  function updTopBar(patch: Partial<Member['rebar']['topBars'][0]>) {
    onUpdate({ ...member, rebar: { ...member.rebar, topBars: [{ ...member.rebar.topBars[0], ...patch }] } });
  }
  function updBotBar(patch: Partial<Member['rebar']['botBars'][0]>) {
    onUpdate({ ...member, rebar: { ...member.rebar, botBars: [{ ...member.rebar.botBars[0], ...patch }] } });
  }

  const dcrs = [
    { name: 'Flex+',   dcr: result.DCR_flex_pos },
    { name: 'Flex–',   dcr: result.DCR_flex_neg },
    { name: 'Shear',   dcr: result.DCR_shear    },
    { name: 'Torsion', dcr: result.DCR_torsion  },
  ];

  const statusColor = result.status === 'OK' ? '#10b981' : result.status === 'NG' ? '#ef4444' : '#f59e0b';
  const statusBg    = result.status === 'OK' ? 'rgba(16,185,129,0.08)' : result.status === 'NG' ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)';

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', gap: 0 }}>

      {/* ══ LEFT — Input Panel ══════════════════════════════════════════════ */}
      <aside style={{
        width: 220, flexShrink: 0, overflowY: 'auto', padding: '12px 12px',
        background: '#0a1628', borderRight: '1px solid #1e293b',
      }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#3b82f6', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
          {member.id} — Input
        </div>

        <Row label="Label">
          <input value={member.label} onChange={e => upd({ label: e.target.value })} style={{ ...FLD }} />
        </Row>
        <Row label="Span" unit="ft">
          <Num value={member.span ?? 20} onChange={v => upd({ span: v })} min={1} />
        </Row>

        <SectionHeader title="Section" />
        <Row label="Type">
          <Sel value={member.section.type} options={SECTION_TYPES} onChange={v => updS({ type: v as SectionType })} />
        </Row>
        <Row label={member.section.type === 'T_beam' || member.section.type === 'L_beam' ? 'Flange width b' : 'Width b'} unit="in">
          <Num value={member.section.b} onChange={v => updS({ b: v })} min={4} />
        </Row>
        <Row label="Total depth h" unit="in">
          <Num value={member.section.h ?? 24} onChange={v => updS({ h: v })} min={4} />
        </Row>
        {(member.section.type === 'T_beam' || member.section.type === 'L_beam') && (
          <>
            <Row label="Web width bw" unit="in">
              <Num value={member.section.bw ?? 14} onChange={v => updS({ bw: v })} min={4} />
            </Row>
            <Row label="Flange depth hf" unit="in">
              <Num value={member.section.hf ?? 5} onChange={v => updS({ hf: v })} min={2} />
            </Row>
          </>
        )}
        <Row label="Clear cover cc" unit="in">
          <Num value={member.section.coverClear} step={0.25} onChange={v => updS({ coverClear: v })} min={0.75} />
        </Row>
        <Row label="Stirrup size">
          <Sel value={member.section.stirrupDia}
            options={[3,4,5].map(s => ({ value: s, label: `#${s} (Ø${getBarDiam(s)}")` }))}
            onChange={v => updS({ stirrupDia: +v })} />
        </Row>

        <SectionHeader title="Materials" />
        <Row label="f'c" unit="psi">
          <Num value={member.material.fc} step={500} onChange={v => updM({ fc: v })} min={2500} />
        </Row>
        <Row label="fy (long.)" unit="psi">
          <Num value={member.material.fy} step={5000} onChange={v => updM({ fy: v })} min={40000} />
        </Row>
        <Row label="fyt (trans.)" unit="psi">
          <Num value={member.material.fyt} step={5000} onChange={v => updM({ fyt: v })} min={40000} />
        </Row>
        <Row label="λ (weight factor)">
          <Sel value={member.material.lambdaConcrete}
            options={[{ value: 1.0, label: '1.0 — Normal weight' }, { value: 0.85, label: '0.85 — Sand-lightweight' }, { value: 0.75, label: '0.75 — All-lightweight' }]}
            onChange={v => updM({ lambdaConcrete: +v })} />
        </Row>

        <SectionHeader title="Longitudinal Steel" />
        <div style={{ fontSize: 10, color: '#475569', marginBottom: 4 }}>Top bars</div>
        <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={LBL}># bars</label>
            <Num value={member.rebar.topBars[0]?.numBars ?? 3} onChange={v => updTopBar({ numBars: Math.max(1, v) })} min={1} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={LBL}>Size</label>
            <Sel value={member.rebar.topBars[0]?.barSize ?? 8}
              options={BAR_SIZES.map(s => ({ value: s, label: `#${s}` }))}
              onChange={v => updTopBar({ barSize: +v })} />
          </div>
        </div>
        <div style={{ fontSize: 10, color: '#475569', marginBottom: 4 }}>Bottom bars</div>
        <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={LBL}># bars</label>
            <Num value={member.rebar.botBars[0]?.numBars ?? 4} onChange={v => updBotBar({ numBars: Math.max(1, v) })} min={1} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={LBL}>Size</label>
            <Sel value={member.rebar.botBars[0]?.barSize ?? 8}
              options={BAR_SIZES.map(s => ({ value: s, label: `#${s}` }))}
              onChange={v => updBotBar({ barSize: +v })} />
          </div>
        </div>

        <SectionHeader title="Transverse Steel" />
        <div style={{ display: 'flex', gap: 5, marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <label style={LBL}>Size</label>
            <Sel value={member.rebar.ties?.barSize ?? 4}
              options={[3,4,5].map(s => ({ value: s, label: `#${s}` }))}
              onChange={v => updT({ barSize: +v })} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={LBL}>Spacing</label>
            <Num value={member.rebar.ties?.spacing ?? 6} onChange={v => updT({ spacing: v })} min={1} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={LBL}>Legs</label>
            <Num value={member.rebar.ties?.legs ?? 2} onChange={v => updT({ legs: v })} min={2} />
          </div>
        </div>

        <SectionHeader title="Load Cases" />
        {member.loads.map((lc, idx) => (
          <div key={lc.id} style={{ background: '#0f172a', borderRadius: 6, padding: '8px 8px', marginBottom: 8, border: '1px solid #1e293b' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#3b82f6', marginBottom: 6 }}>{lc.label}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
              {[
                ['Mu+', 'Mu_pos', 'k-ft'], ['Mu–', 'Mu_neg', 'k-ft'],
                ['Vu', 'Vu', 'k'], ['Tu', 'Tu', 'k-ft'],
              ].map(([label, key, unit]) => (
                <div key={key}>
                  <label style={{ ...LBL }}>{label} <span style={{ color: '#1e293b' }}>{unit}</span></label>
                  <input type="number" value={(lc as unknown as Record<string, number>)[key] ?? 0}
                    onChange={e => {
                      const loads = [...member.loads];
                      loads[idx] = { ...lc, [key]: +e.target.value };
                      upd({ loads });
                    }}
                    style={{ ...FLD }} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </aside>

      {/* ══ CENTER — Section Drawing ════════════════════════════════════════ */}
      <div style={{
        width: 330, flexShrink: 0, background: '#040d1a', borderRight: '1px solid #1e293b',
        display: 'flex', flexDirection: 'column', overflowY: 'auto',
      }}>
        <div style={{ padding: '12px 12px 0' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
            Section Detailing
          </div>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <SectionView section={member.section} rebar={member.rebar} width={300} height={270} />
          </div>
        </div>

        {/* Steel area summary */}
        <div style={{ padding: '10px 12px', borderTop: '1px solid #0f172a', marginTop: 4 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {[
              ['As top', `${member.rebar.topBars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0).toFixed(2)} in²`],
              ['As bot', `${member.rebar.botBars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0).toFixed(2)} in²`],
              ['ρ top', (() => {
                const As = member.rebar.topBars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
                const bw = member.section.bw ?? member.section.b;
                const h  = member.section.h ?? 12;
                return `${(As / (bw * h) * 100).toFixed(3)}%`;
              })()],
              ['ρ bot', (() => {
                const As = member.rebar.botBars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
                const bw = member.section.bw ?? member.section.b;
                const h  = member.section.h ?? 12;
                return `${(As / (bw * h) * 100).toFixed(3)}%`;
              })()],
              ['d (bot)', (() => {
                const { coverClear, stirrupDia } = member.section;
                const dBar = getBarDiam(member.rebar.botBars[0]?.barSize ?? 8);
                const dStir = getBarDiam(stirrupDia);
                const h = member.section.h ?? 12;
                return `${(h - coverClear - dStir - dBar / 2).toFixed(2)}"`;
              })()],
              ["f'c / fy", `${member.material.fc / 1000}k / ${member.material.fy / 1000}k`],
            ].map(([k, v]) => (
              <div key={k} style={{ background: '#0a1628', borderRadius: 5, padding: '5px 8px' }}>
                <div style={{ fontSize: 9, color: '#334155', textTransform: 'uppercase', letterSpacing: 0.5 }}>{k}</div>
                <div style={{ fontSize: 11, color: '#e2e8f0', fontFamily: 'monospace', fontWeight: 600 }}>{v}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Elevation */}
        <div style={{ padding: '8px 12px', borderTop: '1px solid #0f172a' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
            Elevation
          </div>
          <ElevationView member={member} width={296} height={100} />
        </div>
      </div>

      {/* ══ RIGHT — Results Panel ═══════════════════════════════════════════ */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', minWidth: 0 }}>

        {/* Member header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#f1f5f9' }}>{member.label}</div>
            <div style={{ fontSize: 10, color: '#334155', marginTop: 2 }}>
              {member.section.type.replace(/_/g, ' ')} &bull;{' '}
              {`${member.section.b}"×${member.section.h}"`} &bull;{' '}
              f'c={member.material.fc}psi  fy={member.material.fy / 1000}ksi  span={member.span}ft
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ background: statusBg, border: `1px solid ${statusColor}`, borderRadius: 20, padding: '4px 12px', fontSize: 12, fontWeight: 700, color: statusColor }}>
              {result.status}
            </div>
            <button onClick={() => setShowCalc(true)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: 'rgba(109,40,217,0.12)', border: '1px solid rgba(109,40,217,0.3)',
                color: '#a78bfa', borderRadius: 8, padding: '5px 12px',
                fontSize: 11, fontWeight: 700, cursor: 'pointer',
              }}>
              <span style={{ fontSize: 13 }}>∑</span> Calculations
            </button>
          </div>
        </div>

        {/* Load case tabs */}
        <div style={{ display: 'flex', gap: 5, marginBottom: 12, flexWrap: 'wrap' }}>
          {member.loads.map(l => (
            <button key={l.id} onClick={() => setActiveLoadId(l.id)}
              style={{
                padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                border: 'none', cursor: 'pointer',
                background: activeLoadId === l.id ? '#1d4ed8' : '#0f172a',
                color: activeLoadId === l.id ? 'white' : '#475569',
                boxShadow: activeLoadId === l.id ? '0 0 0 1px #3b82f6' : '0 0 0 1px #1e293b',
              }}>
              {l.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

          {/* DCR bar chart */}
          <div style={{ background: '#0a1628', borderRadius: 10, border: '1px solid #1e293b', padding: '12px 14px', gridColumn: '1 / -1' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
              Demand / Capacity Ratios
            </div>
            <ResponsiveContainer width="100%" height={120}>
              <BarChart data={dcrs} layout="vertical" margin={{ left: 0, right: 36, top: 0, bottom: 0 }}>
                <CartesianGrid horizontal={false} stroke="#0f172a" />
                <XAxis type="number" domain={[0, Math.max(1.2, ...dcrs.map(d => d.dcr + 0.05))]}
                  tick={{ fill: '#334155', fontSize: 9 }} tickFormatter={v => v.toFixed(2)} />
                <YAxis dataKey="name" type="category" tick={{ fill: '#94a3b8', fontSize: 10 }} width={50} />
                <Tooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, fontSize: 11 }}
                  formatter={(v) => [Number(v).toFixed(3), 'DCR']}
                  labelStyle={{ color: '#94a3b8' }}
                />
                <ReferenceLine x={1.0} stroke="#ef4444" strokeDasharray="3 2" strokeWidth={1.5} label={{ value: '1.0', position: 'insideTopRight', fill: '#ef4444', fontSize: 9 }} />
                <Bar dataKey="dcr" radius={[0, 3, 3, 0]} label={{ position: 'right', formatter: (v: unknown) => Number(v).toFixed(3), fill: '#475569', fontSize: 9 }}>
                  {dcrs.map((d, i) => <Cell key={i} fill={dcrColor(d.dcr)} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Individual DCR rows */}
          <div style={{ background: '#0a1628', borderRadius: 10, border: '1px solid #1e293b', padding: '12px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
              Check Results
            </div>
            <DCRRow label="Positive Flexure" dcr={result.DCR_flex_pos}
              demand={load.Mu_pos} capacity={result.phi_Mn_pos} />
            <DCRRow label="Negative Flexure" dcr={result.DCR_flex_neg}
              demand={load.Mu_neg} capacity={result.phi_Mn_neg} />
            <DCRRow label="Shear" dcr={result.DCR_shear}
              demand={load.Vu} capacity={result.phi_Vn} unit="kips" />
            <DCRRow label="Torsion" dcr={result.DCR_torsion}
              demand={load.Tu} capacity={result.phi_Tn} />
          </div>

          {/* Key values */}
          <div style={{ background: '#0a1628', borderRadius: 10, border: '1px solid #1e293b', padding: '12px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
              Design Values
            </div>
            {[
              ['φMn+ (pos)', `${result.phi_Mn_pos.toFixed(1)} kip-ft`],
              ['φMn– (neg)', `${result.phi_Mn_neg.toFixed(1)} kip-ft`],
              ['φVn', `${result.phi_Vn.toFixed(1)} kips`],
              ['  Vc', `${result.Vc.toFixed(1)} kips`],
              ['  Vs', `${result.Vs.toFixed(1)} kips`],
              ['As,req+', `${result.As_req_pos.toFixed(2)} in²`],
              ['As,min', `${result.As_min.toFixed(2)} in²`],
              ['As,max', `${result.As_max.toFixed(2)} in²`],
              ['Av,req', `${result.Av_req.toFixed(4)} in²/in`],
              ['Tcr', `${result.Tcr.toFixed(1)} kip-ft`],
              ['Tu,thresh', `${result.Tu_threshold.toFixed(1)} kip-ft`],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', borderBottom: '1px solid #0f172a' }}>
                <span style={{ fontSize: 11, color: '#475569', fontFamily: 'monospace' }}>{k}</span>
                <span style={{ fontSize: 11, color: '#e2e8f0', fontFamily: 'monospace', fontWeight: 600 }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Warnings */}
        {result.warnings.length > 0 && (
          <div style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 10, padding: '10px 14px', marginTop: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#ef4444', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
              Code Warnings
            </div>
            {result.warnings.map((w, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'flex-start' }}>
                <span style={{ fontSize: 10, fontWeight: 700, flexShrink: 0, marginTop: 1, color: w.severity === 'error' ? '#ef4444' : '#f59e0b' }}>
                  {w.severity === 'error' ? '✗' : '⚠'}
                </span>
                <div>
                  <span style={{ fontSize: 9, fontWeight: 700, fontFamily: 'monospace', marginRight: 6, color: w.severity === 'error' ? '#ef4444' : '#f59e0b' }}>
                    [{w.code}]
                  </span>
                  <span style={{ fontSize: 11, color: w.severity === 'error' ? '#fca5a5' : '#fde68a' }}>{w.message}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCalc && (
        <CalcBreakdownModal
          member={member}
          loadId={activeLoadId ?? member.loads[0]?.id}
          onClose={() => setShowCalc(false)}
        />
      )}
    </div>
  );
}
