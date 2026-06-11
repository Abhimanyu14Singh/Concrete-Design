/**
 * ETABS Import Wizard — 4-step popup:
 *   1. Connect   — active ETABS instance (COM) / tables file (.xlsx) / demo model
 *   2. Filter    — story, beam sections, materials preview, ETABS groups, combos
 *   3. Rebar     — typical top/bottom steel % and three stirrup spacings
 *   4. Plan map  — beams colored by DCR; group editing; click-through to app
 */
import { useMemo, useRef, useState } from 'react';
import type { Member, DesignGroup, DesignCode, ModelMap, MapFrame } from '../../types';
import type { EtabsConnection, EtabsConnectInfo, EtabsSectionInfo, EtabsMaterialInfo } from '../../adapters/etabs/connection';
import { MockConnection } from '../../adapters/etabs/mock';
import { FileConnection } from '../../adapters/etabs/fileImport';
import { ComConnection } from '../../adapters/etabs/comClient';
import { buildMembers, autoGroup, envelopeLoadCase } from '../../adapters/etabs';
import type { SeedOptions } from '../../adapters/etabs/rebarSeed';
import { runDesign } from '../../engines';
import PlanMap from './PlanMap';
import { dcrToColor } from './dcrColors';

interface Props {
  code: DesignCode;
  onClose: () => void;
  /** Commit imported members + groups into the project; pickId opens that member. */
  onImport: (members: Member[], groups: DesignGroup[], pickId?: string, modelMap?: ModelMap) => void;
}

type SourceKind = 'com' | 'file' | 'mock';

const STEPS = ['Connect', 'Filter', 'Rebar Defaults', 'Review & Import'];

function worstDCR(m: Member, code: DesignCode): number {
  const r = runDesign(m.section, m.material, m.rebar, m.loads[0], m.span, code);
  return Math.max(r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear);
}

