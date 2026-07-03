import { useState, type Dispatch, type SetStateAction } from 'react';
import type { Project, Member, DesignResults, DesignCode, RebarLayout } from '../../types';
import { runDesign } from '../../engines';
import { resolveCrack } from '../../utils/resolveCrack';
import { useUnits } from '../../contexts/UnitsContext';
import { dcrColor as themeDcrColor, dcrBg as themeDcrBg, ACCENT, BORDER, INK, MAP_DCR_BANDS, LABEL_STYLE, MONO_NUM, STATUS, SURFACE, TYPE } from '../../theme';
import { barSizeOptions, formatBarLabel } from '../../utils/rebar';
import { isSkinWarning, applyMinSkinReinforcement } from '../../utils/skinReinforcement';
import MemberEditor from '../SectionInput/MemberEditor';
import MemberResults from '../Results/MemberResults';
import GroupRebarEditor from '../ModelMap/GroupRebarEditor';
import InfoTooltip from '../common/InfoTooltip';
import Dropdown from '../common/Dropdown';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface Props {
  project: Project;
  onSelectMember: (id: string) => void;
  onProjectUpdate?: (updater: (prev: Project) => Project) => void;
  /** Collapse state lifted to App so it survives tab switches. */
  collapsedGroups: Set<string>;
  setCollapsedGroups: Dispatch<SetStateAction<Set<string>>>;
}

interface MemberSummary {
  member: Member;
  worstResult: DesignResults;
  maxDCR: number;
}

// Selection state: either a member id or a group id
type Selection =
  | { kind: 'member'; id: string }
  | { kind: 'group'; id: string };

function worstOf(r: DesignResults): number {
  return Math.max(
    r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear, r.DCR_torsion,
    r.DCR_PM ?? 0, r.DCR_axial ?? 0,
  );
}

function summarize(m: Member, code: DesignCode, slsCombo?: string): MemberSummary {
  const results = m.loads.map(l =>
    runDesign(m.section, m.material, m.rebar, l, m.span, code, resolveCrack(m, code, slsCombo)));
  const maxDCR = Math.max(...results.map(worstOf));
  const worstResult = results.reduce((a, b) => worstOf(b) > worstOf(a) ? b : a);
  return { member: m, worstResult, maxDCR };
}

function modeDCRs(s: MemberSummary, code: DesignCode) {
  const r = s.worstResult;
  return {
    flexPos: r.DCR_flex_pos,
    flexNeg: r.DCR_flex_neg,
    shear: r.DCR_shear,
    // Crack DCR straight from the engine (wk / actual w_limit per face),
    // not a hard-coded 0.3 mm assumption.
    wk: code === 'EN1992-1-1' ? (r.DCR_crack ?? 0) : undefined,
  };
}

const dcrColor = themeDcrColor;
const dcrBg = themeDcrBg;

const DESIGN_CODES: DesignCode[] = ['ACI318-19', 'ACI318-14', 'EN1992-1-1'];

interface DCRChipProps {
  label: string;
  value: number | undefined;
  isWk?: boolean;
}

// Chips use the shared dcrColor thresholds (amber above NEAR_CAPACITY = 0.9),
// so a member reads the same color here as on the map and in the results.
function DCRChip({ label, value, isWk }: DCRChipProps) {
  let display: string;
  let bg: string;

  if (value === undefined) {
    display = '—';
    bg = INK.muted;
  } else if (isWk) {
    display = value > 1.0 ? '!' : value > 0.9 ? '!' : 'OK';
    bg = dcrColor(value);
  } else {
    display = value.toFixed(2);
    bg = dcrColor(value);
  }

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <span style={{ fontSize: 10, color: INK.muted, fontWeight: 600, lineHeight: 1 }}>{label}</span>
      <span style={{
        padding: '2px 5px', borderRadius: 3, fontSize: 11, fontWeight: 700,
        background: bg, color: 'white', ...MONO_NUM, lineHeight: 1.3,
      }}>{display}</span>
    </span>
  );
}

