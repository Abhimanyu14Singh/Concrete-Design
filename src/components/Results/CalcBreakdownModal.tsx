import { useState } from 'react';
import type { Member, DesignCode } from '../../types';
import { generateBreakdown } from '../../utils/calcBreakdown';
import { generateBreakdownEC2 } from '../../utils/calcBreakdownEC2';
import { generateColumnBreakdown } from '../../utils/calcBreakdownColumn';
import { generateColumnBreakdownEC2 } from '../../utils/calcBreakdownColumnEC2';
import { generateWallBreakdown } from '../../utils/calcBreakdownWall';
import type { CalcSection } from '../../utils/calcBreakdown';

interface Props {
  member: Member;
  loadId: string;
  code?: DesignCode;
  onClose: () => void;
}

export default function CalcBreakdownModal({ member, loadId, code = 'ACI318-19', onClose }: Props) {
  const load = member.loads.find(l => l.id === loadId) ?? member.loads[0];
  const isWall = member.memberType === 'wall' && !!member.wallRebar;
  const isColumn = member.section.type === 'rectangular_column' || member.section.type === 'circular_column';
  const isEC2 = code === 'EN1992-1-1';
  const sections: CalcSection[] = isWall
    ? generateWallBreakdown(member.section, member.material, member.wallRebar!, load)
    : isColumn
    ? (isEC2
        ? generateColumnBreakdownEC2(member.section, member.material, member.rebar, load)
        : generateColumnBreakdown(member.section, member.material, member.rebar, load))
    : (isEC2
        ? generateBreakdownEC2(member.section, member.material, member.rebar, load, member.span, member.crackParams)
        : generateBreakdown(member.section, member.material, member.rebar, load, member.span));

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
        background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '24px 16px', overflowY: 'auto',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'white', border: '1px solid #e5e7eb', borderRadius: 16,
        width: '100%', maxWidth: 860, maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid #e5e7eb',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0, background: '#f9fafb', borderRadius: '16px 16px 0 0',
        }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>
              Calculation Breakdown
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 11, color: '#6b7280' }}>
              {member.label} &bull; Load case: <span style={{ color: '#2563eb', fontWeight: 600 }}>{load.label}</span> &bull; {isWall ? 'ACI 318-25 Shear Wall' : isEC2 ? 'EN 1992-1-1' : code}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={() => setExpandedSections(new Set(sections.map(s => s.title)))}
              style={{ fontSize: 11, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px' }}
            >
              Expand All
            </button>
            <button
              onClick={() => setExpandedSections(new Set())}
              style={{ fontSize: 11, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px' }}
            >
              Collapse All
            </button>
            <button
              onClick={onClose}
              style={{
                background: 'white', border: '1px solid #d1d5db', color: '#374151',
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
            background: '#eff6ff', border: '1px solid #bfdbfe',
            borderRadius: 10, padding: '12px 16px', marginBottom: 16,
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8,
          }}>
            {isColumn ? (
              <>
                <LoadItem label="Pu" value={`${load.Pu} kips`} />
                <LoadItem label="Mux" value={`${load.Mux ?? 0} kip-ft`} />
                <LoadItem label="Muy" value={`${load.Muy ?? 0} kip-ft`} />
                <LoadItem label="Vu" value={`${load.Vu} kips`} />
              </>
            ) : (
              <>
                <LoadItem label="Mu⁺" value={`${load.Mu_pos} kip-ft`} />
                <LoadItem label="Mu⁻" value={`${load.Mu_neg} kip-ft`} />
                <LoadItem label="Vu" value={`${load.Vu} kips`} />
                <LoadItem label="Tu" value={`${load.Tu} kip-ft`} />
                {load.Pu !== 0 && <LoadItem label="Pu" value={`${load.Pu} kips`} />}
              </>
            )}
          </div>

          {sections.map(section => (
            <div key={section.title} style={{ marginBottom: 12 }}>
              <button
                onClick={() => toggleSection(section.title)}
                style={{
                  width: '100%', textAlign: 'left', background: '#f3f4f6',
                  border: '1px solid #e5e7eb', borderRadius: expandedSections.has(section.title) ? '8px 8px 0 0' : 8,
                  padding: '10px 14px', cursor: 'pointer', display: 'flex',
                  alignItems: 'center', justifyContent: 'space-between', color: '#111827',
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{section.title}</span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>
                  {expandedSections.has(section.title) ? '▲' : '▼'} {section.steps.length} steps
                </span>
              </button>

              {expandedSections.has(section.title) && (
                <div style={{
                  border: '1px solid #e5e7eb', borderTop: 'none',
                  borderRadius: '0 0 8px 8px', overflow: 'hidden',
                }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: '#f9fafb' }}>
                        {['ACI Ref', 'Description', 'Equation', 'Substitution', 'Result'].map(h => (
                          <th key={h} style={{
                            padding: '8px 12px', textAlign: 'left',
                            color: '#6b7280', fontWeight: 600, fontSize: 10,
                            textTransform: 'uppercase', letterSpacing: '0.05em',
                            borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap',
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
                              ? '#fef2f2'
                              : ok && step.result.includes('DCR')
                                ? '#f0fdf4'
                                : i % 2 === 0 ? 'white' : '#f9fafb',
                            borderTop: '1px solid #f3f4f6',
                          }}>
                            <td style={{ padding: '8px 12px', color: '#2563eb', fontFamily: 'monospace', fontSize: 11, whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                              {step.ref}
                            </td>
                            <td style={{ padding: '8px 12px', color: '#374151', verticalAlign: 'top' }}>
                              <div style={{ fontWeight: 600, color: '#111827', marginBottom: step.note ? 2 : 0 }}>{step.label}</div>
                              {step.note && <div style={{ fontSize: 10, color: ng ? '#dc2626' : ok ? '#16a34a' : '#6b7280', marginTop: 2 }}>{step.note}</div>}
                            </td>
                            <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: '#7c3aed', verticalAlign: 'top', whiteSpace: 'pre-wrap' }}>
                              {step.equation}
                            </td>
                            <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: '#6b7280', fontSize: 11, verticalAlign: 'top' }}>
                              {step.substitution}
                            </td>
                            <td style={{
                              padding: '8px 12px', fontFamily: 'monospace', fontWeight: 700,
                              color: ng ? '#dc2626' : ok && step.result.includes('DCR') ? '#16a34a' : '#111827',
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

          <p style={{ fontSize: 10, color: '#9ca3af', marginTop: 16, textAlign: 'center' }}>
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
      <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 14, color: '#2563eb', fontWeight: 700, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}