export default function EtabsImportWizard({ code, onClose, onImport }: Props) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // step 1
  const [source, setSource] = useState<SourceKind>(window.electronAPI?.etabs ? 'com' : 'mock');
  const connRef = useRef<EtabsConnection | null>(null);
  const [connInfo, setConnInfo] = useState<EtabsConnectInfo | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // step 2 — model lists + selections
  const [stories, setStories] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [sections, setSections] = useState<EtabsSectionInfo[]>([]);
  const [materials, setMaterials] = useState<EtabsMaterialInfo[]>([]);
  const [combos, setCombos] = useState<string[]>([]);
  const [selStory, setSelStory] = useState<string>('');           // '' = all
  const [selSections, setSelSections] = useState<Set<string>>(new Set());
  const [selGroups, setSelGroups] = useState<Set<string>>(new Set()); // empty = all
  const [selCombos, setSelCombos] = useState<Set<string>>(new Set());
  const [matchCount, setMatchCount] = useState<number | null>(null);

  // step 3
  const [seed, setSeed] = useState<SeedOptions>({
    rhoTopPct: 0.4, rhoBotPct: 0.6, stirrupSpacings: [4, 8, 4],
    stirrupBarSize: 4, stirrupLegs: 2,
  });

  // step 4
  const [members, setMembers] = useState<Member[]>([]);
  const [designGroups, setDesignGroups] = useState<DesignGroup[]>([]);
  const [capturedModelMap, setCapturedModelMap] = useState<ModelMap | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [minDCR, setMinDCR] = useState(0);
  const [dcrVersion, setDcrVersion] = useState(0); // bump to recompute DCRs after edits

  const dcrById = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of members) out[m.id] = worstDCR(m, code);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, code, dcrVersion]);

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
      const [st, gr, sec, mat, cmb] = await Promise.all([
        conn.getStories(), conn.getGroups(), conn.getFrameSections(),
        conn.getMaterials(), conn.getCombos(),
      ]);
      setStories(st); setGroups(gr); setSections(sec); setMaterials(mat); setCombos(cmb);
      setSelSections(new Set(sec.map(s => s.name)));
      setSelCombos(new Set(cmb));
      setSelStory(st[0] ?? '');
      return true;
    });
    if (ok) setStep(1);
  }

  async function handleConnect() {
    if (source === 'mock') return connectWith(new MockConnection());
    if (source === 'com') return connectWith(new ComConnection());
    fileInputRef.current?.click(); // file: open the picker
  }

  async function handleFile(file: File) {
    const buf = await file.arrayBuffer();
    return connectWith(new FileConnection(buf, file.name));
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
      const forces = await conn.getStationForces(beams.map(b => b.name), [...selCombos]);
      const built = buildMembers(beams, sections, materials, forces, seed);
      const builtById = new Map(built.map(m => [m.etabs?.frameName, m.id]));

      // Build modelMap from all beams geometry
      const uniqueStories = [...new Set(allBeams.map(b => b.story))].sort();
      const frames: MapFrame[] = allBeams.map(b => ({
        frameName: b.name,
        story: b.story,
        sectionName: b.section,
        pt1: b.pt1,
        pt2: b.pt2,
        memberId: builtById.get(b.name),
      }));
      const modelMap: ModelMap = {
        source,
        modelName: connInfo?.modelName ?? 'ETABS model',
        importedAt: new Date().toISOString(),
        stories: uniqueStories,
        frames,
      };
      setCapturedModelMap(modelMap);

      setDesignGroups(autoGroup(built));
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
    // refresh envelope load labels with the chosen combos before handing off
    const labeled = members.map(m => ({
      ...m,
      loads: [envelopeLoadCase(m.stationForces ?? [], `ETABS env (${[...selCombos].join(', ')})`)],
    }));
    onImport(labeled, designGroups, pickId, capturedModelMap ?? undefined);
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
                ['com', 'Active ETABS instance', 'Attach to the model currently open in ETABS via the CSI API (Windows desktop app)', !window.electronAPI?.etabs],
                ['file', 'ETABS tables file (.xlsx)', 'Workbook exported from ETABS with Beams / Sections / Materials / Forces sheets', false],
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
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{title}</div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{desc}</div>
                    {disabled && <div style={{ fontSize: 10, color: '#d97706', marginTop: 2 }}>Requires the Windows desktop app with ETABS running</div>}
                  </div>
                </label>
              ))}
              <input ref={fileInputRef} type="file" accept=".xlsx" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
              <button style={btn(true)} disabled={busy} onClick={handleConnect}>
                {busy ? 'Connecting…' : source === 'file' ? 'Choose file…' : 'Connect'}
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
                  <select style={{ ...inp, width: '100%' }} value={selStory}
                    onChange={e => { setSelStory(e.target.value); setMatchCount(null); }}>
                    <option value="">All stories</option>
                    {stories.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div style={card}>
                  <div style={lbl}>Beam sections (frame properties)</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {sections.map(s => (
                      <span key={s.name} style={chip(selSections.has(s.name))}
                        onClick={() => { setSelSections(prev => { const n = new Set(prev); if (n.has(s.name)) n.delete(s.name); else n.add(s.name); return n; }); setMatchCount(null); }}>
                        {s.name} <span style={{ opacity: 0.7 }}>({s.width}"×{s.depth}")</span>
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
                  <div style={lbl}>Load combinations to import</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {combos.map(c => (
                      <span key={c} style={chip(selCombos.has(c))}
                        onClick={() => setSelCombos(prev => { const n = new Set(prev); if (n.has(c)) n.delete(c); else n.add(c); return n; })}>
                        {c}
                      </span>
                    ))}
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
                        <td style={{ padding: '2px 16px 2px 0', color: '#6b7280' }}>{m.fc ? `f'c = ${m.fc / 1000} ksi` : ''}</td>
                        <td style={{ color: '#6b7280' }}>{m.fy ? `fy = ${m.fy / 1000} ksi` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
                <div style={lbl}>Stirrup spacing by zone — thirds of span (in)</div>
                <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                  {['End (0–L/3)', 'Middle (L/3–2L/3)', 'End (2L/3–L)'].map((zl, i) => (
                    <label key={zl} style={{ fontSize: 12, color: '#6b7280', display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {zl}
                      <input type="number" step={0.5} min={2} style={{ ...inp, width: 80 }}
                        value={seed.stirrupSpacings[i]}
                        onChange={e => setSeed(s => {
                          const sp = [...s.stirrupSpacings] as [number, number, number];
                          sp[i] = +e.target.value;
                          return { ...s, stirrupSpacings: sp };
                        })} />
                    </label>
                  ))}
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    Stirrup size
                    <select style={inp} value={seed.stirrupBarSize}
                      onChange={e => setSeed(s => ({ ...s, stirrupBarSize: +e.target.value }))}>
                      {[3, 4, 5].map(b => <option key={b} value={b}>#{b}</option>)}
                    </select>
                  </label>
                </div>
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '8px 0 0' }}>
                  Bar sizes/counts are auto-selected per section to meet the target steel area; you can edit any beam afterwards.
                </p>
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
                    <select style={inp} value={minDCR} onChange={e => setMinDCR(+e.target.value)}>
                      <option value={0}>all</option>
                      <option value={0.7}>0.70</option>
                      <option value={0.9}>0.90</option>
                      <option value={1.0}>1.00 (failing)</option>
                    </select>
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
