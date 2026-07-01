/**
 * ETABS Import Wizard — 4-step popup:
 *   1. Connect   — active ETABS instance (COM) / tables file (.xlsx) / demo model
 *   2. Filter    — story, beam sections, materials preview, ETABS groups, combos
 *   3. Rebar     — typical top/bottom steel % and three stirrup spacings
 *   4. Plan map  — beams colored by DCR; group editing; click-through to app
 */
import { useMemo, useRef, useState } from 'react';
import type { Member, DesignGroup, DesignCode, ModelMap, MapFrame } from '../../types';
import { DEFAULT_CRACK_PARAMS } from '../../types';
import type { EtabsConnection, EtabsConnectInfo, EtabsSectionInfo, EtabsMaterialInfo } from '../../adapters/etabs/connection';
import { MockConnection } from '../../adapters/etabs/mock';
import { ComConnection } from '../../adapters/etabs/comClient';
import { buildMembers, buildColumnMembers, autoGroup, envelopeLoadCase } from '../../adapters/etabs';
import type { SeedOptions } from '../../adapters/etabs/rebarSeed';
import { runDesign } from '../../engines';
import { barSizeOptions, formatBarLabel } from '../../utils/rebar';
import { useUnits } from '../../contexts/UnitsContext';
import PlanMap from './PlanMap';
import { dcrToColor } from './dcrColors';
import Dropdown from '../common/Dropdown';

interface Props {
  code: DesignCode;
  onClose: () => void;
  /** Commit imported members + groups into the project; pickId opens that member. */
  onImport: (
    members: Member[],
    groups: DesignGroup[],
    pickId?: string,
    modelMap?: ModelMap,
    slsCombo?: string,
    applyCode?: DesignCode,
    applyUnits?: 'imperial' | 'si',
  ) => void;
}

type SourceKind = 'com' | 'mock';

const STEPS = ['Connect', 'Filter', 'Rebar Defaults', 'Review & Import'];

function worstDCR(m: Member, code: DesignCode): number {
  const r = runDesign(m.section, m.material, m.rebar, m.loads[0], m.span, code);
  return Math.max(r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear);
}

