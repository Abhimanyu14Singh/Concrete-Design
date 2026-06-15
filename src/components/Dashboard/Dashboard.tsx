import { useState } from 'react';
import type { Project, Member, DesignResults, DesignCode } from '../../types';
import { runDesign } from '../../engines';
import { resolveCrack } from '../../utils/resolveCrack';
import { designWallACI } from '../../utils/wallDesign';
import { useUnits } from '../../contexts/UnitsContext';
import CodeBadge from '../common/CodeBadge';
import { codeAccent, dcrColor as themeDcrColor, dcrBg as themeDcrBg } from '../../theme';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface Props {
  project: Project;
  onSelectMember: (id: string) => void;
  onProjectUpdate?: (p: Project) => void;
}

interface MemberSummary {
  member: Member;
  worstResult: DesignResults;
  maxDCR: number;
}

function worstOf(r: DesignResults): number {
  return Math.max(
    r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear, r.DCR_torsion,
    r.DCR_PM ?? 0, r.DCR_axial ?? 0,
    r.DCR_shear_wall ?? 0, r.DCR_flex_wall ?? 0, r.DCR_sbzAsh ?? 0,
  );
}

function summarize(m: Member, code: DesignCode, slsCombo?: string): MemberSummary {
  const isWall = m.memberType === 'wall' && !!m.wallRebar;
  const results = m.loads.map(l => isWall
    ? designWallACI(m.section, m.material, m.wallRebar!, l)
    : runDesign(m.section, m.material, m.rebar, l, m.span, code, resolveCrack(m, code, slsCombo)));
  const maxDCR = Math.max(...results.map(worstOf));
  const worstResult = results.reduce((a, b) => worstOf(b) > worstOf(a) ? b : a);
  return { member: m, worstResult, maxDCR };
}

const dcrColor = themeDcrColor;
const dcrBg = themeDcrBg;

const DESIGN_CODES: DesignCode[] = ['ACI318-19', 'ACI318-14', 'EN1992-1-1'];

