import { useState } from 'react';
import type { Member, DesignCode } from '../../types';
import { generateBreakdown } from '../../utils/calcBreakdown';
import { generateBreakdownEC2 } from '../../utils/calcBreakdownEC2';
import { zoneShearDemands } from '../../adapters/etabs';
import { resolveCrack } from '../../utils/resolveCrack';
import type { CalcSection } from '../../utils/calcBreakdown';
import { useUnits } from '../../contexts/UnitsContext';
import { Icon } from '../common/Icon';
import { PMChart, BiaxialChart } from './InteractionChart';
import { beamAxialFlexure } from '../../utils/axialFlexure';
import { biaxialCheck } from '../../utils/biaxial';
import { computeFlexure, getBarArea } from '../../utils/concreteDesign';
import { ACCENT, BORDER, ICON, INK, MONO_NUM, STATUS, SURFACE, TRACK } from '../../theme';

interface Props {
  member: Member;
  loadId: string;
  code?: DesignCode;
  /** Project-level EC2 SLS quasi-permanent combo name (drives §7.3.4 M_qp). */
  slsCombo?: string;
  /** Project-level EC2 §6.2.3 strut angle cotθ (default 2.5). */
  cotTheta?: number;
  onClose: () => void;
}

export default function CalcBreakdownModal({ member, loadId, code = 'ACI318-19', slsCombo, cotTheta, onClose }: Props) {
  const { fmt } = useUnits();
  const load = member.loads.find(l => l.id === loadId) ?? member.loads[0];
  const isEC2 = code === 'EN1992-1-1';
  // Resolve crack params so the §7.3.4 sheet uses the selected SLS combo's
  // moments (Mqp_pos/Mqp_neg) — same resolution the on-screen design path uses.
  const crackParams = isEC2 ? resolveCrack(member, code, slsCombo) : member.crackParams;
  const sections: CalcSection[] = (isEC2
        ? generateBreakdownEC2(member.section, member.material, member.rebar, load, member.span, crackParams, slsCombo, cotTheta ?? 2.5)
        : generateBreakdown(
            member.section, member.material, member.rebar, load, member.span,
            member.rebar.tieZones && member.stationForces?.length
              ? zoneShearDemands(member.stationForces, member.span ?? 20)
              : undefined,
          ));

  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(sections.map(s => s.title))
  );
  // Which chart the header icon opened, if any.
  const [chartFor, setChartFor] = useState<'pm' | 'biaxial' | null>(null);

  // Chart inputs, from the SAME routines the sheet's numbers came from — so the
  // picture and the utilisation printed beside it cannot drift apart.
  const areaOf = (g?: { numBars: number; barSize: number }[]) =>
    (g ?? []).reduce((t, x) => t + x.numBars * getBarArea(x.barSize), 0);
  const flex0 = computeFlexure(
    member.section, member.material, areaOf(member.rebar.topBars), areaOf(member.rebar.botBars),
    member.span ?? 20, member.rebar.topBars?.[0]?.barSize ?? 8, member.rebar.botBars?.[0]?.barSize ?? 8,
    member.rebar.topBars, member.rebar.botBars, member.rebar.layerClearSpacing ?? 1.0,
  );
  const pmForChart = load.Pu !== 0
    ? beamAxialFlexure(member.section, member.material, member.rebar, member.span ?? 20, 'pos', flex0.phi_Mn_pos, load.Pu, load.Mu_pos)
    : undefined;
  const biaxForChart = biaxialCheck(member.section, member.material, member.rebar, load, member.span ?? 20);

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
        background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 16,
        width: '100%', maxWidth: 860, maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: `1px solid ${BORDER.default}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0, background: SURFACE.subtle, borderRadius: '16px 16px 0 0',
        }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: INK.strong }}>
              Calculation Breakdown
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 11, color: INK.secondary }}>
              {member.label} &bull; Load case: <span style={{ color: ACCENT.primary, fontWeight: 600 }}>{load.label}</span> &bull; {isEC2 ? 'EN 1992-1-1' : code}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={() => setExpandedSections(new Set(sections.map(s => s.title)))}
              style={{ fontSize: 11, color: INK.secondary, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px' }}
            >
              Expand All
            </button>
            <button
              onClick={() => setExpandedSections(new Set())}
              style={{ fontSize: 11, color: INK.secondary, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px' }}
            >
              Collapse All
            </button>
            <button
              onClick={onClose}
              style={{
                background: 'white', border: `1px solid ${BORDER.strong}`, color: INK.base,
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
            background: ACCENT.softBg, border: `1px solid ${ACCENT.softBorder}`,
            borderRadius: 10, padding: '12px 16px', marginBottom: 16,
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8,
          }}>
            <>
                <LoadItem label="Mu⁺" value={fmt(load.Mu_pos, 'moment')} />
                <LoadItem label="Mu⁻" value={fmt(load.Mu_neg, 'moment')} />
                <LoadItem label="Vu" value={fmt(load.Vu, 'force')} />
                <LoadItem label="Tu" value={fmt(load.Tu, 'moment')} />
                {load.Pu !== 0 && <LoadItem label="Pu" value={fmt(load.Pu, 'force')} />}
              </>
          </div>

          {sections.map(section => (
            <div key={section.title} style={{ marginBottom: 12 }}>
              <button
                onClick={() => toggleSection(section.title)}
                style={{
                  width: '100%', textAlign: 'left', background: '#f3f4f6',
                  border: `1px solid ${BORDER.default}`, borderRadius: expandedSections.has(section.title) ? '8px 8px 0 0' : 8,
                  padding: '10px 14px', cursor: 'pointer', display: 'flex',
                  alignItems: 'center', justifyContent: 'space-between', color: INK.strong,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 700, color: INK.strong, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  {section.title}
                  {/* The chart hook. A span, not a button, because this sits INSIDE the
                      header button and nesting buttons is invalid HTML — the click is
                      stopped from reaching the collapse toggle instead. */}
                  {section.chart && (
                    <span
                      role="button" tabIndex={0} aria-label={section.chart.label} title={section.chart.label}
                      onClick={e => { e.stopPropagation(); setChartFor(section.chart!.kind); }}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); setChartFor(section.chart!.kind); } }}
                      style={{
                        display: 'inline-flex', alignItems: 'center', cursor: 'pointer',
                        color: ACCENT.primary, border: `1px solid ${ACCENT.primary}`,
                        borderRadius: 5, padding: '1px 5px', background: 'white',
                      }}
                    >
                      <Icon name="pmInteraction" size={ICON.sm} />
                    </span>
                  )}
                </span>
                <span style={{ fontSize: 12, color: INK.secondary }}>
                  {expandedSections.has(section.title) ? '▲' : '▼'} {section.steps.length} steps
                </span>
              </button>

              {expandedSections.has(section.title) && (
                <div style={{
                  border: `1px solid ${BORDER.default}`, borderTop: 'none',
                  borderRadius: '0 0 8px 8px', overflowX: 'auto', overflowY: 'hidden',
                }}>
                  <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: SURFACE.subtle }}>
                        {[isEC2 ? 'EC2 Ref' : 'ACI Ref', 'Description', 'Equation', 'Substitution', 'Result'].map(h => (
                          <th key={h} style={{
                            padding: '8px 12px', textAlign: 'left',
                            color: INK.secondary, fontWeight: 600, fontSize: 10,
                            textTransform: 'uppercase', letterSpacing: TRACK.wide,
                            borderBottom: `1px solid ${BORDER.default}`, whiteSpace: 'nowrap',
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
                              ? STATUS.failBg
                              : ok && step.result.includes('DCR')
                                ? STATUS.okBg
                                : i % 2 === 0 ? 'white' : SURFACE.subtle,
                            borderTop: '1px solid #f3f4f6',
                          }}>
                            <td style={{ padding: '8px 12px', color: ACCENT.primary, ...MONO_NUM, fontSize: 11, whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                              {step.ref}
                            </td>
                            <td style={{ padding: '8px 12px', color: INK.base, verticalAlign: 'top' }}>
                              <div style={{ fontWeight: 600, color: INK.strong, marginBottom: step.note ? 2 : 0 }}>{step.label}</div>
                              {step.note && <div style={{ fontSize: 10, color: ng ? STATUS.fail : ok ? STATUS.ok : INK.secondary, marginTop: 2 }}>{step.note}</div>}
                            </td>
                            <td style={{ padding: '8px 12px', ...MONO_NUM, color: '#7c3aed', verticalAlign: 'top', whiteSpace: 'pre-wrap' }}>
                              {step.equation}
                            </td>
                            <td style={{ padding: '8px 12px', ...MONO_NUM, color: INK.secondary, fontSize: 11, verticalAlign: 'top' }}>
                              {step.substitution}
                            </td>
                            <td style={{
                              padding: '8px 12px', ...MONO_NUM, fontWeight: 700,
                              color: ng ? STATUS.fail : ok && step.result.includes('DCR') ? STATUS.ok : INK.strong,
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

          <p style={{ fontSize: 10, color: INK.muted, marginTop: 16, textAlign: 'center' }}>
            {isEC2
              ? 'All calculations per EN 1992-1-1:2004 (Eurocode 2). Verify independently before use in production design.'
              : 'All calculations per ACI 318-19 Strength Design Method. Verify independently before use in production design.'}
          </p>
        </div>
      </div>

      {/* Chart overlay — above the sheet, dismissed by its own backdrop. Kept out
          of the sheet's flow so the printed breakdown is unchanged by whether a
          chart happens to be open. */}
      {chartFor && (
        <div
          onClick={e => { e.stopPropagation(); setChartFor(null); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(15,23,42,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}
        >
          <div onClick={e => e.stopPropagation()} style={{
            background: 'white', borderRadius: 14, padding: 16,
            boxShadow: '0 24px 64px rgba(15,23,42,0.35)', maxWidth: '95vw', maxHeight: '92vh', overflow: 'auto',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: INK.strong }}>
                {chartFor === 'pm' ? 'P–M interaction' : 'P–M–M interaction contour'}
              </span>
              <span style={{ fontSize: 11, color: INK.muted }}>{member.label} · {load.label}</span>
              <div style={{ flex: 1 }} />
              <button onClick={() => setChartFor(null)}
                style={{ background: 'white', border: `1px solid ${BORDER.strong}`, borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: INK.base, fontWeight: 600 }}>
                ✕ Close
              </button>
            </div>
            {chartFor === 'pm' && pmForChart && (
              <PMChart
                points={pmForChart.points}
                Pu={load.Pu} Mu={load.Mu_pos}
                phiPnAtRay={pmForChart.phiPnAtRay} phiMnAtRay={pmForChart.phiMnAtRay}
                util={pmForChart.nmUtil}
              />
            )}
            {chartFor === 'biaxial' && biaxForChart && (
              <BiaxialChart
                Mux={biaxForChart.Mux} Muy={biaxForChart.Muy}
                phiMnx={biaxForChart.phiMnx} phiMny={biaxForChart.phiMny}
                alpha={biaxForChart.alpha} util={biaxForChart.util}
              />
            )}
            <p style={{ fontSize: 10, color: INK.muted, margin: '8px 4px 0', maxWidth: 520 }}>
              {chartFor === 'pm'
                ? 'The φ-surface is the one the check walked — the dashed ray is the radial scaling to it, and the marker is the applied (Mu, Pu).'
                : 'Bresler load contour between the two uniaxial capacities at this Pu. Not an inclined-neutral-axis section analysis; see the sheet note.'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function LoadItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 10, color: INK.secondary, fontWeight: 600, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 13, color: ACCENT.primary, fontWeight: 700, ...MONO_NUM }}>{value}</div>
    </div>
  );
}
