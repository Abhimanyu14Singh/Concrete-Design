/**
 * ColumnStacksPanel — read-only multi-story view of the model's columns. Each
 * vertical stack (one plan location, many floors) is shown bottom → top with its
 * per-story axial demand, provided ρ, φPn,max and governing DCR, plus a compact
 * demand-vs-capacity utilization bar. Mirrors Column_Design_DW's stack tables.
 *
 * Stacks are derived on the fly from the members (no persisted stack model).
 */
import { useMemo } from 'react';
import type { Member, DesignCode } from '../../types';
import { buildColumnStacks, type StoryColumn } from '../../utils/columnStack';

interface Props { members: Member[]; code: DesignCode }

const dcrColor = (dcr: number): string =>
  dcr > 1 ? '#dc2626' : dcr > 0.9 ? '#d97706' : '#16a34a';

const cardStyle: React.CSSProperties = {
  background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 12px', marginBottom: 10,
};

function sectionLabel(s: StoryColumn): string {
  return s.circular ? `Ø${s.diameter}"` : `${s.b}×${s.h}"`;
}

/** Demand-vs-capacity bar: fill = Pu / φPn,max, colored by DCR. */
function UtilBar({ frac, dcr }: { frac: number; dcr: number }) {
  const pct = Math.max(0, Math.min(1, frac)) * 100;
  return (
    <div style={{ position: 'relative', height: 10, background: '#f3f4f6', borderRadius: 5, overflow: 'hidden', minWidth: 60 }}>
      <div style={{ position: 'absolute', inset: 0, width: `${pct}%`, background: dcrColor(dcr), opacity: 0.85 }} />
    </div>
  );
}

export default function ColumnStacksPanel({ members, code }: Props) {
  const stacks = useMemo(() => buildColumnStacks(members, code), [members, code]);

  if (stacks.length === 0) {
    return (
      <div style={{ padding: '14px', fontSize: 12, color: '#9ca3af' }}>
        No multi-story column stacks found. Import columns from an ETABS model (so they carry plan
        coordinates), or add column members with loads, to see stacks here.
      </div>
    );
  }

  return (
    <div style={{ padding: '12px 14px' }}>
      <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 8 }}>
        {stacks.length} stack{stacks.length !== 1 ? 's' : ''} · ordered bottom → top · axial demand vs φPn,max
      </div>
      {stacks.map(stack => {
        const govDcr = Math.max(...stack.stories.map(s => s.dcrGov), 0);
        return (
          <div key={stack.key} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: '#374151' }}>{stack.label}</div>
              <div style={{ fontSize: 10, color: '#9ca3af' }}>{stack.stories.length} stories</div>
              <span style={{
                marginLeft: 'auto', fontSize: 10, fontWeight: 700, fontFamily: 'monospace',
                color: dcrColor(govDcr), background: '#f9fafb', border: '1px solid #e5e7eb',
                borderRadius: 4, padding: '1px 6px',
              }}>
                max DCR {govDcr.toFixed(2)}
              </span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ color: '#9ca3af', textAlign: 'right' }}>
                  <th style={{ textAlign: 'left', fontWeight: 600, padding: '2px 4px' }}>Story</th>
                  <th style={{ fontWeight: 600, padding: '2px 4px' }}>Elev</th>
                  <th style={{ fontWeight: 600, padding: '2px 4px' }}>Section</th>
                  <th style={{ fontWeight: 600, padding: '2px 4px' }}>Pu</th>
                  <th style={{ fontWeight: 600, padding: '2px 4px' }}>ρ%</th>
                  <th style={{ fontWeight: 600, padding: '2px 4px' }}>φPn,max</th>
                  <th style={{ fontWeight: 600, padding: '2px 4px', minWidth: 64 }}>Util</th>
                  <th style={{ fontWeight: 600, padding: '2px 4px' }}>DCR</th>
                </tr>
              </thead>
              <tbody style={{ fontFamily: 'monospace', color: '#374151' }}>
                {/* top story first for a natural elevation view */}
                {[...stack.stories].reverse().map(s => {
                  const frac = s.phiPnMax > 0 ? s.PuGov / s.phiPnMax : 0;
                  return (
                    <tr key={s.memberId} style={{ borderTop: '1px solid #f3f4f6', textAlign: 'right' }}>
                      <td style={{ textAlign: 'left', padding: '3px 4px' }}>{s.story}</td>
                      <td style={{ padding: '3px 4px' }}>{s.elevation.toFixed(0)}'</td>
                      <td style={{ padding: '3px 4px' }}>{sectionLabel(s)}</td>
                      <td style={{ padding: '3px 4px' }}>{s.PuGov.toFixed(0)}</td>
                      <td style={{ padding: '3px 4px' }}>{(s.rho * 100).toFixed(2)}</td>
                      <td style={{ padding: '3px 4px' }}>{s.phiPnMax.toFixed(0)}</td>
                      <td style={{ padding: '3px 4px' }}><UtilBar frac={frac} dcr={s.dcrGov} /></td>
                      <td style={{ padding: '3px 4px', color: dcrColor(s.dcrGov), fontWeight: 700 }}>{s.dcrGov.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
