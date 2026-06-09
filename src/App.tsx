import { useState, useEffect } from 'react';
import type { Project, Member } from './types';
import { defaultProject } from './utils/sampleData';
import { saveProject, openProject } from './utils/electronBridge';
import Dashboard from './components/Dashboard/Dashboard';
import MemberResults from './components/Results/MemberResults';
import MemberEditor from './components/SectionInput/MemberEditor';

type Tab = 'dashboard' | 'results' | 'editor';

const hdrBtn: React.CSSProperties = {
  padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6,
  background: 'white', fontSize: 12, cursor: 'pointer', color: '#374151', fontWeight: 600,
};

export default function App() {
  const [project, setProject] = useState<Project>(defaultProject);
  const [activeMemberId, setActiveMemberId] = useState<string>(project.members[0].id);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [zoom, setZoom] = useState<number>(() => {
    const s = localStorage.getItem('sc-zoom');
    return s ? parseFloat(s) : 1.0;
  });
  const [showPrefs, setShowPrefs] = useState(false);

  const activeMember = project.members.find(m => m.id === activeMemberId) ?? project.members[0];

  // ── File handlers ──────────────────────────────────────────────────────────

  async function handleSave() {
    await saveProject(project);
  }

  async function handleOpen() {
    try {
      const loaded = await openProject();
      if (!loaded) return;
      setProject(loaded);
      setActiveMemberId(loaded.members[0]?.id ?? '');
      setTab('dashboard');
    } catch { /* user cancelled or file was invalid */ }
  }

  function handleNewProject() {
    if (!confirm('Start a new project? Unsaved changes will be lost.')) return;
    setProject(defaultProject);
    setActiveMemberId(defaultProject.members[0].id);
    setTab('dashboard');
  }

  function changeZoom(z: number) {
    setZoom(z);
    localStorage.setItem('sc-zoom', String(z));
    setShowPrefs(false);
  }

  // ── Keyboard shortcuts (re-bind when project changes so handler is fresh) ──
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 's') { e.preventDefault(); handleSave(); }
      if (e.key === 'o') { e.preventDefault(); handleOpen(); }
      if (e.key === 'n') { e.preventDefault(); handleNewProject(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project]);

  // ── Electron menu → renderer events ───────────────────────────────────────
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    api.onTriggerSave(handleSave);
    api.onTriggerOpen(handleOpen);
    api.onNewProject(handleNewProject);
    return () => {
      api.offTriggerSave(handleSave);
      api.offTriggerOpen(handleOpen);
      api.offNewProject(handleNewProject);
    };
  }, [project]);

  // ── Click outside to close prefs popover ──────────────────────────────────
  useEffect(() => {
    if (!showPrefs) return;
    function close(e: MouseEvent) {
      if (!(e.target as Element).closest('[data-prefs]')) setShowPrefs(false);
    }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showPrefs]);

  // ── Member helpers ─────────────────────────────────────────────────────────

  function handleSelectMember(id: string) {
    setActiveMemberId(id);
    setTab('results');
  }

  function handleUpdateMember(updated: Member) {
    setProject(p => ({
      ...p,
      members: p.members.map(m => m.id === updated.id ? updated : m),
    }));
  }

  function addMember() {
    const id = `M${project.members.length + 1}`;
    const newMember: Member = {
      id,
      label: `New Member ${id}`,
      memberType: 'beam',
      span: 20,
      material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1.0 },
      section: { type: 'rectangular_beam', b: 14, h: 22, coverClear: 1.5, stirrupDia: 4 },
      rebar: {
        topBars: [{ numBars: 3, barSize: 7 }],
        botBars: [{ numBars: 3, barSize: 7 }],
        ties: { barSize: 4, spacing: 6, legs: 2 },
      },
      loads: [
        { id: '1.2D+1.6L', label: '1.2D + 1.6L', Mu_pos: 100, Mu_neg: 80, Vu: 45, Tu: 0, Pu: 0 },
      ],
    };
    setProject(p => ({ ...p, members: [...p.members, newMember] }));
    setActiveMemberId(id);
    setTab('editor');
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'results',   label: 'Results'   },
    { key: 'editor',    label: 'Input'     },
  ];

  const sectionLabel = (m: Member) => {
    const s = m.section;
    if (s.type === 'circular_column') return `Ø${s.diameter ?? s.b}"`;
    return `${s.b}" × ${s.h}"`;
  };

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#f3f4f6', fontFamily: 'system-ui, sans-serif', overflow: 'hidden' }}>
      {/* Sidebar */}
      <aside style={{ width: sidebarOpen ? 220 : 48, transition: 'width 0.2s', flexShrink: 0, background: 'white', borderRight: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px', borderBottom: '1px solid #e5e7eb' }}>
          <div style={{ width: 28, height: 28, background: '#2563eb', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 'bold', color: 'white', flexShrink: 0 }}>
            SC
          </div>
          {sidebarOpen && (
            <div style={{ overflow: 'hidden' }}>
              <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', color: '#111827' }}>S-Concrete</div>
              <div style={{ color: '#9ca3af', fontSize: 10, whiteSpace: 'nowrap' }}>ACI 318-19</div>
            </div>
          )}
          <button onClick={() => setSidebarOpen(o => !o)} style={{ marginLeft: 'auto', color: '#9ca3af', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer' }}>
            {sidebarOpen ? '◀' : '▶'}
          </button>
        </div>

        {/* Members list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {sidebarOpen && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 12px 6px' }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1 }}>Members</span>
              <button onClick={addMember} style={{ color: '#2563eb', fontSize: 18, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }}>+</button>
            </div>
          )}
          {project.members.map(m => (
            <button
              key={m.id}
              onClick={() => handleSelectMember(m.id)}
              style={{
                width: '100%', textAlign: 'left', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8,
                background: activeMemberId === m.id ? '#eff6ff' : 'none',
                borderRight: `3px solid ${activeMemberId === m.id ? '#2563eb' : 'transparent'}`,
                border: 'none', borderLeft: 'none', borderTop: 'none', borderBottom: 'none',
                cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 700, flexShrink: 0, color: m.memberType === 'column' ? '#7c3aed' : m.memberType === 'wall' ? '#059669' : '#2563eb' }}>
                {m.id}
              </span>
              {sidebarOpen && (
                <span style={{ fontSize: 11, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {m.label.length > 16 ? m.label.slice(0, 16) + '…' : m.label}
                </span>
              )}
            </button>
          ))}
          {sidebarOpen && (
            <button onClick={addMember} style={{ width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', gap: 6 }}>
              <span>+</span><span>Add Member</span>
            </button>
          )}
        </div>

        {sidebarOpen && (
          <div style={{ padding: '10px 12px', borderTop: '1px solid #e5e7eb' }}>
            {[['Beam', '#2563eb'], ['Column', '#7c3aed'], ['Wall', '#059669']].map(([t, c]) => (
              <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />
                <span style={{ fontSize: 10, color: '#9ca3af' }}>{t}</span>
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top bar */}
        <header style={{ background: 'white', borderBottom: '1px solid #e5e7eb', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {/* View tabs */}
          <div style={{ display: 'flex', gap: 4 }}>
            {tabs.map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                style={{
                  padding: '6px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer',
                  background: tab === t.key ? '#2563eb' : 'transparent',
                  color: tab === t.key ? 'white' : '#6b7280',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div style={{ flex: 1 }} />

          {/* Member selector */}
          {tab !== 'dashboard' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>Member:</span>
              <select
                value={activeMemberId}
                onChange={e => setActiveMemberId(e.target.value)}
                style={{ background: 'white', border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 8px', fontSize: 12, color: '#111827' }}
              >
                {project.members.map(m => (
                  <option key={m.id} value={m.id}>{m.id} — {m.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Separator */}
          <div style={{ width: 1, height: 20, background: '#e5e7eb' }} />

          {/* File actions */}
          <button onClick={handleNewProject} style={hdrBtn} title="New project (Ctrl+N)">New</button>
          <button onClick={handleOpen}       style={hdrBtn} title="Open project (Ctrl+O)">Open</button>
          <button onClick={handleSave}       style={hdrBtn} title="Save project (Ctrl+S)">Save</button>

          {/* Preferences */}
          <div data-prefs="" style={{ position: 'relative' }}>
            <button
              onClick={() => setShowPrefs(v => !v)}
              style={{ ...hdrBtn, background: showPrefs ? '#eff6ff' : 'white', color: showPrefs ? '#2563eb' : '#374151' }}
              title="Preferences"
            >
              ⚙
            </button>
            {showPrefs && (
              <div style={{
                position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 200,
                background: 'white', border: '1px solid #e5e7eb', borderRadius: 10,
                boxShadow: '0 8px 24px rgba(0,0,0,0.1)', padding: '12px 8px', minWidth: 190,
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, padding: '0 8px', marginBottom: 8 }}>
                  Display Scale
                </div>
                {[0.75, 0.9, 1.0, 1.1, 1.25, 1.5].map(z => (
                  <button
                    key={z}
                    onClick={() => changeZoom(z)}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      width: '100%', padding: '6px 10px', border: 'none', borderRadius: 6,
                      cursor: 'pointer', fontSize: 13, textAlign: 'left',
                      background: zoom === z ? '#eff6ff' : 'none',
                      color: zoom === z ? '#2563eb' : '#374151',
                      fontWeight: zoom === z ? 700 : 400,
                    }}
                  >
                    <span>{z === 1.0 ? '100%  (default)' : `${Math.round(z * 100)}%`}</span>
                    {zoom === z && <span style={{ fontSize: 11 }}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Project info */}
          <div style={{ fontSize: 11, color: '#6b7280' }}>{project.name}</div>
          <div style={{ fontSize: 11, background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 6, padding: '2px 8px', fontWeight: 700 }}>
            {project.code}
          </div>
        </header>

        {/* Content — wrapped in a scale container */}
        <main style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
          <div style={{
            transform: `scale(${zoom})`,
            transformOrigin: 'top left',
            width: `${100 / zoom}%`,
            minHeight: `${100 / zoom}%`,
            padding: 16,
          }}>
            {tab === 'dashboard' && (
              <Dashboard project={project} onSelectMember={handleSelectMember} />
            )}
            {tab === 'results' && (
              <div>
                <div style={{ marginBottom: 12 }}>
                  <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: '#111827' }}>{activeMember.label}</h2>
                  <p style={{ fontSize: 11, color: '#6b7280', margin: '4px 0 0' }}>
                    {activeMember.section.type.replace(/_/g, ' ')} &bull; {sectionLabel(activeMember)} &bull;
                    f'c = {activeMember.material.fc} psi &bull; fy = {activeMember.material.fy / 1000} ksi
                  </p>
                </div>
                <MemberResults
                  member={activeMember}
                  onRebarChange={handleUpdateMember}
                />
              </div>
            )}
            {tab === 'editor' && (
              <div style={{ maxWidth: 560 }}>
                <div style={{ marginBottom: 12 }}>
                  <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: '#111827' }}>Member Input</h2>
                  <p style={{ fontSize: 11, color: '#6b7280', margin: '4px 0 0' }}>Edit geometry, materials, reinforcement, and loads</p>
                </div>
                <MemberEditor
                  key={activeMember.id}
                  member={activeMember}
                  onUpdate={handleUpdateMember}
                />
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