export default function Dashboard({ project, onSelectMember, onProjectUpdate, collapsedGroups, setCollapsedGroups }: Props) {
  const { units, setUnits, fmtVal, label } = useUnits();
  const [editingMeta, setEditingMeta] = useState(false);
  const [skinNumBars, setSkinNumBars] = useState(2);
  const [skinBarSize, setSkinBarSize] = useState(units === 'si' ? -16 : 5);
  const [selection, setSelection] = useState<Selection>({ kind: 'member', id: project.members[0]?.id ?? '' });
  const [meta, setMeta] = useState({ name: project.name, engineer: project.engineer, date: project.date, code: project.code as DesignCode, description: project.description });
  const [issuesOpen, setIssuesOpen] = useState(true);
  // Resizable panels
  const [leftWidth, setLeftWidth] = useState(420);
  const [dragging, setDragging] = useState(false);
  // DCR overview filters
  const [dcrGroupFilter, setDcrGroupFilter] = useState<string>('__all__');
  const [dcrSeriesFilter, setDcrSeriesFilter] = useState<string>('__all__');

  const summaries = project.members.map(m => summarize(m, project.code, project.slsCombo));
  const okCount   = summaries.filter(s => s.worstResult.status === 'OK').length;
  const ngCount   = summaries.filter(s => s.worstResult.status === 'NG').length;
  const warnCount = summaries.filter(s => s.worstResult.status === 'Warning').length;

  const issues = summaries
    .filter(s => s.worstResult.status !== 'OK')
    .sort((a, b) => {
      const an = a.worstResult.status === 'NG' ? 1 : 0;
      const bn = b.worstResult.status === 'NG' ? 1 : 0;
      if (an !== bn) return bn - an;
      return b.maxDCR - a.maxDCR;
    });

  const skinFlagged = summaries.filter(s => s.worstResult.warnings.some(isSkinWarning));
  const flaggedIdSet = new Set(skinFlagged.map(s => s.member.id));
  const showSkinControl = project.code === 'EN1992-1-1' && skinFlagged.length > 0;

  function applySkinReinforcement() {
    onProjectUpdate?.(prev => ({
      ...prev,
      members: applyMinSkinReinforcement(prev.members, flaggedIdSet, { numBars: skinNumBars, barSize: skinBarSize }),
    }));
  }

  const summaryById = new Map(summaries.map(s => [s.member.id, s]));
  const designGroups = project.designGroups ?? [];
  const groupSections = designGroups.map(g => ({
    id: g.id, label: g.label, color: g.color,
    rebar: g.rebar,
    members: g.memberIds.map(id => project.members.find(m => m.id === id)).filter(Boolean) as Member[],
  })).filter(s => s.members.length > 0);
  const assignedIds = new Set(designGroups.flatMap(g => g.memberIds));
  const ungrouped = project.members.filter(m => !assignedIds.has(m.id));

  const selectedMemberId = selection.kind === 'member' ? selection.id : null;
  const selectedMember = selectedMemberId ? (project.members.find(m => m.id === selectedMemberId) ?? null) : null;
  const selectedGroupId = selection.kind === 'group' ? selection.id : null;
  const ungroupedEntry = ungrouped.length
    ? { id: '__ungrouped', label: 'Ungrouped', color: INK.muted, rebar: undefined as RebarLayout | undefined, members: ungrouped }
    : null;
  const selectedGroupSection = selectedGroupId
    ? (groupSections.find(g => g.id === selectedGroupId) ?? (ungroupedEntry?.id === selectedGroupId ? ungroupedEntry : null))
    : null;

  function handleMemberUpdate(updated: Member) {
    onProjectUpdate?.(prev => ({ ...prev, members: prev.members.map(m => m.id === updated.id ? updated : m) }));
  }

  function toggleGroup(id: string) {
    setCollapsedGroups(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function handleGroupHeaderClick(groupId: string) {
    // Select the group in the right pane
    setSelection({ kind: 'group', id: groupId });
    // Also toggle expand/collapse
    toggleGroup(groupId);
  }

  function handleMemberRowClick(memberId: string) {
    setSelection({ kind: 'member', id: memberId });
  }


  function handleApplyGroupRebar(groupId: string, rebar: RebarLayout, memberIds: string[]) {
    const memberIdSet = new Set(memberIds);
    onProjectUpdate?.(prev => ({
      ...prev,
      designGroups: (prev.designGroups ?? []).map(g => g.id === groupId ? { ...g, rebar } : g),
      members: prev.members.map(m => memberIdSet.has(m.id) ? { ...m, rebar } : m),
    }));
  }

  // Compute group-level failure mode worst DCRs
  function groupModeDCRs(members: Member[]) {
    let flexPos = 0, flexNeg = 0, shear = 0, wk = 0;
    let hasWk = false;
    for (const m of members) {
      const s = summaryById.get(m.id);
      if (!s) continue;
      const modes = modeDCRs(s, project.code as DesignCode);
      flexPos = Math.max(flexPos, modes.flexPos);
      flexNeg = Math.max(flexNeg, modes.flexNeg);
      shear = Math.max(shear, modes.shear);
      if (modes.wk !== undefined) { wk = Math.max(wk, modes.wk); hasWk = true; }
    }
    return { flexPos, flexNeg, shear, wk: hasWk ? wk : undefined };
  }

  // Find the governing (worst DCR) member in a group
  function governingMemberId(members: Member[]): string | null {
    let worstId: string | null = null;
    let worstDCR = -1;
    for (const m of members) {
      const dcr = summaryById.get(m.id)?.maxDCR ?? 0;
      if (dcr > worstDCR) { worstDCR = dcr; worstId = m.id; }
    }
    return worstId;
  }

  // Count errors/warnings in a group
  function groupIssueCounts(members: Member[]) {
    let ng = 0, warn = 0;
    for (const m of members) {
      const s = summaryById.get(m.id);
      if (!s) continue;
      if (s.worstResult.status === 'NG') ng++;
      else if (s.worstResult.status === 'Warning') warn++;
    }
    return { ng, warn };
  }

  function worstGroupDCR(ms: Member[]): number {
    return ms.reduce((mx, m) => Math.max(mx, summaryById.get(m.id)?.maxDCR ?? 0), 0);
  }

  function onDividerMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    setDragging(true);
    const startX = e.clientX;
    const startW = leftWidth;
    function onMove(ev: MouseEvent) {
      setLeftWidth(Math.max(240, Math.min(700, startW + ev.clientX - startX)));
    }
    function onUp() {
      setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function MemberRow({ m, govId }: { m: Member; govId: string | null }) {
    const s = summaryById.get(m.id);
    const dcr = s?.maxDCR ?? 0;
    const status = s?.worstResult.status ?? 'OK';
    const active = selection.kind === 'member' && m.id === selection.id;
    const isGov = m.id === govId;
    const modes = s ? modeDCRs(s, project.code as DesignCode) : null;
    return (
      <div
        onClick={() => handleMemberRowClick(m.id)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 16px 6px 24px', cursor: 'pointer',
          background: active ? ACCENT.softBg : 'white', borderLeft: `3px solid ${active ? ACCENT.primary : 'transparent'}`,
          borderBottom: '1px solid #f3f4f6',
        }}
      >
        <span style={{ fontSize: 10, color: STATUS.warn, flexShrink: 0, width: 12 }}>{isGov ? '▲' : ''}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: INK.base, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
        <span style={{ fontSize: 10, color: INK.muted, ...MONO_NUM, flexShrink: 0 }}>{`${fmtVal(m.section.b, 'length')}×${fmtVal(m.section.h, 'length')} ${label('length')}`}</span>
        {modes && (
          <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <DCRChip label="M⁺" value={modes.flexPos} />
            <DCRChip label="M⁻" value={modes.flexNeg} />
            <DCRChip label="V" value={modes.shear} />
            <DCRChip label="wk" value={modes.wk} isWk />
          </span>
        )}
        <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 11, color: dcrColor(dcr), background: dcrBg(dcr), padding: '1px 5px', borderRadius: 4, flexShrink: 0 }}>{dcr.toFixed(2)}</span>
        <span style={{ fontSize: 10, fontWeight: 700, flexShrink: 0, color: status === 'OK' ? STATUS.ok : status === 'NG' ? STATUS.fail : STATUS.warn }}>{status}</span>
      </div>
    );
  }

  // DCR overview: filter members by the selected group (or ungrouped / all).
  const dcrSummaries = dcrGroupFilter === '__all__'
    ? summaries
    : dcrGroupFilter === '__ungrouped__'
      ? summaries.filter(s => !assignedIds.has(s.member.id))
      : summaries.filter(s => designGroups.find(g => g.id === dcrGroupFilter)?.memberIds.includes(s.member.id));

  // Series colors are categorical (no status greens/ambers/reds — those mean
  // pass/warn/fail); Shear keeps the app-wide cyan diagram convention.
  const DCR_SERIES = [
    { key: 'Flex+',   fill: ACCENT.primary },
    { key: 'Flex-',   fill: '#7c3aed' },
    { key: 'Shear',   fill: '#0891b2' },
    { key: 'Torsion', fill: '#0d9488' },
    { key: 'P-M',     fill: '#db2777' },
  ] as const;
  const shownSeries = dcrSeriesFilter === '__all__'
    ? DCR_SERIES
    : DCR_SERIES.filter(s => s.key === dcrSeriesFilter);

  const barData = dcrSummaries.map(s => {
    const r = s.worstResult;
    const isColumn = s.member.memberType === 'column';
    return {
      name: s.member.label.length > 12 ? s.member.label.slice(0, 12) + '…' : s.member.label,
      'Flex+':   parseFloat(r.DCR_flex_pos.toFixed(3)),
      'Flex-':   parseFloat(r.DCR_flex_neg.toFixed(3)),
      Shear:     parseFloat(r.DCR_shear.toFixed(3)),
      Torsion:   isColumn ? 0 : parseFloat(r.DCR_torsion.toFixed(3)),
      'P-M':     parseFloat((r.DCR_PM ?? 0).toFixed(3)),
    };
  });

  function saveMeta() {
    if (meta.code === 'EN1992-1-1' && project.code !== 'EN1992-1-1') {
      setUnits('si');
    }
    onProjectUpdate?.(prev => ({ ...prev, ...meta }));
    setEditingMeta(false);
  }

  const inp: React.CSSProperties = {
    padding: '4px 8px', border: `1px solid ${BORDER.strong}`, borderRadius: 6,
    fontSize: 12, color: INK.strong, background: 'white', outline: 'none', fontFamily: 'inherit',
  };

  const allGroups = [
    ...groupSections,
    ...(ungroupedEntry ? [ungroupedEntry] : []),
  ];


  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Project header */}
      <div style={{ background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 14, padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ flex: 1 }}>
            {editingMeta ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 2 }}>
                    <label style={LABEL_STYLE}>Project Name</label>
                    <input style={{ ...inp, fontSize: 14, fontWeight: 700 }} value={meta.name} onChange={e => setMeta(m => ({ ...m, name: e.target.value }))} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1 }}>
                    <label style={LABEL_STYLE}>Engineer</label>
                    <input style={inp} value={meta.engineer} onChange={e => setMeta(m => ({ ...m, engineer: e.target.value }))} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1 }}>
                    <label style={LABEL_STYLE}>Date</label>
                    <input style={inp} type="date" value={meta.date} onChange={e => setMeta(m => ({ ...m, date: e.target.value }))} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <label style={LABEL_STYLE}>Design Code</label>
                    <Dropdown style={inp} value={meta.code} options={DESIGN_CODES.map(c => ({ value: c, label: c }))} onChange={v => setMeta(m => ({ ...m, code: v as DesignCode }))} />
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <label style={LABEL_STYLE}>Description</label>
                  <input style={inp} value={meta.description} onChange={e => setMeta(m => ({ ...m, description: e.target.value }))} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={saveMeta} style={{ padding: '6px 16px', background: ACCENT.primary, color: 'white', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>Save</button>
                  <button onClick={() => { setEditingMeta(false); setMeta({ name: project.name, engineer: project.engineer, date: project.date, code: project.code, description: project.description }); }} style={{ padding: '6px 12px', background: 'white', color: INK.secondary, border: `1px solid ${BORDER.strong}`, borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: INK.strong }}>{project.name}</h2>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: INK.secondary }}>{project.description}</p>
                <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12, color: INK.secondary, flexWrap: 'wrap' }}>
                  <span>Engineer: <strong style={{ color: INK.base }}>{project.engineer}</strong></span>
                  <span>Code: <strong style={{ color: ACCENT.primary }}>{project.code}</strong></span>
                  <span>Date: <strong style={{ color: INK.base }}>{project.date}</strong></span>
                </div>
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            {!editingMeta && (
              <button onClick={() => setEditingMeta(true)} style={{ padding: '5px 10px', border: `1px solid ${BORDER.strong}`, borderRadius: 6, background: 'white', fontSize: 11, cursor: 'pointer', color: INK.base, fontWeight: 600 }}>
                Edit
              </button>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              {[
                { label: 'PASS', count: okCount, color: STATUS.ok, bg: STATUS.okBg, border: STATUS.okBorder },
                { label: 'WARN', count: warnCount, color: STATUS.warn, bg: STATUS.warnBg, border: STATUS.warnBorder },
                { label: 'FAIL', count: ngCount, color: STATUS.fail, bg: STATUS.failBg, border: STATUS.failBorder },
              ].map(({ label: lbl, count, color, bg, border }) => (
                <div key={lbl} style={{ textAlign: 'center', background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: '6px 12px' }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color, lineHeight: 1 }}>{count}</div>
                  <div style={{ fontSize: 10, color, fontWeight: 600, marginTop: 2 }}>{lbl}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Split workspace */}
      <div style={{ display: 'flex', height: 'min(78vh, 900px)', minHeight: 460, cursor: dragging ? 'col-resize' : 'auto' }}>
        {/* Left panel — resizable */}
        <div style={{ width: leftWidth, flexShrink: 0, background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 12, overflow: 'auto' }}>
          <div style={{ padding: '10px 16px', borderBottom: `1px solid ${BORDER.default}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, background: 'white', zIndex: 1 }}>
            <span style={{ ...LABEL_STYLE, fontSize: TYPE.label, color: INK.base }}>Members by Group</span>
            <span style={{ fontSize: 11, color: INK.muted }}>{project.members.length} members</span>
          </div>
          {allGroups.map(sec => {
            const open = !collapsedGroups.has(sec.id);
            const gModes = groupModeDCRs(sec.members);
            const govId = governingMemberId(sec.members);
            const { ng, warn } = groupIssueCounts(sec.members);
            const isGroupSelected = selection.kind === 'group' && selection.id === sec.id;
            return (
              <div key={sec.id}>
                {/* Group header row */}
                <div
                  onClick={() => handleGroupHeaderClick(sec.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', cursor: 'pointer',
                    background: isGroupSelected ? ACCENT.softBg : SURFACE.subtle,
                    borderBottom: '1px solid #f3f4f6',
                    borderLeft: `3px solid ${isGroupSelected ? ACCENT.primary : 'transparent'}`,
                  }}
                >
                  <span style={{ fontSize: 10, color: INK.muted, width: 10, flexShrink: 0 }}>{open ? '▾' : '▸'}</span>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: sec.color ?? INK.muted, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: INK.strong, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {sec.label}
                  </span>
                  <span style={{ fontSize: 10, color: INK.secondary, flexShrink: 0 }}>{sec.members.length}</span>
                  {/* Failure mode bar */}
                  <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                    <DCRChip label="M⁺" value={gModes.flexPos} />
                    <DCRChip label="M⁻" value={gModes.flexNeg} />
                    <DCRChip label="V" value={gModes.shear} />
                    <DCRChip label="wk" value={gModes.wk} isWk />
                  </span>
                  {/* Issue badges */}
                  {ng > 0 && (
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 5px', borderRadius: 3, background: STATUS.failBg, color: STATUS.fail, border: `1px solid ${STATUS.failBorder}`, flexShrink: 0 }}>
                      {ng} NG
                    </span>
                  )}
                  {warn > 0 && (
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 5px', borderRadius: 3, background: STATUS.warnBg, color: STATUS.warn, border: `1px solid ${STATUS.warnBorder}`, flexShrink: 0 }}>
                      {warn} W
                    </span>
                  )}
                </div>
                {/* Member rows when expanded */}
                {open && sec.members.map(m => <MemberRow key={m.id} m={m} govId={govId} />)}
              </div>
            );
          })}
        </div>

        {/* Drag divider */}
        <div
          onMouseDown={onDividerMouseDown}
          style={{ width: 6, cursor: 'col-resize', flexShrink: 0, background: dragging ? ACCENT.softBorder : 'transparent', transition: 'background 0.1s' }}
        />

        {/* Right pane */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {selection.kind === 'group' && selectedGroupSection ? (
            /* Group reinforcement panel */
            <div style={{ flex: 1, overflow: 'auto', padding: 2 }}>
              <GroupPanel
                group={selectedGroupSection}
                project={project}
                summaryById={summaryById}
                onApplyRebar={handleApplyGroupRebar}
                onSelectMember={(id) => setSelection({ kind: 'member', id })}
                onSelectMemberTab={onSelectMember}
                inp={inp}
                onProjectUpdate={onProjectUpdate}
              />
            </div>
          ) : selection.kind === 'member' && selectedMember ? (
            /* Two-column member detail: inputs left, live results right */
            <>
              {/* Sticky header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 14px', background: 'white', borderBottom: `1px solid ${BORDER.default}`, borderRadius: '12px 12px 0 0', flexShrink: 0 }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: INK.strong }}>{selectedMember.label}</h3>
                  <div style={{ fontSize: 11, color: INK.muted }}>{selectedMember.etabs?.story ?? ''}{selectedMember.etabs?.story ? ' · ' : ''}{selectedMember.etabs?.sectionName ?? selectedMember.section.type}</div>
                </div>
                <button onClick={() => onSelectMember(selectedMember.id)} style={{ fontSize: 11, color: ACCENT.primary, background: 'none', border: `1px solid ${ACCENT.softBorder}`, borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  Open in Member tab ↗
                </button>
              </div>
              {/* Side-by-side columns */}
              <div style={{ flex: 1, display: 'flex', overflow: 'hidden', background: 'white', border: `1px solid ${BORDER.default}`, borderTop: 'none', borderRadius: '0 0 12px 12px' }}>
                {/* Left: section inputs / properties */}
                <div style={{ width: 340, flexShrink: 0, borderRight: `1px solid ${BORDER.default}`, overflow: 'auto', padding: '12px 14px' }}>
                  <MemberEditor key={selectedMember.id} member={selectedMember} onUpdate={handleMemberUpdate} code={project.code} />
                </div>
                {/* Right: live DCR / diagrams */}
                <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '12px 14px' }}>
                  <MemberResults member={selectedMember} code={project.code} slsCombo={project.slsCombo} engineer={project.engineer} sconcreteResults={project.sconcreteResults} sconcreteRanAt={project.sconcreteRanAt} onRebarChange={handleMemberUpdate} />
                </div>
              </div>
            </>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: INK.muted, fontSize: 13 }}>Select a member or group to view details.</div>
          )}
        </div>
      </div>

      {/* Issues panel — collapsible, below the Members-by-Group workspace */}
      <div style={{ background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 12, overflow: 'hidden' }}>
        <div
          onClick={() => setIssuesOpen(o => !o)}
          style={{ padding: '10px 16px', borderBottom: issuesOpen ? `1px solid ${BORDER.default}` : 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
        >
          <span style={{ ...LABEL_STYLE, fontSize: TYPE.label, color: INK.base, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-block', transition: 'transform 0.15s', transform: issuesOpen ? 'rotate(90deg)' : 'rotate(0deg)', color: INK.muted }}>▶</span>
            Issues
          </span>
          <span style={{ fontSize: 11, color: INK.muted }}>
            {ngCount} exceeding DCR · {warnCount} warning{warnCount !== 1 ? 's' : ''}
          </span>
        </div>

        {issuesOpen && (issues.length === 0 ? (
          <div style={{ padding: '14px 16px', fontSize: 12, color: INK.muted }}>No issues — all members pass.</div>
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
                    background: isNG ? STATUS.failBg : 'white',
                    borderLeft: `3px solid ${isNG ? STATUS.fail : STATUS.warn}`,
                  }}
                >
                  <button
                    onClick={() => onSelectMember(member.id)}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                      fontSize: 13, fontWeight: 700, color: ACCENT.primary, textAlign: 'left', minWidth: 110,
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
                    color: isNG ? STATUS.fail : STATUS.warn,
                    background: isNG ? '#fee2e2' : '#fef3c7',
                  }}>
                    {isNG ? 'NG' : 'WARN'}
                  </span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
                    {shown.map(msg => (
                      <div key={msg} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#4b5563' }}>
                        <span style={{
                          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                          background: sevOf(msg) === 'error' ? STATUS.fail : STATUS.warn,
                        }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{msg}</span>
                      </div>
                    ))}
                    {extra > 0 && (
                      <div style={{ fontSize: 10, color: INK.muted, paddingLeft: 12 }}>+{extra} more</div>
                    )}
                    {shown.length === 0 && (
                      <div style={{ fontSize: 11, color: INK.muted }}>DCR exceeds capacity.</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}

        {issuesOpen && showSkinControl && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '10px 16px', borderTop: `1px solid ${BORDER.default}`, background: STATUS.warnBg,
          }}>
            <span style={{ fontSize: 12, color: '#92400e', fontWeight: 600 }}>
              {skinFlagged.length} beam{skinFlagged.length !== 1 ? 's' : ''} need skin/side-face reinforcement.
            </span>
            <label style={{ fontSize: 11, color: INK.secondary, display: 'flex', alignItems: 'center', gap: 4 }}>
              Bars/face
              <input
                type="number" min={1} value={skinNumBars}
                onChange={e => setSkinNumBars(Math.max(1, +e.target.value || 1))}
                style={{ ...inp, width: 56, ...MONO_NUM }}
              />
            </label>
            <label style={{ fontSize: 11, color: INK.secondary, display: 'flex', alignItems: 'center', gap: 4 }}>
              Bar size
              <Dropdown
                value={skinBarSize}
                options={barSizeOptions(units, skinBarSize).map(s => ({ value: s, label: formatBarLabel(s) }))}
                onChange={v => setSkinBarSize(+v)}
                style={inp}
              />
            </label>
            <button
              onClick={applySkinReinforcement}
              style={{
                padding: '6px 14px', background: STATUS.warn, color: 'white', border: 'none',
                borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Apply min skin reinforcement to {skinFlagged.length} beam{skinFlagged.length !== 1 ? 's' : ''}
            </button>
          </div>
        )}
      </div>

      {/* DCR Overview Chart */}
      <div style={{ background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 12, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ ...LABEL_STYLE, fontSize: TYPE.label, color: INK.base }}>
            DCR Overview <span style={{ color: INK.muted }}>· {barData.length} members</span>
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Dropdown
              value={dcrGroupFilter}
              options={[
                { value: '__all__', label: 'All groups' },
                ...groupSections.map(g => ({ value: g.id, label: g.label })),
                ...(ungrouped.length > 0 ? [{ value: '__ungrouped__', label: 'Ungrouped' }] : []),
              ]}
              onChange={setDcrGroupFilter}
              style={{ ...inp, width: 'auto', fontSize: 11 }}
            />
            <Dropdown
              value={dcrSeriesFilter}
              options={[
                { value: '__all__', label: 'All DCRs' },
                ...DCR_SERIES.map(s => ({ value: s.key, label: s.key })),
              ]}
              onChange={setDcrSeriesFilter}
              style={{ ...inp, width: 'auto', fontSize: 11 }}
            />
          </div>
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={barData} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="#f3f4f6" strokeDasharray="3 3" />
            <XAxis dataKey="name" tick={{ fill: INK.muted, fontSize: 10 }} />
            <YAxis domain={[0, 1.3]} tick={{ fill: INK.muted, fontSize: 10 }} />
            <Tooltip
              contentStyle={{ background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 8, fontSize: 11 }}
              labelStyle={{ color: INK.base, fontWeight: 600 }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: INK.secondary }} />
            {shownSeries.map(s => <Bar key={s.key} dataKey={s.key} fill={s.fill} />)}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Group Material Editor ────────────────────────────────────────────────────

interface GroupMaterialEditorProps {
  group: { id: string; label: string; members: Member[] };
  project: Project;
  onProjectUpdate?: (updater: (prev: Project) => Project) => void;
}

function GroupMaterialEditor({ group, project, onProjectUpdate }: GroupMaterialEditorProps) {
  const code = project.code;
  const isEC2 = code === 'EN1992-1-1';
  const { toDisplay, fromDisplay } = useUnits();
  const first = group.members[0];
  // Display values in the active unit system (MPa for EC2, ksi for ACI).
  // material.fc / fy / fyt are stored in psi internally.
  const [fck, setFck] = useState(+(toDisplay(first?.material.fc ?? (isEC2 ? 30 / 0.00689476 : 4000), 'stress').toFixed(1)));
  const [fyLong, setFyLong] = useState(+(toDisplay(first?.material.fy ?? (isEC2 ? 500 / 0.00689476 : 60000), 'stress').toFixed(1)));
  const [fyTie, setFyTie] = useState(+(toDisplay((first?.material.fyt ?? first?.material.fy) ?? (isEC2 ? 500 / 0.00689476 : 60000), 'stress').toFixed(1)));

  function applyToGroup() {
    const ids = new Set(group.members.map(m => m.id));
    onProjectUpdate?.(prev => ({
      ...prev,
      members: prev.members.map(m => ids.has(m.id)
        ? { ...m, material: { ...m.material, fc: fromDisplay(fck, 'stress'), fy: fromDisplay(fyLong, 'stress'), fyt: fromDisplay(fyTie, 'stress') } }
        : m),
    }));
  }

  const inp: React.CSSProperties = { padding: '4px 8px', border: `1px solid ${BORDER.strong}`, borderRadius: 6, fontSize: 12, width: 80, fontFamily: 'monospace' };

  return (
    <div style={{ background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 10, padding: 14 }}>
      <div style={{ ...LABEL_STYLE, fontSize: TYPE.label, color: INK.base, marginBottom: 10 }}>Group Material Properties</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 10, color: INK.secondary, marginBottom: 3, display: 'flex', alignItems: 'center' }}>
            {isEC2 ? 'f_ck (MPa)' : "f'c (ksi)"}
            <InfoTooltip text={isEC2 ? 'Characteristic cylinder compressive strength. The engine derives fcd = 0.85·fck/1.5 (αcc=0.85, γc=1.5).' : "Specified 28-day cylinder compressive strength in ksi."} />
          </div>
          <input type="number" style={inp} value={fck} onChange={e => setFck(+e.target.value)} />
        </div>
        <div>
          <div style={{ fontSize: 10, color: INK.secondary, marginBottom: 3, display: 'flex', alignItems: 'center' }}>
            {isEC2 ? 'f_yk long (MPa)' : 'f_y long (ksi)'}
            <InfoTooltip text={isEC2 ? 'Characteristic yield strength of longitudinal bars. Design value fyd = fyk/γs = fyk/1.15.' : 'Yield strength of longitudinal bars in ksi.'} />
          </div>
          <input type="number" style={inp} value={fyLong} onChange={e => setFyLong(+e.target.value)} />
        </div>
        <div>
          <div style={{ fontSize: 10, color: INK.secondary, marginBottom: 3, display: 'flex', alignItems: 'center' }}>
            {isEC2 ? 'f_yk tie (MPa)' : 'f_yt tie (ksi)'}
            <InfoTooltip text={isEC2 ? 'Characteristic yield strength of transverse bars (links/stirrups). Used for V_Rd,s and min shear reinforcement ratio.' : 'Yield strength of transverse reinforcement (stirrups) in ksi.'} />
          </div>
          <input type="number" style={inp} value={fyTie} onChange={e => setFyTie(+e.target.value)} />
        </div>
      </div>
      <button
        onClick={applyToGroup}
        style={{ padding: '6px 14px', background: '#7c3aed', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
      >
        Apply to all {group.members.length} members
      </button>
    </div>
  );
}

// ─── Group Panel ─────────────────────────────────────────────────────────────

interface GroupPanelProps {
  group: { id: string; label: string; color?: string; rebar?: RebarLayout; members: Member[] };
  project: Project;
  summaryById: Map<string, MemberSummary>;
  onApplyRebar: (groupId: string, rebar: RebarLayout, memberIds: string[]) => void;
  onSelectMember: (id: string) => void;
  onSelectMemberTab: (id: string) => void;
  inp: React.CSSProperties;
  onProjectUpdate?: (updater: (prev: Project) => Project) => void;
}

function GroupPanel({
  group, project, summaryById,
  onApplyRebar, onSelectMember, onSelectMemberTab, inp, onProjectUpdate,
}: GroupPanelProps) {
  const code = project.code as DesignCode;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Group title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 14, height: 14, borderRadius: 4, background: group.color ?? INK.muted, flexShrink: 0 }} />
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: INK.strong }}>{group.label}</h3>
        <span style={{ fontSize: 12, color: INK.muted }}>{group.members.length} members</span>
      </div>

      {/* Group DCR summary — averages + distribution histogram */}
      <GroupDcrSummary members={group.members} summaryById={summaryById} code={code} />

      {/* Group reinforcement — full interactive editor */}
      <div style={{ background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${BORDER.default}`, background: SURFACE.subtle }}>
          <span style={{ ...LABEL_STYLE, fontSize: TYPE.label, color: INK.base }}>Group Reinforcement</span>
        </div>
        <GroupRebarEditor
          group={{ id: group.id, label: group.label, color: group.color, rebar: group.rebar, memberIds: group.members.map(m => m.id) }}
          members={group.members}
          onApply={onApplyRebar}
          code={project.code}
          targetDCR={project.targetDCR ?? 0.9}
        />
      </div>

      {/* Group Material Properties */}
      <GroupMaterialEditor group={group} project={project} onProjectUpdate={onProjectUpdate} />

      {/* Member results mini-table */}
      <div style={{ background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: '8px 14px', borderBottom: `1px solid ${BORDER.default}`, background: SURFACE.subtle }}>
          <span style={{ ...LABEL_STYLE, fontSize: TYPE.label, color: INK.base }}>Member Results</span>
        </div>
        {/* Table header */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 60px 60px 60px 60px 60px', gap: 0, padding: '6px 14px', borderBottom: '1px solid #f3f4f6', background: SURFACE.subtle }}>
          {['Label', 'M⁺ DCR', 'M⁻ DCR', 'V DCR', 'wk', 'Status', ''].map(h => (
            <span key={h} style={LABEL_STYLE}>{h}</span>
          ))}
        </div>
        {group.members.map(m => {
          const s = summaryById.get(m.id);
          const modes = s ? modeDCRs(s, code) : null;
          const status = s?.worstResult.status ?? 'OK';
          return (
            <div
              key={m.id}
              onClick={() => onSelectMember(m.id)}
              style={{ display: 'grid', gridTemplateColumns: '1fr 60px 60px 60px 60px 60px 60px', gap: 0, padding: '7px 14px', borderBottom: '1px solid #f3f4f6', cursor: 'pointer', alignItems: 'center' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f0f9ff')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{ fontSize: 12, color: INK.base, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
              {modes ? (
                <>
                  <DCRInlineCell value={modes.flexPos} />
                  <DCRInlineCell value={modes.flexNeg} />
                  <DCRInlineCell value={modes.shear} />
                  <DCRInlineCell value={modes.wk} isWk />
                </>
              ) : (
                <><span>—</span><span>—</span><span>—</span><span>—</span></>
              )}
              <span style={{ fontSize: 10, fontWeight: 700, color: status === 'OK' ? STATUS.ok : status === 'NG' ? STATUS.fail : STATUS.warn }}>{status}</span>
              <button
                onClick={e => { e.stopPropagation(); onSelectMemberTab(m.id); }}
                style={{ fontSize: 10, color: ACCENT.primary, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >↗</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Group DCR summary: averages + mini distribution histogram ─────────────────

function AvgChip({ label, value }: { label: string; value: number | undefined }) {
  const display = value === undefined ? '—' : value.toFixed(2);
  const bg = value === undefined ? INK.muted : dcrColor(value);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <span style={{ fontSize: 10, color: INK.muted, fontWeight: 600, lineHeight: 1 }}>{label}</span>
      <span style={{
        padding: '2px 5px', borderRadius: 3, fontSize: 11, fontWeight: 700,
        background: bg, color: 'white', ...MONO_NUM, lineHeight: 1.3,
      }}>{display}</span>
    </span>
  );
}

// Same bands as the model map's DCR coloring, so the histogram and the map
// always tell the same story.
const DCR_BUCKETS = MAP_DCR_BANDS;

function DcrHistogram({ values }: { values: number[] }) {
  const counts = DCR_BUCKETS.map(() => 0);
  for (const v of values) {
    let i = DCR_BUCKETS.findIndex(b => v < b.max);
    if (i === -1) i = DCR_BUCKETS.length - 1;
    counts[i]++;
  }
  const maxC = Math.max(1, ...counts);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 30 }}>
      {DCR_BUCKETS.map((b, i) => (
        <div key={i} title={`${b.label}: ${counts[i]} member${counts[i] === 1 ? '' : 's'}`}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
          <span style={{ fontSize: 10, color: INK.muted, lineHeight: 1, marginBottom: 1 }}>{counts[i] || ''}</span>
          <div style={{ width: 12, height: Math.max(2, (counts[i] / maxC) * 22), background: counts[i] ? b.color : BORDER.default, borderRadius: 1 }} />
        </div>
      ))}
    </div>
  );
}

function GroupDcrSummary({ members, summaryById, code }: { members: Member[]; summaryById: Map<string, MemberSummary>; code: DesignCode }) {
  let sp = 0, sn = 0, ss = 0, sw = 0, cw = 0, n = 0;
  const gov: number[] = [];
  for (const m of members) {
    const s = summaryById.get(m.id);
    if (!s) continue;
    const md = modeDCRs(s, code);
    sp += md.flexPos; sn += md.flexNeg; ss += md.shear;
    if (md.wk !== undefined) { sw += md.wk; cw++; }
    gov.push(s.maxDCR);
    n++;
  }
  if (!n) return null;
  const avg = { flexPos: sp / n, flexNeg: sn / n, shear: ss / n, wk: cw ? sw / cw : undefined };
  const avgGov = gov.reduce((a, b) => a + b, 0) / gov.length;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 10, padding: '8px 14px' }}>
      <div>
        <div style={{ ...LABEL_STYLE, marginBottom: 4 }}>Average DCR</div>
        <div style={{ display: 'flex', gap: 4 }}>
          <AvgChip label="M⁺" value={avg.flexPos} />
          <AvgChip label="M⁻" value={avg.flexNeg} />
          <AvgChip label="V" value={avg.shear} />
          <AvgChip label="wk" value={avg.wk} />
        </div>
      </div>
      <div style={{ width: 1, alignSelf: 'stretch', background: BORDER.default }} />
      <div>
        <div style={{ ...LABEL_STYLE, marginBottom: 4 }}>
          DCR Distribution <span style={{ color: INK.secondary, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>· avg gov {avgGov.toFixed(2)}</span>
        </div>
        <DcrHistogram values={gov} />
      </div>
    </div>
  );
}

function DCRInlineCell({ value, isWk }: { value: number | undefined; isWk?: boolean }) {
  if (value === undefined) return <span style={{ fontSize: 11, color: INK.muted }}>—</span>;
  if (isWk) {
    const ok = value <= 0.9;
    const warn = value > 0.9 && value <= 1.0;
    const fail = value > 1.0;
    const color = fail ? STATUS.fail : warn ? STATUS.warn : STATUS.ok;
    const bg = fail ? STATUS.failBg : warn ? STATUS.warnBg : STATUS.okBg;
    return <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 5px', borderRadius: 3, background: bg, color }}>{fail ? '!' : ok ? 'OK' : '!'}</span>;
  }
  const color = value > 1.0 ? STATUS.fail : value > 0.75 ? STATUS.warn : STATUS.ok;
  const bg = value > 1.0 ? STATUS.failBg : value > 0.75 ? STATUS.warnBg : STATUS.okBg;
  return <span style={{ fontSize: 10, fontWeight: 700, ...MONO_NUM, padding: '2px 5px', borderRadius: 3, background: bg, color }}>{value.toFixed(2)}</span>;
}
