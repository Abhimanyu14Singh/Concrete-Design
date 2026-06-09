import { useState } from 'react';
import type { Project, Member } from './types';
import { defaultProject } from './utils/sampleData';
import Dashboard from './components/Dashboard/Dashboard';
import MemberResults from './components/Results/MemberResults';
import MemberEditor from './components/SectionInput/MemberEditor';

type Tab = 'dashboard' | 'results' | 'editor';

export default function App() {
  const [project, setProject] = useState<Project>(defaultProject);
  const [activeMemberId, setActiveMemberId] = useState<string>(project.members[0].id);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const activeMember = project.members.find(m => m.id === activeMemberId) ?? project.members[0];

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
    { key: 'results', label: 'Results' },
    { key: 'editor', label: 'Input' },
  ];

  return (
    <div className="flex h-screen bg-gray-950 text-white overflow-hidden" style={{ fontFamily: 'system-ui, sans-serif' }}>
      {/* Sidebar */}
      <aside style={{ width: sidebarOpen ? 220 : 48, transition: 'width 0.2s', flexShrink: 0 }}
        className="bg-gray-900 border-r border-gray-800 flex flex-col overflow-hidden">
        {/* Logo */}
        <div className="flex items-center gap-2 px-3 py-4 border-b border-gray-800">
          <div style={{ width: 28, height: 28, background: '#2563eb', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 'bold', flexShrink: 0 }}>
            SC
          </div>
          {sidebarOpen && (
            <div style={{ overflow: 'hidden' }}>
              <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap' }}>S-Concrete</div>
              <div style={{ color: '#64748b', fontSize: 10, whiteSpace: 'nowrap' }}>ACI 318-19</div>
            </div>
          )}
          <button onClick={() => setSidebarOpen(o => !o)} style={{ marginLeft: 'auto', color: '#64748b', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer' }}>
            {sidebarOpen ? '◀' : '▶'}
          </button>
        </div>

        {/* Members list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {sidebarOpen && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 12px 6px' }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 1 }}>Members</span>
              <button onClick={addMember} style={{ color: '#60a5fa', fontSize: 18, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }}>+</button>
            </div>
          )}
          {project.members.map(m => (
            <button
              key={m.id}
              onClick={() => handleSelectMember(m.id)}
              style={{
                width: '100%', textAlign: 'left', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8,
                background: activeMemberId === m.id ? 'rgba(37,99,235,0.2)' : 'none',
                borderRight: activeMemberId === m.id ? '3px solid #3b82f6' : '3px solid transparent',
                border: 'none', cursor: 'pointer', color: 'white',
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 700, flexShrink: 0, color: '#60a5fa' }}>
                {m.id}
              </span>
              {sidebarOpen && (
                <span style={{ fontSize: 11, color: '#cbd5e1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {m.label.length > 16 ? m.label.slice(0, 16) + '…' : m.label}
                </span>
              )}
            </button>
          ))}
          {sidebarOpen && (
            <button onClick={addMember} style={{ width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#475569', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', gap: 6 }}>
              <span>+</span><span>Add Member</span>
            </button>
          )}
        </div>

        {sidebarOpen && (
          <div style={{ padding: '12px', borderTop: '1px solid #1e293b' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#60a5fa' }} />
              <span style={{ fontSize: 10, color: '#64748b' }}>Beam</span>
            </div>
          </div>
        )}
      </aside>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top bar */}
        <header style={{ background: '#0f172a', borderBottom: '1px solid #1e293b', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {tabs.map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                style={{
                  padding: '6px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer',
                  background: tab === t.key ? '#2563eb' : 'transparent',
                  color: tab === t.key ? 'white' : '#64748b',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          {tab !== 'dashboard' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: '#64748b' }}>Member:</span>
              <select
                value={activeMemberId}
                onChange={e => setActiveMemberId(e.target.value)}
                style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6, padding: '4px 8px', fontSize: 12, color: 'white' }}
              >
                {project.members.map(m => (
                  <option key={m.id} value={m.id}>{m.id} — {m.label}</option>
                ))}
              </select>
            </div>
          )}
          <div style={{ fontSize: 11, color: '#64748b' }}>{project.name}</div>
          <div style={{ fontSize: 11, background: 'rgba(37,99,235,0.2)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.3)', borderRadius: 6, padding: '2px 8px', fontWeight: 700 }}>
            {project.code}
          </div>
        </header>

        {/* Content */}
        <main style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {tab === 'dashboard' && (
            <Dashboard project={project} onSelectMember={handleSelectMember} />
          )}
          {tab === 'results' && (
            <div>
              <div style={{ marginBottom: 12 }}>
                <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{activeMember.label}</h2>
                <p style={{ fontSize: 11, color: '#64748b', margin: '4px 0 0' }}>
                  {activeMember.section.type.replace(/_/g, ' ')} &bull;{' '}
                  {`${activeMember.section.b}" × ${activeMember.section.h}"`} &bull;{' '}
                  f'c = {activeMember.material.fc} psi &bull; fy = {activeMember.material.fy / 1000} ksi
                </p>
              </div>
              <MemberResults member={activeMember} />
            </div>
          )}
          {tab === 'editor' && (
            <div style={{ maxWidth: 640 }}>
              <div style={{ marginBottom: 12 }}>
                <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Member Input</h2>
                <p style={{ fontSize: 11, color: '#64748b', margin: '4px 0 0' }}>Edit geometry, materials, reinforcement, and loads</p>
              </div>
              <MemberEditor
                key={activeMember.id}
                member={activeMember}
                onUpdate={handleUpdateMember}
              />
              <div style={{ marginTop: 16 }}>
                <button
                  onClick={() => setTab('results')}
                  style={{ background: '#2563eb', color: 'white', padding: '8px 24px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer' }}
                >
                  Run Design Check →
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