export default function Dashboard({ project, onSelectMember, onProjectUpdate }: Props) {
  const { setUnits } = useUnits();
  const [editingMeta, setEditingMeta] = useState(false);
  const [meta, setMeta] = useState({ name: project.name, engineer: project.engineer, date: project.date, code: project.code as DesignCode, description: project.description });

  const summaries = project.members.map(m => summarize(m, project.code, project.slsCombo));
  const okCount   = summaries.filter(s => s.worstResult.status === 'OK').length;
  const ngCount   = summaries.filter(s => s.worstResult.status === 'NG').length;
  const warnCount = summaries.filter(s => s.worstResult.status === 'Warning').length;

  const barData = summaries.map(s => {
    const r = s.worstResult;
    const isWall   = s.member.memberType === 'wall';
    const isColumn = s.member.memberType === 'column';
    return {
      name: s.member.label.length > 12 ? s.member.label.slice(0, 12) + '…' : s.member.label,
      'Flex+':   isWall   ? 0 : parseFloat(r.DCR_flex_pos.toFixed(3)),
      'Flex-':   isWall   ? 0 : parseFloat(r.DCR_flex_neg.toFixed(3)),
      Shear:     isWall   ? parseFloat((r.DCR_shear_wall ?? r.DCR_shear).toFixed(3))
                           : parseFloat(r.DCR_shear.toFixed(3)),
      Torsion:   isWall || isColumn ? 0 : parseFloat(r.DCR_torsion.toFixed(3)),
      'P-M':     isWall   ? parseFloat((r.DCR_flex_wall ?? 0).toFixed(3))
                           : parseFloat((r.DCR_PM ?? 0).toFixed(3)),
      'SBZ Ash': isWall   ? parseFloat((r.DCR_sbzAsh ?? 0).toFixed(3)) : 0,
    };
  });

  function saveMeta() {
    // Switching to Eurocode defaults the display units to SI (user can toggle back)
    if (meta.code === 'EN1992-1-1' && project.code !== 'EN1992-1-1') {
      setUnits('si');
    }
    onProjectUpdate?.({ ...project, ...meta });
    setEditingMeta(false);
  }

  const inp: React.CSSProperties = {
    padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6,
    fontSize: 12, color: '#111827', background: 'white', outline: 'none', fontFamily: 'inherit',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Project header */}
      <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ flex: 1 }}>
            {editingMeta ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 2 }}>
                    <label style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>Project Name</label>
                    <input style={{ ...inp, fontSize: 14, fontWeight: 700 }} value={meta.name} onChange={e => setMeta(m => ({ ...m, name: e.target.value }))} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1 }}>
                    <label style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>Engineer</label>
                    <input style={inp} value={meta.engineer} onChange={e => setMeta(m => ({ ...m, engineer: e.target.value }))} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1 }}>
                    <label style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>Date</label>
                    <input style={inp} type="date" value={meta.date} onChange={e => setMeta(m => ({ ...m, date: e.target.value }))} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <label style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>Design Code</label>
                    <select style={inp} value={meta.code} onChange={e => setMeta(m => ({ ...m, code: e.target.value as DesignCode }))}>
                      {DESIGN_CODES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <label style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>Description</label>
                  <input style={inp} value={meta.description} onChange={e => setMeta(m => ({ ...m, description: e.target.value }))} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={saveMeta} style={{ padding: '6px 16px', background: '#2563eb', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>Save</button>
                  <button onClick={() => { setEditingMeta(false); setMeta({ name: project.name, engineer: project.engineer, date: project.date, code: project.code, description: project.description }); }} style={{ padding: '6px 12px', background: 'white', color: '#6b7280', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#111827' }}>{project.name}</h2>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>{project.description}</p>
                <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12, color: '#6b7280', flexWrap: 'wrap' }}>
                  <span>Engineer: <strong style={{ color: '#374151' }}>{project.engineer}</strong></span>
                  <span>Code: <strong style={{ color: '#2563eb' }}>{project.code}</strong></span>
                  <span>Date: <strong style={{ color: '#374151' }}>{project.date}</strong></span>
                </div>
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            {!editingMeta && (
              <button onClick={() => setEditingMeta(true)} style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, background: 'white', fontSize: 11, cursor: 'pointer', color: '#374151', fontWeight: 600 }}>
                Edit
              </button>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              {[
                { label: 'PASS', count: okCount, color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
                { label: 'WARN', count: warnCount, color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
                { label: 'FAIL', count: ngCount, color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
              ].map(({ label, count, color, bg, border }) => (
                <div key={label} style={{ textAlign: 'center', background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: '6px 12px' }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color, lineHeight: 1 }}>{count}</div>
                  <div style={{ fontSize: 10, color, fontWeight: 600, marginTop: 2 }}>{label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 16 }}>
        {/* Member table */}
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 1 }}>Member Summary</span>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>{project.members.length} members</span>
          </div>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['ID', 'Label', 'Type', "f'c", 'Section', 'Max DCR', 'Status', ''].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#6b7280', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, borderBottom: '1px solid #e5e7eb' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summaries.map(({ member, worstResult, maxDCR }) => (
                <tr
                  key={member.id}
                  onClick={() => onSelectMember(member.id)}
                  style={{ cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'white')}
                >
                  <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: '#2563eb', fontWeight: 700 }}>{member.id}</td>
                  <td style={{ padding: '8px 12px', color: '#374151', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{member.label}</td>
                  <td style={{ padding: '8px 12px', color: '#6b7280', textTransform: 'capitalize' }}>{member.memberType}</td>
                  <td style={{ padding: '8px 12px', color: '#6b7280', fontFamily: 'monospace' }}>{member.material.fc / 1000}k</td>
                  <td style={{ padding: '8px 12px', color: '#6b7280', fontFamily: 'monospace' }}>{`${member.section.b}"×${member.section.h}"`}</td>
                  <td style={{ padding: '8px 12px' }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, color: dcrColor(maxDCR), background: dcrBg(maxDCR), padding: '2px 6px', borderRadius: 4 }}>
                      {maxDCR.toFixed(3)}
                    </span>
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: worstResult.status === 'OK' ? '#16a34a' : worstResult.status === 'NG' ? '#dc2626' : '#d97706' }}>
                      {worstResult.status}
                    </span>
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <button style={{ fontSize: 11, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>View →</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Stats sidebar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>Project Stats</div>
            {[
              ['Total Members', project.members.length],
              ['Load Cases', project.members.reduce((s, m) => s + m.loads.length, 0)],
              ['Avg Max DCR', summaries.length ? (summaries.reduce((s, m) => s + m.maxDCR, 0) / summaries.length).toFixed(3) : '—'],
            ].map(([label, val]) => (
              <div key={String(label)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #f3f4f6' }}>
                <span style={{ fontSize: 11, color: '#6b7280' }}>{label}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#111827' }}>{val}</span>
              </div>
            ))}
          </div>

          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderTop: `3px solid ${codeAccent(project.code)}`, borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Design Code</div>
            <CodeBadge code={project.code} size="md" />
            {project.code === 'EN1992-1-1' ? (
              <>
                <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 8 }}>Eurocode 2 — Partial Factor Method</div>
                <div style={{ marginTop: 10, fontSize: 11, color: '#6b7280', lineHeight: 1.6 }}>
                  <div>γ_c = 1.50, γ_s = 1.15</div>
                  <div>α_cc = 1.0</div>
                  <div>cot θ = 2.5 (variable strut)</div>
                </div>
              </>
            ) : (
              <>
                <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 8 }}>Strength Design Method</div>
                <div style={{ marginTop: 10, fontSize: 11, color: '#6b7280', lineHeight: 1.6 }}>
                  <div>φ_flex = 0.90</div>
                  <div>φ_shear = 0.75</div>
                  <div>φ_comp = 0.65 (tied) / 0.75 (spiral)</div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* DCR Overview Chart */}
      <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>DCR Overview — All Members</div>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={barData} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="#f3f4f6" strokeDasharray="3 3" />
            <XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 10 }} />
            <YAxis domain={[0, 1.3]} tick={{ fill: '#9ca3af', fontSize: 10 }} />
            <Tooltip
              contentStyle={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 11 }}
              labelStyle={{ color: '#374151', fontWeight: 600 }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: '#6b7280' }} />
            <Bar dataKey="Flex+"   fill="#3b82f6" />
            <Bar dataKey="Flex-"   fill="#8b5cf6" />
            <Bar dataKey="Shear"   fill="#f59e0b" />
            <Bar dataKey="Torsion" fill="#10b981" />
            <Bar dataKey="P-M"     fill="#ec4899" />
            <Bar dataKey="SBZ Ash" fill="#ef4444" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
