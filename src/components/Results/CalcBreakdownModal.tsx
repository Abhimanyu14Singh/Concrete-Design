import { useState } from 'react';
import type { Member } from '../../types';
import { generateBreakdown } from '../../utils/calcBreakdown';
import type { CalcSection } from '../../utils/calcBreakdown';

interface Props {
  member: Member;
  loadId: string;
  onClose: () => void;
}

export default function CalcBreakdownModal({ member, loadId, onClose }: Props) {
  const load = member.loads.find(l => l.id === loadId) ?? member.loads[0];
  const sections: CalcSection[] = generateBreakdown(
    member.section, member.material, member.rebar, load, member.span
  );

  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(sections.map(s => s.title))
  );

  function toggleSection(title: string) {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title); else next.add(title);
      return next;
    });
  }

  const isNG = (result: string) => result.includes('✗');
  const isOK = (result: string) => result.includes('✓');

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '24px 16px', overflowY: 'auto',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: '#0f172a', border: '1px solid #1e293b', borderRadius: 16,
        width: '100%', maxWidth: 860, maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 25px 50px rgba(0,0,0,0.6)',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid #1e293b',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#f1f5f9' }}>
              Calculation Breakdown
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 11, color: '#64748b' }}>
              {member.label} &bull; Load case: <span style={{ color: '#60a5fa' }}>{load.label}</span> &bull; ACI 318-19
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={() => setExpandedSections(new Set(sections.map(s => s.title)))}
              style={{ fontSize: 11, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px' }}
            >
              Expand All
            </button>
            <button
              onClick={() => setExpandedSections(new Set())}
              style={{ fontSize: 11, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px' }}
            >
              Collapse All
            </button>
            <button
              onClick={onClose}
              style={{
                background: '#1e293b', border: '1px solid #334155', color: '#94a3b8',
                borderRadius: 8, padding: '6px 12px', fontSize: 13, cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              ✕ Close
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '16px 20px' }}>
          {/* Applied loads summary */}
          <div style={{
            background: 'rgba(37,99,235,0.1)', border: '1px solid rgba(59,130,246,0.3)',
            borderRadius: 10, padding: '12px 16px', marginBottom: 16,
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8,
          }}>
            <LoadItem label="Mu⁺" value={`${load.Mu_pos} kip-ft`} />
            <LoadItem label="Mu⁻" value={`${load.Mu_neg} kip-ft`} />
            <LoadItem label="Vu" value={`${load.Vu} kips`} />
            <LoadItem label="Tu" value={`${load.Tu} kip-ft`} />
            {load.Pu !== 0 && <LoadItem label="Pu" value={`${load.Pu} kips`} />}
          </div>

          {sections.map(section => (
            <div key={section.title} style={{ marginBottom: 12 }}>
              {/* Section header */}
              <button
                onClick={() => toggleSection(section.title)}
                style={{
                  width: '100%', textAlign: 'left', background: '#1e293b',
                  border: '1px solid #334155', borderRadius: expandedSections.has(section.title) ? '8px 8px 0 0' : 8,
                  padding: '10px 14px', cursor: 'pointer', display: 'flex',
                  alignItems: 'center', justifyContent: 'space-between', color: 'white',
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{section.title}</span>
                <span style={{ fontSize: 12, color: '#64748b' }}>
                  {expandedSections.has(section.title) ? '▲' : '▼'} {section.steps.length} steps
                </span>
              </button>

              {expandedSections.has(section.title) && (
                <div style={{
                  border: '1px solid #334155', borderTop: 'none',
                  borderRadius: '0 0 8px 8px', overflow: 'hidden',
                }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: '#0f172a' }}>
                        {['ACI Ref', 'Description', 'Equation', 'Substitution', 'Result'].map(h => (
                          <th key={h} style={{
                            padding: '8px 12px', textAlign: 'left',
                            color: '#475569', fontWeight: 600, fontSize: 10,
                            textTransform: 'uppercase', letterSpacing: '0.05em',
                            borderBottom: '1px solid #1e293b', whiteSpace: 'nowrap',
                          }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {section.steps.map((step, i) => {
                        const ng = isNG(step.result);
                        const ok = isOK(step.result);
                        return (
                          <tr key={i} style={{
                            background: ng
                              ? 'rgba(239,68,68,0.06)'
                              : ok && step.result.includes('DCR')
                                ? 'rgba(16,185,129,0.06)'
                                : i % 2 === 0 ? '#0f172a' : '#111827',
                            borderTop: '1px solid #1e293b',
                          }}>
                            <td style={{ padding: '8px 12px', color: '#60a5fa', fontFamily: 'monospace', fontSize: 11, whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                              {step.ref}
                            </td>
                            <td style={{ padding: '8px 12px', color: '#94a3b8', verticalAlign: 'top' }}>
                              <div style={{ fontWeight: 600, color: '#cbd5e1', marginBottom: step.note ? 2 : 0 }}>{step.label}</div>
                              {step.note && <div style={{ fontSize: 10, color: ng ? '#fca5a5' : ok ? '#6ee7b7' : '#64748b', marginTop: 2 }}>{step.note}</div>}
                            </td>
                            <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: '#a78bfa', verticalAlign: 'top', whiteSpace: 'pre-wrap' }}>
                              {step.equation}
                            </td>
                            <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: '#64748b', fontSize: 11, verticalAlign: 'top' }}>
                              {step.substitution}
                            </td>
                            <td style={{
                              padding: '8px 12px', fontFamily: 'monospace', fontWeight: 700,
                              color: ng ? '#f87171' : ok && step.result.includes('DCR') ? '#34d399' : '#f1f5f9',
                              verticalAlign: 'top', whiteSpace: 'nowrap',
                            }}>
                              {step.result}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}

          <p style={{ fontSize: 10, color: '#374151', marginTop: 16, textAlign: 'center' }}>
            All calculations per ACI 318-19 Strength Design Method. Verify independently before use in production design.
          </p>
        </div>
      </div>
    </div>
  );
}

function LoadItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 10, color: '#64748b', fontWeight: 600, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 14, color: '#60a5fa', fontWeight: 700, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}