export default function EtabsImportWizard({ code, onClose, onImport }: Props) {
  const { units, fmt, fmtVal, label } = useUnits();
  const IN_TO_MM = 25.4;
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wizard-local code + units — user can override without touching global settings
  const [wizardCode, setWizardCode] = useState<DesignCode>(code);
  const [wizardUnits, setWizardUnits] = useState<'imperial' | 'si'>(units);

  // step 1
  const [source, setSource] = useState<SourceKind>(window.electronAPI?.etabs ? 'com' : 'mock');
  const connRef = useRef<EtabsConnection | null>(null);
  const [connInfo, setConnInfo] = useState<EtabsConnectInfo | null>(null);

  // step 2 — model lists + selections
  const [stories, setStories] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [sections, setSections] = useState<EtabsSectionInfo[]>([]);
  const [materials, setMaterials] = useState<EtabsMaterialInfo[]>([]);
  const [combos, setCombos] = useState<string[]>([]);
  const [selStory, setSelStory] = useState<string>('');           // '' = all
  const [selSections, setSelSections] = useState<Set<string>>(new Set());
  const [selGroups, setSelGroups] = useState<Set<string>>(new Set()); // empty = all
  // ETABS groups to mirror as design-group names (empty = group by story·section)
  const [mirrorGroups, setMirrorGroups] = useState<Set<string>>(new Set());
  const [selCombos, setSelCombos] = useState<Set<string>>(new Set());
  const [slsComboId, setSlsComboId] = useState<string>('');
  const [matchCount, setMatchCount] = useState<number | null>(null);
  // Also bring in columns (geometry + section) so they show on the map and can be
  // grouped/designed. Column design forces start at zero (entered after import).
  const [includeColumns, setIncludeColumns] = useState(false);
  const [hasColumns, setHasColumns] = useState(false); // connection supports getColumns

  // step 3 — stirrup size defaults to Ø10 in SI, #4 in imperial (display only;
  // spacings are stored in inches and converted for display when SI)
  const [seed, setSeed] = useState<SeedOptions>(() => ({
    rhoTopPct: 0.4, rhoBotPct: 0.6, stirrupSpacings: [4, 8, 4],
    stirrupBarSize: units === 'si' ? -10 : 4, stirrupLegs: 2,
    imposeSkinReinf: true, skinBarSize: units === 'si' ? -12 : 5,
  }));

  // When the user switches units inside the wizard, reset bar size defaults
  function handleWizardUnitsChange(u: 'imperial' | 'si') {
    setWizardUnits(u);
    setSeed(s => ({
      ...s,
      stirrupBarSize: u === 'si' ? -10 : 4,
      skinBarSize: u === 'si' ? -12 : 5,
    }));
  }

  const [applyToProject, setApplyToProject] = useState(true);

  // Material overrides — stored in display units (MPa for SI, psi for imperial).
  // null = no override (use per-section material from ETABS).
  const [matOverride, setMatOverride] = useState<{
    fck: string; fyLong: string; fyTie: string;
    enabled: boolean;
    collapsed: boolean;
  }>({ fck: '', fyLong: '', fyTie: '', enabled: false, collapsed: true });

  // step 4
  const [members, setMembers] = useState<Member[]>([]);
  const [designGroups, setDesignGroups] = useState<DesignGroup[]>([]);
  const [capturedModelMap, setCapturedModelMap] = useState<ModelMap | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [minDCR, setMinDCR] = useState(0);
  const [dcrVersion, setDcrVersion] = useState(0); // bump to recompute DCRs after edits

  const dcrById = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of members) out[m.id] = worstDCR(m, wizardCode);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, wizardCode, dcrVersion]);

  const filter = useMemo(() => ({
    stories: selStory ? [selStory] : undefined,
    sections: selSections.size ? [...selSections] : undefined,
    groups: selGroups.size ? [...selGroups] : undefined,
  }), [selStory, selSections, selGroups]);

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true); setError(null);
    try { return await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return undefined; }
    finally { setBusy(false); }
  }

  async function connectWith(conn: EtabsConnection) {
    const ok = await run(async () => {
      const info = await conn.connect();
      connRef.current = conn;
      setConnInfo(info);
      setHasColumns(!!conn.getColumns);
      const [st, gr, sec, mat, cmb] = await Promise.all([
        conn.getStories(), conn.getGroups(), conn.getFrameSections(),
        conn.getMaterials(), conn.getCombos(),
      ]);
      setStories(st); setGroups(gr); setSections(sec); setMaterials(mat); setCombos(cmb);
      setSelSections(new Set(sec.map(s => s.name)));
      setSelCombos(new Set(cmb));
      setSelStory('');
      return true;
    });
    if (ok) setStep(1);
  }

  async function handleConnect() {
    if (source === 'mock') return connectWith(new MockConnection());
    return connectWith(new ComConnection());
  }

  async function refreshMatchCount() {
    const conn = connRef.current;
    if (!conn) return;
    const beams = await run(() => conn.getBeams(filter));
    setMatchCount(beams?.length ?? null);
  }

  async function buildAndReview() {
    const conn = connRef.current;
    if (!conn) return;
    const ok = await run(async () => {
      // Get all beams (no filter) for the connectivity map snapshot
      const allBeams = await conn.getBeams({});
      // Get filtered beams for design
      const beams = await conn.getBeams(filter);
      if (!beams.length) throw new Error('No beams match the current filter.');
      const sourceGroup = selGroups.size === 1 ? [...selGroups][0] : undefined;
      // Always fetch the SLS combo's forces too, even if it wasn't selected for
      // ULS import, so per-beam crack-width resolution from stationForces works.
      const forceCombos = new Set(selCombos);
      if (slsComboId) forceCombos.add(slsComboId);
      const forces = await conn.getStationForces(beams.map(b => b.name), [...forceCombos], sourceGroup);
      let built = buildMembers(beams, sections, materials, forces, seed, wizardCode);
      // Columns (optional): bring in geometry + section so they appear on the map
      // and can be grouped/designed. Forces start at zero (entered after import).
      let allColumns: import('../../adapters/etabs/connection').EtabsColumnGeom[] = [];
      if (includeColumns && conn.getColumns) {
        allColumns = await conn.getColumns({});
        const filteredCols = await conn.getColumns(filter);
        built = [...built, ...buildColumnMembers(filteredCols, sections, materials, seed)];
      }
      // Apply global material overrides if the user enabled them.
      if (matOverride.enabled) {
        const PSI_PER_MPA = 145.038;
        const toInternal = (v: string) => {
          const n = parseFloat(v);
          if (!Number.isFinite(n) || n <= 0) return null;
          return wizardUnits === 'si' ? n * PSI_PER_MPA : n;
        };
        const fcPsi = toInternal(matOverride.fck);
        const fyLongPsi = toInternal(matOverride.fyLong);
        const fyTiePsi = toInternal(matOverride.fyTie);
        if (fcPsi != null || fyLongPsi != null || fyTiePsi != null) {
          built = built.map(m => ({
            ...m,
            material: {
              ...m.material,
              ...(fcPsi != null ? { fc: fcPsi } : {}),
              ...(fyLongPsi != null ? { fy: fyLongPsi } : {}),
              ...(fyTiePsi != null ? { fyt: fyTiePsi } : {}),
            },
          }));
        }
      }
      const builtById = new Map(built.map(m => [m.etabs?.frameName, m.id]));

      // Build modelMap from all beam + column geometry
      const uniqueStories = [...new Set([...allBeams.map(b => b.story), ...allColumns.map(c => c.story)])].sort();
      const frames: MapFrame[] = [
        ...allBeams.map(b => ({
          frameName: b.name, story: b.story, sectionName: b.section, pt1: b.pt1, pt2: b.pt2,
          memberId: builtById.get(b.name),
        })),
        ...allColumns.map(c => ({
          frameName: c.name, story: c.story, sectionName: c.section, pt1: c.pt1, pt2: c.pt2,
          memberId: builtById.get(c.name),
        })),
      ];
      const modelMap: ModelMap = {
        source,
        modelName: connInfo?.modelName ?? 'ETABS model',
        importedAt: new Date().toISOString(),
        stories: uniqueStories,
        frames,
      };
      setCapturedModelMap(modelMap);

      setDesignGroups(autoGroup(built, mirrorGroups));
      setMembers(built);
      setSelected(new Set());
      return true;
    });
    if (ok) setStep(3);
  }

  function toggleSelect(id: string, additive: boolean) {
    setSelected(prev => {
      const next = additive ? new Set(prev) : new Set<string>();
      if (prev.has(id) && additive) next.delete(id); else next.add(id);
      return next;
    });
  }

  function mergeSelectedIntoGroup() {
    if (selected.size < 2) return;
    setDesignGroups(prev => {
      const id = `dg-${prev.length + 1}-m`;
      const g: DesignGroup = { id, label: `Custom group (${selected.size})`, memberIds: [...selected] };
      const cleaned = prev
        .map(p => ({ ...p, memberIds: p.memberIds.filter(mid => !selected.has(mid)) }))
        .filter(p => p.memberIds.length > 0);
      setMembers(ms => ms.map(m => selected.has(m.id) && m.etabs
        ? { ...m, etabs: { ...m.etabs, designGroupId: id } } : m));
      return [...cleaned, g];
    });
    setSelected(new Set());
  }

  /** Adjust bottom-bar count for every member of a design group, re-flag DCRs. */
  function bumpGroupBars(groupId: string, delta: number) {
    setMembers(ms => ms.map(m => {
      if (m.etabs?.designGroupId !== groupId) return m;
      const bot = m.rebar.botBars[0];
      if (!bot) return m;
      const numBars = Math.min(10, Math.max(2, bot.numBars + delta));
      return { ...m, rebar: { ...m.rebar, botBars: [{ ...bot, numBars }] } };
    }));
    setDcrVersion(v => v + 1);
  }

  function groupWorstDCR(g: DesignGroup): number {
    return Math.max(...g.memberIds.map(id => dcrById[id] ?? 0), 0);
  }

  function commit(pickId?: string) {
    // refresh envelope load labels with the chosen combos before handing off.
    // The SLS quasi-permanent combo is stored at PROJECT level (project.slsCombo)
    // and resolved per beam from stationForces at design time — no per-member id.
    const labeled = members.map(m => m.memberType === 'beam'
      ? { ...m, loads: [envelopeLoadCase(m.stationForces ?? [], `ETABS env (${[...selCombos].join(', ')})`)] }
      : m); // columns keep their (user-entered / placeholder) loads
    onImport(
      labeled, designGroups, pickId, capturedModelMap ?? undefined,
      slsComboId || undefined,
      applyToProject ? wizardCode : undefined,
      applyToProject ? wizardUnits : undefined,
    );
  }

  // ── styles ──────────────────────────────────────────────────────────────────
  const card: React.CSSProperties = { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px' };
  const lbl: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 };
  const inp: React.CSSProperties = { padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, color: '#111827', background: 'white', outline: 'none', fontFamily: 'monospace' };
  const btn = (primary = false): React.CSSProperties => ({
    padding: '7px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    background: primary ? '#2563eb' : 'white', color: primary ? 'white' : '#374151',
    border: primary ? 'none' : '1px solid #d1d5db',
  });
  const chip = (active: boolean): React.CSSProperties => ({
    padding: '3px 10px', borderRadius: 12, fontSize: 11, cursor: 'pointer',
    border: `1px solid ${active ? '#2563eb' : '#d1d5db'}`,
    background: active ? '#eff6ff' : 'white', color: active ? '#2563eb' : '#6b7280',
    fontWeight: active ? 700 : 400,
  });

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'flex-start',
        justifyContent: 'center', padding: '24px 16px', overflowY: 'auto',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'white', border: '1px solid #e5e7eb', borderRadius: 16,
        width: '100%', maxWidth: 980, maxHeight: '92vh', display: 'flex',
        flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
      }}>
        {/* Header with step progress */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', background: '#f9fafb', borderRadius: '16px 16px 0 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>Import Beams from ETABS</h2>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              {STEPS.map((s, i) => (
                <span key={s} style={{
                  fontSize: 10, padding: '2px 10px', borderRadius: 10, fontWeight: 600,
                  background: i === step ? '#2563eb' : i < step ? '#dbeafe' : '#f3f4f6',
                  color: i === step ? 'white' : i < step ? '#2563eb' : '#9ca3af',
                }}>
                  {i + 1}. {s}
                </span>
              ))}
            </div>
          </div>
          <button onClick={onClose} style={btn()}>✕ Close</button>
        </div>

        {error && (
          <div style={{ margin: '12px 20px 0', padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12, color: '#dc2626' }}>
            {error}
          </div>
        )}

        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          {/* ── Step 1: Connect ── */}
          {step === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
              <div style={lbl}>Model source</div>
              {([
                ['com', 'ETABS Active Instance', 'One click — attaches to the model open in ETABS and reads geometry, sections, and forces (run the analysis first)', !window.electronAPI?.etabs],
                ['mock', 'Sample model (demo)', 'Built-in 2-story demo model — try the workflow without ETABS', false],
              ] as [SourceKind, string, string, boolean][]).map(([kind, title, desc, disabled]) => (
                <label key={kind} style={{
                  ...card, display: 'flex', gap: 10, cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.55 : 1,
                  border: `1px solid ${source === kind ? '#2563eb' : '#e5e7eb'}`,
                  background: source === kind ? '#eff6ff' : '#f9fafb',
                }}>
                  <input type="radio" checked={source === kind} disabled={disabled}
                    onChange={() => setSource(kind)} style={{ marginTop: 2 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{title}</div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{desc}</div>
                    {disabled && <div style={{ fontSize: 10, color: '#d97706', marginTop: 2 }}>Requires the Windows desktop app with ETABS running</div>}
                  </div>
                </label>
              ))}
              <button style={btn(true)} disabled={busy} onClick={handleConnect}>
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          )}

          {/* ── Step 2: Filter ── */}
          {step === 1 && connInfo && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ fontSize: 12, color: '#16a34a', fontWeight: 600 }}>
                ✓ Connected: {connInfo.modelName} <span style={{ color: '#9ca3af' }}>({connInfo.units})</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div style={card}>
                  <div style={lbl}>Story / floor</div>
                  <Dropdown style={{ ...inp, width: '100%' }} value={selStory}
                    options={[{ value: '', label: 'All stories' }, ...stories.map(s => ({ value: s, label: s }))]}
                    onChange={v => { setSelStory(v); setMatchCount(null); }} />
                </div>
                <div style={card}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <div style={lbl}>Beam sections</div>
                    {(selSections.size > 0 || selGroups.size > 0) && (
                      <span style={{ fontSize: 10, color: '#6b7280' }}>sections ∪ groups — beams matching either are imported</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {sections.map(s => (
                      <span key={s.name} style={chip(selSections.has(s.name))}
                        onClick={() => { setSelSections(prev => { const n = new Set(prev); if (n.has(s.name)) n.delete(s.name); else n.add(s.name); return n; }); setMatchCount(null); }}>
                        {s.name} <span style={{ opacity: 0.7 }}>({fmtVal(s.width, 'length')}×{fmtVal(s.depth, 'length')} {label('length')})</span>
                      </span>
                    ))}
                  </div>
                </div>
                <div style={card}>
                  <div style={lbl}>ETABS groups (empty = all)</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {groups.map(g => (
                      <span key={g} style={chip(selGroups.has(g))}
                        onClick={() => { setSelGroups(prev => { const n = new Set(prev); if (n.has(g)) n.delete(g); else n.add(g); return n; }); setMatchCount(null); }}>
                        {g}
                      </span>
                    ))}
                    {!groups.length && <span style={{ fontSize: 11, color: '#9ca3af' }}>No groups defined in model</span>}
                  </div>
                </div>
                <div style={card}>
                  <div style={lbl}>Design groups from ETABS (empty = story · section)</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {groups.map(g => (
                      <span key={g} style={chip(mirrorGroups.has(g))}
                        onClick={() => setMirrorGroups(prev => { const n = new Set(prev); if (n.has(g)) n.delete(g); else n.add(g); return n; })}>
                        {g}
                      </span>
                    ))}
                    {!groups.length && <span style={{ fontSize: 11, color: '#9ca3af' }}>No groups defined in model</span>}
                  </div>
                  <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>
                    Selected ETABS groups become design groups with the same name; remaining beams group by story · section.
                  </div>
                </div>
                <div style={card}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <div style={lbl}>Load combinations to import</div>
                    <span style={{ fontSize: 10, color: '#9ca3af' }}>
                      {selCombos.size} of {combos.length} selected
                    </span>
                    <div style={{ flex: 1 }} />
                    <button onClick={() => setSelCombos(new Set(combos))}
                      style={{ fontSize: 11, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: '0 4px' }}>
                      All
                    </button>
                    <button onClick={() => setSelCombos(new Set())}
                      style={{ fontSize: 11, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: '0 4px' }}>
                      None
                    </button>
                  </div>
                  {/* Scrollable checkbox list */}
                  <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 6, background: 'white' }}>
                    {combos.map((c, i) => (
                      <label key={c} style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '5px 10px', cursor: 'pointer', fontSize: 12,
                        background: selCombos.has(c) ? '#eff6ff' : 'transparent',
                        borderBottom: i < combos.length - 1 ? '1px solid #f3f4f6' : 'none',
                      }}>
                        <input
                          type="checkbox"
                          checked={selCombos.has(c)}
                          onChange={() => setSelCombos(prev => {
                            const n = new Set(prev);
                            if (n.has(c)) n.delete(c); else n.add(c);
                            return n;
                          })}
                          style={{ accentColor: '#2563eb' }}
                        />
                        <span style={{ color: selCombos.has(c) ? '#1d4ed8' : '#374151', fontFamily: 'monospace' }}>{c}</span>
                      </label>
                    ))}
                  </div>
                  {selCombos.size === 0 && (
                    <div style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>
                      Select at least one combination to continue.
                    </div>
                  )}
                  {selCombos.size > 0 && (
                    <div style={{ fontSize: 10, color: '#6b7280', marginTop: 4 }}>
                      Only the selected combinations are requested from ETABS.
                    </div>
                  )}
                  <div style={{ marginTop: 10 }}>
                    <div style={lbl}>SLS quasi-permanent combo (for EC2 crack width)</div>
                    <Dropdown
                      style={{ ...inp, width: '100%' }}
                      value={slsComboId}
                      options={[{ value: '', label: '— none / use M_qp ratio —' }, ...combos.map(c => ({ value: c, label: c }))]}
                      onChange={setSlsComboId}
                    />
                    <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>
                      If selected, this combo's moments are used as M_qp for EC2 §7.3.4 crack width checks.
                    </div>
                  </div>
                </div>
              </div>
              <div style={card}>
                <div style={lbl}>Materials (imported with sections)</div>
                <table style={{ fontSize: 11, borderCollapse: 'collapse' }}>
                  <tbody>
                    {materials.map(m => (
                      <tr key={m.name}>
                        <td style={{ padding: '2px 16px 2px 0', fontFamily: 'monospace', color: '#2563eb' }}>{m.name}</td>
                        <td style={{ padding: '2px 16px 2px 0', color: '#6b7280' }}>{m.fc ? `f'c = ${fmt(m.fc / 1000, 'stressKsi')}` : ''}</td>
                        <td style={{ color: '#6b7280' }}>{m.fy ? `fy = ${fmt(m.fy / 1000, 'stressKsi')}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {hasColumns && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#374151', cursor: 'pointer', padding: '2px 0' }}>
                  <input type="checkbox" checked={includeColumns} onChange={e => setIncludeColumns(e.target.checked)} />
                  Also import columns (geometry + section — shown on the map &amp; groupable; enter design forces after import)
                </label>
              )}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button style={btn()} onClick={() => setStep(0)}>← Back</button>
                <button style={btn()} disabled={busy} onClick={refreshMatchCount}>Count matching beams</button>
                {matchCount != null && <span style={{ fontSize: 12, color: '#374151', fontWeight: 600 }}>{matchCount} beams match</span>}
                <div style={{ flex: 1 }} />
                <button style={btn(true)} disabled={busy || selCombos.size === 0} onClick={() => setStep(2)}>
                  Next: Rebar defaults →
                </button>
              </div>
            </div>
          )}

          {/* ── Step 3: Rebar defaults ── */}
          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 620 }}>
              {/* Code + units picker */}
              <div style={{ ...card, display: 'flex', gap: 24, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div>
                  <div style={lbl}>Design code</div>
                  <Dropdown
                    style={inp}
                    value={wizardCode}
                    options={[{ value: 'ACI318-19', label: 'ACI 318-19' }, { value: 'EN1992-1-1', label: 'EN 1992-1-1 (EC2)' }]}
                    onChange={v => setWizardCode(v as DesignCode)}
                  />
                </div>
                <div>
                  <div style={lbl}>Units (rebar display)</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      onClick={() => handleWizardUnitsChange('imperial')}
                      style={{ ...btn(wizardUnits === 'imperial'), padding: '5px 14px', fontSize: 12 }}>
                      Imperial (in)
                    </button>
                    <button
                      onClick={() => handleWizardUnitsChange('si')}
                      style={{ ...btn(wizardUnits === 'si'), padding: '5px 14px', fontSize: 12 }}>
                      SI (mm)
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={applyToProject}
                      onChange={e => setApplyToProject(e.target.checked)}
                    />
                    <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>Apply to project</span>
                  </label>
                  <div style={{ fontSize: 11, color: '#9ca3af', maxWidth: 240 }}>
                    Sets the project's design code and unit system to match these wizard selections on import.
                  </div>
                </div>
              </div>
              <div style={card}>
                <div style={lbl}>Typical longitudinal steel (% of b·d)</div>
                <div style={{ display: 'flex', gap: 18 }}>
                  {([['rhoTopPct', 'Top bars ρ'], ['rhoBotPct', 'Bottom bars ρ']] as const).map(([key, label]) => (
                    <label key={key} style={{ fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 6 }}>
                      {label}
                      <input type="number" step={0.05} min={0.1} max={2.5} style={{ ...inp, width: 70 }}
                        value={seed[key]}
                        onChange={e => setSeed(s => ({ ...s, [key]: +e.target.value }))} /> %
                    </label>
                  ))}
                </div>
              </div>
              <div style={card}>
                <div style={lbl}>Stirrup spacing by zone — thirds of span ({wizardUnits === 'si' ? 'mm' : 'in'})</div>
                <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                  {['End (0–L/3)', 'Middle (L/3–2L/3)', 'End (2L/3–L)'].map((zl, i) => (
                    <label key={zl} style={{ fontSize: 12, color: '#6b7280', display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {zl}
                      <input type="number"
                        step={wizardUnits === 'si' ? 10 : 0.5} min={wizardUnits === 'si' ? 50 : 2}
                        style={{ ...inp, width: 80 }}
                        value={wizardUnits === 'si' ? Math.round(seed.stirrupSpacings[i] * IN_TO_MM) : seed.stirrupSpacings[i]}
                        onChange={e => setSeed(s => {
                          const sp = [...s.stirrupSpacings] as [number, number, number];
                          const v = +e.target.value;
                          sp[i] = wizardUnits === 'si' ? v / IN_TO_MM : v;
                          return { ...s, stirrupSpacings: sp };
                        })} />
                    </label>
                  ))}
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    Stirrup size
                    <Dropdown style={inp} value={seed.stirrupBarSize ?? (wizardUnits === 'si' ? -10 : 4)}
                      options={barSizeOptions(wizardUnits, seed.stirrupBarSize ?? (wizardUnits === 'si' ? -10 : 4))
                        .filter(b => b === (seed.stirrupBarSize ?? (wizardUnits === 'si' ? -10 : 4)) || (b > 0 ? b <= 8 : -b <= 20))
                        .map(b => ({ value: b, label: formatBarLabel(b) }))}
                      onChange={v => setSeed(s => ({ ...s, stirrupBarSize: +v }))}
                    />
                  </label>
                </div>
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '8px 0 0' }}>
                  Bar sizes/counts are auto-selected per section to meet the target steel area; you can edit any beam afterwards.
                </p>
              </div>
              <div style={card}>
                <div style={lbl}>Minimum face / skin reinforcement</div>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ fontSize: 12, color: '#374151', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!seed.imposeSkinReinf}
                      onChange={e => setSeed(s => ({ ...s, imposeSkinReinf: e.target.checked }))} />
                    Auto-impose per {wizardCode === 'EN1992-1-1' ? 'EC2' : 'ACI'}
                  </label>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'flex', flexDirection: 'column', gap: 3, opacity: seed.imposeSkinReinf ? 1 : 0.4 }}>
                    Skin bar size
                    <Dropdown style={inp} value={seed.skinBarSize ?? (wizardUnits === 'si' ? -12 : 5)}
                      disabled={!seed.imposeSkinReinf}
                      options={barSizeOptions(wizardUnits, seed.skinBarSize ?? (wizardUnits === 'si' ? -12 : 5))
                        .filter(b => b === (seed.skinBarSize ?? (wizardUnits === 'si' ? -12 : 5)) || (b > 0 ? b <= 8 : -b <= 20))
                        .map(b => ({ value: b, label: formatBarLabel(b) }))}
                      onChange={v => setSeed(s => ({ ...s, skinBarSize: +v }))}
                    />
                  </label>
                </div>
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '8px 0 0' }}>
                  {wizardCode === 'EN1992-1-1'
                    ? 'EC2 §7.3.3: surface reinforcement on deep beams (h > 1000 mm), distributed over the tension half at ≤ 300 mm.'
                    : 'ACI 318 §9.7.2.3: skin reinforcement where h > 36 in, distributed over the lower h/2 at ≤ 12 in.'}
                  {' '}Shallower sections get no side bars. Edit per beam afterwards.
                </p>
              </div>
              {/* Cover override */}
              <div style={card}>
                <div style={lbl}>Clear cover to stirrup face ({wizardUnits === 'si' ? 'mm' : 'in'})</div>
                <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 6 }}>
                    Cover
                    <input
                      type="number"
                      step={wizardUnits === 'si' ? 5 : 0.25}
                      min={wizardUnits === 'si' ? 10 : 0.5}
                      max={wizardUnits === 'si' ? 100 : 4}
                      style={{ ...inp, width: 80 }}
                      value={wizardUnits === 'si'
                        ? Math.round((seed.coverClear ?? 1.5) * IN_TO_MM)
                        : (seed.coverClear ?? 1.5)}
                      onChange={e => {
                        const v = +e.target.value;
                        setSeed(s => ({ ...s, coverClear: wizardUnits === 'si' ? v / IN_TO_MM : v }));
                      }}
                    />
                  </label>
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>
                    Applies to all imported beams (default {wizardUnits === 'si' ? '38 mm' : '1.5 in'}).
                    Affects effective depth and bar placement.
                  </span>
                </div>
              </div>

              {/* Material overrides */}
              <div style={card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                  onClick={() => setMatOverride(s => ({ ...s, collapsed: !s.collapsed }))}>
                  <input
                    type="checkbox"
                    checked={matOverride.enabled}
                    onClick={e => e.stopPropagation()}
                    onChange={e => setMatOverride(s => ({ ...s, enabled: e.target.checked, collapsed: !e.target.checked ? s.collapsed : false }))}
                  />
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#374151', flex: 1 }}>
                    Override material properties (global)
                  </span>
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>{matOverride.collapsed ? '▾' : '▴'}</span>
                </div>
                {!matOverride.collapsed && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>
                      Overrides apply to all imported beams. Leave blank to keep per-section values from ETABS.
                      Values in {wizardUnits === 'si' ? 'MPa' : 'psi'}.
                    </div>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                      {([
                        ['fck', wizardUnits === 'si' ? "f'ck (MPa)" : "f'c (psi)", 'Concrete compressive strength'],
                        ['fyLong', wizardUnits === 'si' ? 'fy long (MPa)' : 'fy long (psi)', 'Longitudinal steel yield strength'],
                        ['fyTie', wizardUnits === 'si' ? 'fy tie (MPa)' : 'fyt (psi)', 'Transverse steel yield strength'],
                      ] as const).map(([key, labelText, title]) => (
                        <label key={key} title={title} style={{ fontSize: 12, color: '#6b7280', display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {labelText}
                          <input
                            type="number"
                            min={1}
                            style={{ ...inp, width: 100, opacity: matOverride.enabled ? 1 : 0.5 }}
                            disabled={!matOverride.enabled}
                            value={matOverride[key]}
                            placeholder="—"
                            onChange={e => setMatOverride(s => ({ ...s, [key]: e.target.value }))}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button style={btn()} onClick={() => setStep(1)}>← Back</button>
                <div style={{ flex: 1 }} />
                <button style={btn(true)} disabled={busy} onClick={buildAndReview}>
                  {busy ? 'Importing forces…' : 'Run design check →'}
                </button>
              </div>
            </div>
          )}

          {/* ── Step 4: Plan map review ── */}
          {step === 3 && (
            <div style={{ display: 'flex', gap: 16 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#111827' }}>
                    {members.length} beams · {selStory || 'all stories'}
                  </span>
                  <div style={{ flex: 1 }} />
                  <label style={{ fontSize: 11, color: '#6b7280' }}>
                    Show DCR ≥{' '}
                    <Dropdown style={inp} value={minDCR}
                      options={[{ value: 0, label: 'all' }, { value: 0.7, label: '0.70' }, { value: 0.9, label: '0.90' }, { value: 1.0, label: '1.00 (failing)' }]}
                      onChange={v => setMinDCR(+v)}
                    />
                  </label>
                </div>
                <PlanMap
                  members={members} dcrById={dcrById} selected={selected}
                  onToggleSelect={toggleSelect}
                  onPick={id => commit(id)}
                  minDCR={minDCR}
                />
              </div>

              {/* Group sidebar */}
              <div style={{ width: 290, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={card}>
                  <div style={lbl}>Design groups</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
                    {designGroups.map(g => {
                      const w = groupWorstDCR(g);
                      return (
                        <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 4, background: dcrToColor(w), flexShrink: 0 }} />
                          <span style={{ flex: 1, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {g.label} <span style={{ color: '#9ca3af' }}>({g.memberIds.length})</span>
                          </span>
                          <span style={{ fontFamily: 'monospace', fontWeight: 700, color: dcrToColor(w) }}>{w.toFixed(2)}</span>
                          <button title="Add one bottom bar to every beam in this group"
                            style={{ ...btn(), padding: '1px 7px', fontSize: 11 }} onClick={() => bumpGroupBars(g.id, +1)}>+bar</button>
                          <button title="Remove one bottom bar from every beam in this group"
                            style={{ ...btn(), padding: '1px 7px', fontSize: 11 }} onClick={() => bumpGroupBars(g.id, -1)}>−bar</button>
                        </div>
                      );
                    })}
                  </div>
                  <button style={{ ...btn(), marginTop: 8, width: '100%' }}
                    disabled={selected.size < 2} onClick={mergeSelectedIntoGroup}>
                    Merge {selected.size || ''} selected into new group
                  </button>
                  <p style={{ fontSize: 10, color: '#9ca3af', margin: '6px 0 0' }}>
                    Shift-click beams on the map to multi-select. Auto-groups = story × section.
                  </p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button style={btn()} onClick={() => setStep(2)}>← Back to rebar</button>
                  <button style={btn(true)} onClick={() => commit()}>
                    Import {members.length} beams into project
                  </button>
                  <p style={{ fontSize: 10, color: '#9ca3af', margin: 0, textAlign: 'center' }}>
                    Double-click a beam to import everything and open that beam.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
