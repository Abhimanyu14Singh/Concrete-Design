import { useState } from 'react';
import type { Project, Member, DesignResults, DesignCode } from '../../types';
import { runDesign } from '../../engines';
import { resolveCrack } from '../../utils/resolveCrack';
import { designWallACI } from '../../utils/wallDesign';
import { useUnits } from '../../contexts/UnitsContext';
import { dcrColor as themeDcrColor, dcrBg as themeDcrBg } from '../../theme';
import { barSizeOptions, formatBarLabel } from '../../utils/rebar';
import { isSkinWarning, applyMinSkinReinforcement } from '../../utils/skinReinforcement';
import MemberEditor from '../SectionInput/MemberEditor';
import MemberResults from '../Results/MemberResults';
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
  const { units, setUnits, fmtVal, label } = useUnits();
  const [editingMeta, setEditingMeta] = useState(false);
  const [skinNumBars, setSkinNumBars] = useState(2);
  const [skinBarSize, setSkinBarSize] = useState(units === 'si' ? -16 : 5);
  const [selectedId, setSelectedId] = useState<string>(project.members[0]?.id ?? '');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [meta, setMeta] = useState({ name: project.name, engineer: project.engineer, date: project.date, code: project.code as DesignCode, description: project.description });

  const summaries = project.members.map(m => summarize(m, project.code, project.slsCombo));
  const okCount   = summaries.filter(s => s.worstResult.status === 'OK').length;
  const ngCount   = summaries.filter(s => s.worstResult.status === 'NG').length;
  const warnCount = summaries.filter(s => s.worstResult.status === 'Warning').length;

  // Members with issues (NG or Warning), sorted NG / highest DCR first.
  const issues = summaries
    .filter(s => s.worstResult.status !== 'OK')
    .sort((a, b) => {
      const an = a.worstResult.status === 'NG' ? 1 : 0;
      const bn = b.worstResult.status === 'NG' ? 1 : 0;
      if (an !== bn) return bn - an;
      return b.maxDCR - a.maxDCR;
    });

  // Beams flagged with a skin/side-face reinforcement warning (EC2 only).
  const skinFlagged = summaries.filter(s => s.worstResult.warnings.some(isSkinWarning));
  const flaggedIdSet = new Set(skinFlagged.map(s => s.member.id));
  const showSkinControl = project.code === 'EN1992-1-1' && skinFlagged.length > 0;

  function applySkinReinforcement() {
    onProjectUpdate?.({
      ...project,
      members: applyMinSkinReinforcement(project.members, flaggedIdSet, { numBars: skinNumBars, barSize: skinBarSize }),
    });
  }

  // ── Split workspace: members grouped by design group ──
  const summaryById = new Map(summaries.map(s => [s.member.id, s]));
  const designGroups = project.designGroups ?? [];
  const groupSections = designGroups.map(g => ({
    id: g.id, label: g.label, color: g.color,
    members: g.memberIds.map(id => project.members.find(m => m.id === id)).filter(Boolean) as Member[],
  })).filter(s => s.members.length > 0);
  const assignedIds = new Set(designGroups.flatMap(g => g.memberIds));
  const ungrouped = project.members.filter(m => !assignedIds.has(m.id));

  const selectedMember = project.members.find(m => m.id === selectedId) ?? project.members[0];

  function handleMemberUpdate(updated: Member) {
    onProjectUpdate?.({ ...project, members: project.members.map(m => m.id === updated.id ? updated : m) });
  }

  function toggleGroup(id: string) {
    setCollapsedGroups(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function MemberRow({ m }: { m: Member }) {
    const s = summaryById.get(m.id);
    const dcr = s?.maxDCR ?? 0;
    const status = s?.worstResult.status ?? 'OK';
    const active = m.id === selectedId;
    return (
      <div
        onClick={() => setSelectedId(m.id)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px 6px 24px', cursor: 'pointer',
          background: active ? '#eff6ff' : 'white', borderLeft: `3px solid ${active ? '#2563eb' : 'transparent'}`,
          borderBottom: '1px solid #f3f4f6',
        }}
      >
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
        <span style={{ fontSize: 10, color: '#9ca3af', fontFamily: 'monospace', flexShrink: 0 }}>{`${fmtVal(m.section.b, 'length')}×${fmtVal(m.section.h, 'length')} ${label('length')}`}</span>
        <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 11, color: dcrColor(dcr), background: dcrBg(dcr), padding: '1px 5px', borderRadius: 4, flexShrink: 0 }}>{dcr.toFixed(2)}</span>
        <span style={{ fontSize: 9, fontWeight: 700, flexShrink: 0, color: status === 'OK' ? '#16a34a' : status === 'NG' ? '#dc2626' : '#d97706' }}>{status}</span>
      </div>
    );
  }

  function worstGroupDCR(ms: Member[]): number {
    return ms.reduce((mx, m) => Math.max(mx, summaryById.get(m.id)?.maxDCR ?? 0), 0);
  }

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

      {/* Issues panel */}
      <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 1 }}>Issues</span>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            {ngCount} exceeding DCR · {warnCount} warning{warnCount !== 1 ? 's' : ''}
          </span>
        </div>

        {issues.length === 0 ? (
          <div style={{ padding: '14px 16px', fontSize: 12, color: '#9ca3af' }}>No issues — all members pass.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {issues.map(({ member, worstResult, maxDCR }) => {
              const isNG = worstResult.status === 'NG';
              const msgs = Array.from(new Set(worstResult.warnings.map(w => w.message)));
              const sevOf = (msg: string) =>
                worstResult.warnings.find(w => w.message === msg)?.severity ?? 'warning';
              const shown = msgs.slice(0, 3);
              const extra = msgs.length - shown.length;
              return (
                <div
                  key={member.id}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 16px',
                    borderBottom: '1px solid #f3f4f6',
                    background: isNG ? '#fef2f2' : 'white',
                    borderLeft: `3px solid ${isNG ? '#dc2626' : '#d97706'}`,
                  }}
                >
                  <button
                    onClick={() => onSelectMember(member.id)}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                      fontSize: 13, fontWeight: 700, color: '#2563eb', textAlign: 'left', minWidth: 110,
                    }}
                  >
                    {member.label}
                  </button>
                  <span style={{
                    fontFamily: 'monospace', fontWeight: 700, fontSize: 12,
                    color: dcrColor(maxDCR), background: dcrBg(maxDCR), padding: '2px 6px', borderRadius: 4, flexShrink: 0,
                  }}>
                    {maxDCR.toFixed(3)}
                  </span>
                  <span style={{
                    fontSize: 10, fontWeight: 700, flexShrink: 0, padding: '2px 8px', borderRadius: 10,
                    color: isNG ? '#dc2626' : '#d97706',
                    background: isNG ? '#fee2e2' : '#fef3c7',
                  }}>
                    {isNG ? 'NG' : 'WARN'}
                  </span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
                    {shown.map(msg => (
                      <div key={msg} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#4b5563' }}>
                        <span style={{
                          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                          background: sevOf(msg) === 'error' ? '#dc2626' : '#d97706',
                        }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{msg}</span>
                      </div>
                    ))}
                    {extra > 0 && (
                      <div style={{ fontSize: 10, color: '#9ca3af', paddingLeft: 12 }}>+{extra} more</div>
                    )}
                    {shown.length === 0 && (
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>DCR exceeds capacity.</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {showSkinControl && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '10px 16px', borderTop: '1px solid #e5e7eb', background: '#fffbeb',
          }}>
            <span style={{ fontSize: 12, color: '#92400e', fontWeight: 600 }}>
              {skinFlagged.length} beam{skinFlagged.length !== 1 ? 's' : ''} need skin/side-face reinforcement.
            </span>
            <label style={{ fontSize: 11, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }}>
              Bars/face
              <input
                type="number" min={1} value={skinNumBars}
                onChange={e => setSkinNumBars(Math.max(1, +e.target.value || 1))}
                style={{ ...inp, width: 56, fontFamily: 'monospace' }}
              />
            </label>
            <label style={{ fontSize: 11, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }}>
              Bar size
              <select
                value={skinBarSize}
                onChange={e => setSkinBarSize(+e.target.value)}
                style={inp}
              >
                {barSizeOptions(units, skinBarSize).map(s => (
                  <option key={s} value={s}>{formatBarLabel(s)}</option>
                ))}
              </select>
            </label>
            <button
              onClick={applySkinReinforcement}
              style={{
                padding: '6px 14px', background: '#d97706', color: 'white', border: 'none',
                borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Apply min skin reinforcement to {skinFlagged.length} beam{skinFlagged.length !== 1 ? 's' : ''}
            </button>
          </div>
        )}
      </div>

      {/* Split workspace — groups navigator (left) + inline member editor (right) */}
      <div style={{ display: 'flex', gap: 16, height: 'min(78vh, 900px)', minHeight: 460 }}>
        {/* Left: members grouped by design group */}
        <div style={{ width: 400, flexShrink: 0, background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'auto' }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, background: 'white', zIndex: 1 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 1 }}>Members by Group</span>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>{project.members.length} members</span>
          </div>
          {[...groupSections, ...(ungrouped.length ? [{ id: '__ungrouped', label: 'Ungrouped', color: '#9ca3af', members: ungrouped }] : [])].map(sec => {
            const open = !collapsedGroups.has(sec.id);
            const gDCR = worstGroupDCR(sec.members);
            return (
              <div key={sec.id}>
                <div
                  onClick={() => toggleGroup(sec.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', cursor: 'pointer', background: '#f9fafb', borderBottom: '1px solid #f3f4f6' }}
                >
                  <span style={{ fontSize: 10, color: '#9ca3af', width: 10 }}>{open ? '▾' : '▸'}</span>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: sec.color ?? '#9ca3af', flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sec.label}</span>
                  <span style={{ fontSize: 10, color: '#6b7280' }}>{sec.members.length}</span>
                  <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 11, color: dcrColor(gDCR), background: dcrBg(gDCR), padding: '1px 5px', borderRadius: 4 }}>{gDCR.toFixed(2)}</span>
                </div>
                {open && sec.members.map(m => <MemberRow key={m.id} m={m} />)}
              </div>
            );
          })}
        </div>

        {/* Right: inline editor + results for the selected member */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {selectedMember ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#111827' }}>{selectedMember.label}</h3>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{selectedMember.etabs?.story ?? ''} · {selectedMember.etabs?.sectionName ?? selectedMember.section.type}</div>
                </div>
                <button onClick={() => onSelectMember(selectedMember.id)} style={{ fontSize: 11, color: '#2563eb', background: 'none', border: '1px solid #bfdbfe', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontWeight: 600 }}>
                  Open in Member tab ↗
                </button>
              </div>
              <MemberEditor key={selectedMember.id} member={selectedMember} onUpdate={handleMemberUpdate} code={project.code} />
              <MemberResults member={selectedMember} code={project.code} slsCombo={project.slsCombo} onRebarChange={handleMemberUpdate} />
            </>
          ) : (
            <div style={{ margin: 'auto', color: '#9ca3af', fontSize: 13 }}>Select a member to view its section summary and reinforcement.</div>
          )}
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
