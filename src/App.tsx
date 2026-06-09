import { useState } from 'react';
import type { Project, Member } from './types';
import { defaultProject } from './utils/sampleData';
import { saveProject, openProject } from './utils/electronBridge';
import Dashboard from './components/Dashboard/Dashboard';
import DesignView from './components/DesignView';
import ExportModal from './components/ExportModal';

type Tab = 'dashboard' | 'design';

const LOGO: React.CSSProperties = {
  width: 30, height: 30, background: 'linear-gradient(135deg,#1d4ed8,#6d28d9)',
  borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 10, fontWeight: 800, color: 'white', letterSpacing: 0.5, flexShrink: 0,
};

const BTN: React.CSSProperties = {
  background: 'none', border: '1px solid #1e293b', borderRadius: 6, color: '#94a3b8',
  cursor: 'pointer', fontSize: 11, padding: '4px 10px', fontWeight: 600,
};

export default function App() {
  const [project, setProject] = useState<Project>(defaultProject);
  const [activeMemberId, setActiveMemberId] = useState(project.members[0].id);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showExport, setShowExport] = useState(false);

  const activeMember = project.members.find(m => m.id === activeMemberId) ?? project.members[0];

  function handleSelectMember(id: string) { setActiveMemberId(id); setTab('design'); }

  function handleUpdateMember(updated: Member) {
    setProject(p => ({ ...p, members: p.members.map(m => m.id === updated.id ? updated : m) }));
  }

  function addMember() {
    const id = `M${project.members.length + 1}`;
    const m: Member = {
      id, label: `Beam ${id}`, memberType: 'beam', span: 20,
      material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 },
      section: { type: 'rectangular_beam', b: 14, h: 22, coverClear: 1.5, stirrupDia: 4 },
      rebar: {
        topBars: [{ numBars: 3, barSize: 7 }],
        botBars: [{ numBars: 3, barSize: 7 }],
        ties: { barSize: 4, spacing: 6, legs: 2 },
      },
      loads: [{ id: '1.2D+1.6L', label: '1.2D+1.6L', Mu_pos: 100, Mu_neg: 80, Vu: 45, Tu: 0, Pu: 0 }],
    };
    setProject(p => ({ ...p, members: [...p.members, m] }));
    setActiveMemberId(id);
    setTab('design');
  }

  async function handleOpen() {
    try {
      const loaded = await openProject();
      if (loaded) { setProject(loaded); setActiveMemberId(loaded.members[0]?.id ?? ''); setTab('dashboard'); }
    } catch { /* user cancelled */ }
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'design',    label: 'Member Design' },
  ];

  function handleNew() {
    if (confirm('Start a new project? Unsaved changes will be lost.')) {
      setProject({ ...defaultProject, id: `proj-${Date.now()}`, name: 'New Project', date: new Date().toISOString().slice(0, 10) });
      setTab('dashboard');
    }
  }

  const memberTypeColor = (t: string) =>
    t === 'column' ? '#c084fc' : t === 'wall' ? '#4ade80' : '#60a5fa';

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#020817', color: '#e2e8f0', overflow: 'hidden', fontFamily: 'system-ui,sans-serif' }}>

      {/* Sidebar */}
      <aside style={{
        width: sidebarOpen ? 200 : 44, flexShrink: 0, transition: 'width 0.18s ease',
        background: '#0a1628', borderRight: '1px solid #1e293b',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 10px', borderBottom: '1px solid #1e293b' }}>
          <div style={LOGO}>SC</div>
          {sidebarOpen && (
            <div style={{ overflow: 'hidden' }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: '#f1f5f9', whiteSpace: 'nowrap' }}>S-Concrete</div>
              <div style={{ fontSize: 10, color: '#475569', whiteSpace: 'nowrap' }}>ACI 318-19</div>
            </div>
          )}
          <button onClick={() => setSidebarOpen(o => !o)}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 11 }}>
            {sidebarOpen ? '◀' : '▶'}
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
          {sidebarOpen && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 10px 4px' }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: 1 }}>Members</span>
              <button onClick={addMember} style={{ background: 'none', border: 'none', color: '#3b82f6', fontSize: 18, lineHeight: 1, cursor: 'pointer' }}>+</button>
            </div>
          )}
          {project.members.map(m => {
            const active = activeMemberId === m.id && tab === 'design';
            return (
              <button key={m.id} onClick={() => handleSelectMember(m.id)}
                style={{
                  width: '100%', textAlign: 'left', padding: sidebarOpen ? '7px 10px' : '8px 0',
                  justifyContent: sidebarOpen ? 'flex-start' : 'center',
                  display: 'flex', alignItems: 'center', gap: 8, border: 'none',
                  borderRight: active ? '2px solid #3b82f6' : '2px solid transparent',
                  background: active ? 'rgba(59,130,246,0.08)' : 'transparent',
                  cursor: 'pointer',
                } as React.CSSProperties}>
                <span style={{ fontSize: 11, fontWeight: 700, color: memberTypeColor(m.memberType), flexShrink: 0, minWidth: 24, textAlign: 'center' }}>
                  {m.id}
                </span>
                {sidebarOpen && (
                  <span style={{ fontSize: 11, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.label.length > 18 ? m.label.slice(0, 18) + '…' : m.label}
                  </span>
                )}
              </button>
            );
          })}
          {sidebarOpen && (
            <button onClick={addMember}
              style={{ width: '100%', textAlign: 'left', padding: '7px 10px', display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', color: '#334155', cursor: 'pointer', fontSize: 11 }}>
              <span style={{ color: '#3b82f6', fontSize: 14 }}>+</span> Add member
            </button>
          )}
        </div>

        {sidebarOpen && (
          <div style={{ borderTop: '1px solid #1e293b', padding: '10px' }}>
            {[['Beam', '#60a5fa'], ['Column', '#c084fc'], ['Wall', '#4ade80']].map(([label, color]) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
                <span style={{ fontSize: 10, color: '#475569' }}>{label}</span>
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <header style={{
          height: 44, background: '#0a1628', borderBottom: '1px solid #1e293b',
          display: 'flex', alignItems: 'center', padding: '0 12px', gap: 6, flexShrink: 0,
        }}>
          {/* File buttons */}
          <button style={BTN} onClick={handleNew} title="New project">New</button>
          <button style={BTN} onClick={handleOpen} title="Open .scdb file">Open</button>
          <button style={BTN} onClick={() => saveProject(project)} title="Save project">Save</button>
          <div style={{ width: 1, height: 20, background: '#1e293b', margin: '0 4px' }} />

          {/* Tabs */}
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{
                padding: '5px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                border: 'none', cursor: 'pointer',
                background: tab === t.key ? '#1d4ed8' : 'transparent',
                color: tab === t.key ? 'white' : '#475569',
              }}>
              {t.label}
            </button>
          ))}

          <div style={{ flex: 1 }} />

          {/* Member selector (Design tab) */}
          {tab === 'design' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: '#475569' }}>Member</span>
              <select value={activeMemberId} onChange={e => setActiveMemberId(e.target.value)}
                style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 5, padding: '3px 6px', fontSize: 11, color: '#e2e8f0', outline: 'none' }}>
                {project.members.map(m => (
                  <option key={m.id} value={m.id}>{m.id} — {m.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Export */}
          <button
            onClick={() => setShowExport(true)}
            style={{ ...BTN, color: '#a78bfa', borderColor: 'rgba(109,40,217,0.4)', background: 'rgba(109,40,217,0.08)' }}>
            Export ↗
          </button>

          <span style={{ fontSize: 10, color: '#334155' }}>{project.name}</span>
          <span style={{ fontSize: 10, background: 'rgba(29,78,216,0.2)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.25)', borderRadius: 4, padding: '2px 6px', fontWeight: 700 }}>
            {project.code}
          </span>
        </header>

        {/* Content */}
        <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {tab === 'dashboard' && (
            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
              <Dashboard project={project} onSelectMember={handleSelectMember} />
            </div>
          )}
          {tab === 'design' && (
            <DesignView member={activeMember} onUpdate={handleUpdateMember} />
          )}
        </main>
      </div>

      {showExport && <ExportModal project={project} onClose={() => setShowExport(false)} />}
    </div>
  );
}
