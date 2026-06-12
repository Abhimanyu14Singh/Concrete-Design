/**
 * SavingsPanel — shows DCR slack per group/member as potential rebar tonnage savings,
 * with a target-DCR slider and a consolidation advisor for adjacent bins.
 */
import { useState, useMemo } from 'react';
import type { Member, DesignResults, DesignGroup } from '../../types';
import { computeSavings, familyKey, steelWeightPerFt } from '../../utils/autoGroup';

interface SavingsPanelProps {
  members: Member[];
  resultsById: Record<string, DesignResults>;
  designGroups: DesignGroup[];
  onMergeGroups?: (keepId: string, removeId: string) => void;
  /** Project-level target DCR (persisted in .scdb). */
  targetDCR: number;
  onTargetDCRChange: (v: number) => void;
}

export default function SavingsPanel({
  members,
  resultsById,
  designGroups,
  onMergeGroups,
  targetDCR,
  onTargetDCRChange,
}: SavingsPanelProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  // Build memberId → groupId map
  const memberGroupId = useMemo(() => {
    const m: Record<string, string> = {};
    for (const g of designGroups) for (const mid of g.memberIds) m[mid] = g.id;
    return m;
  }, [designGroups]);

  const savings = useMemo(
    () => computeSavings(members, resultsById, memberGroupId, targetDCR),
    [members, resultsById, memberGroupId, targetDCR]
  );

  // Total steel in place, split longitudinal vs stirrups (lb and avg lb/ft)
  const weightTotals = useMemo(() => {
    let longLb = 0, stirrupLb = 0, totalLenFt = 0;
    for (const m of members) {
      if (m.memberType !== 'beam') continue;
      const w = steelWeightPerFt(m);
      const p1 = m.etabs?.pt1, p2 = m.etabs?.pt2;
      const len = (p1 && p2)
        ? Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z)
        : (m.span ?? 20);
      longLb += w.longLbFt * len;
      stirrupLb += w.stirrupLbFt * len;
      totalLenFt += len;
    }
    return { longLb, stirrupLb, totalLb: longLb + stirrupLb, totalLenFt };
  }, [members]);

  // Per-group rollup
  const groupSavings = useMemo(() => {
    return designGroups.map(g => {
      const lb = savings.perGroup[g.id] ?? 0;
      const members = savings.perMember.filter(m => memberGroupId[m.memberId] === g.id);
      const worstDCR = members.length ? Math.max(...members.map(m => m.dcrGov)) : 0;
      return { group: g, lb, worstDCR, count: members.length };
    }).sort((a, b) => b.lb - a.lb);
  }, [savings, designGroups, memberGroupId]);

  // Consolidation advisor: look for adjacent groups in the same family where merging is cheap
  const consolidationTips = useMemo(() => {
    if (designGroups.length < 2) return [];
    const tips: { keepId: string; removeId: string; extraLb: number; label: string }[] = [];

    // Group by family key
    const byFamily = new Map<string, typeof groupSavings>();
    for (const gs of groupSavings) {
      const mems = members.filter(m => gs.group.memberIds.includes(m.id));
      if (!mems.length) continue;
      const fk = familyKey(mems[0]);
      const list = byFamily.get(fk) ?? [];
      list.push(gs);
      byFamily.set(fk, list);
    }

    for (const [, famGroups] of byFamily) {
      if (famGroups.length < 2) continue;
      // Sort by worst DCR ascending — lightest group merges into heavier
      const sorted = [...famGroups].sort((a, b) => a.worstDCR - b.worstDCR);
      for (let i = 0; i < sorted.length - 1; i++) {
        const light = sorted[i], heavy = sorted[i + 1];
        // Extra steel if light group adopts heavy group's demand: rough estimate
        const lightMems = savings.perMember.filter(m => memberGroupId[m.memberId] === light.group.id);
        const heavyWorstDCR = heavy.worstDCR;
        const extraLb = lightMems.reduce((s, m) => {
          // If light member adopts heavy's DCR demand: less slack
          const reducedSlack = m.totalSlackLb * Math.max(0, 1 - (heavyWorstDCR - m.dcrGov) / Math.max(heavyWorstDCR, 0.01));
          return s + reducedSlack;
        }, 0);
        if (light.lb - extraLb > 5 && extraLb < light.lb * 0.5) {
          tips.push({
            keepId: heavy.group.id,
            removeId: light.group.id,
            extraLb: Math.max(0, extraLb),
            label: `Merge "${light.group.label}" → "${heavy.group.label}": +${Math.round(extraLb)} lb, −1 callout`,
          });
        }
      }
    }
    return tips.slice(0, 4);
  }, [designGroups, groupSavings, savings.perMember, memberGroupId, members]);

  function exportCSV() {
    const header = 'Group,Member,Story,Family,DCR,AsProvTop(in²),AsProvBot(in²),LongLbPerFt,StirrupLbPerFt,TotalLbPerFt,SlackLb';
    const weightById = new Map(members.map(m => [m.id, steelWeightPerFt(m)]));
    const rows = savings.perMember.map(m => {
      const gid = memberGroupId[m.memberId];
      const gLabel = designGroups.find(g => g.id === gid)?.label ?? 'Ungrouped';
      const w = weightById.get(m.memberId) ?? { longLbFt: 0, stirrupLbFt: 0, totalLbFt: 0 };
      return [gLabel, m.label, m.story, m.familyKey, m.dcrGov.toFixed(3),
              m.AsProvTop.toFixed(2), m.AsProvBot.toFixed(2),
              w.longLbFt.toFixed(2), w.stirrupLbFt.toFixed(2), w.totalLbFt.toFixed(2),
              m.totalSlackLb.toFixed(1)].join(',');
    });
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'rebar_savings.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  const hasResults = savings.perMember.length > 0;

  return (
    <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#111827' }}>
            {hasResults ? `~${savings.totalTons.toFixed(2)} tons` : '—'} potential savings
          </div>
          <div style={{ fontSize: 10, color: '#6b7280' }}>at target DCR {(targetDCR * 100).toFixed(0)}%</div>
        </div>
        {hasResults && (
          <button onClick={exportCSV} style={{ fontSize: 10, padding: '4px 8px', borderRadius: 5, border: '1px solid #d1d5db', background: 'white', cursor: 'pointer', color: '#374151' }}>
            ↓ CSV
          </button>
        )}
      </div>

      {/* Target DCR slider */}
      <div>
        <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 3 }}>
          Target DCR: <span style={{ fontWeight: 700, color: '#374151' }}>{(targetDCR * 100).toFixed(0)}%</span>
        </div>
        <input type="range" min={0.70} max={1.00} step={0.01} value={targetDCR}
          onChange={e => onTargetDCRChange(parseFloat(e.target.value))}
          style={{ width: '100%', accentColor: '#2563eb' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#9ca3af' }}>
          <span>70% (conservative)</span><span>100% (use everything)</span>
        </div>
      </div>

      {/* Steel in place, split longitudinal vs stirrups */}
      {weightTotals.totalLenFt > 0 && (
        <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 10px' }}>
          <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, marginBottom: 4 }}>Steel in place</div>
          <div style={{ display: 'flex', gap: 12, fontSize: 10 }}>
            <div>
              <div style={{ color: '#9ca3af' }}>Longitudinal</div>
              <div style={{ fontFamily: 'monospace', fontWeight: 700, color: '#374151' }}>
                {weightTotals.longLb.toFixed(0)} lb
              </div>
              <div style={{ color: '#6b7280' }}>{(weightTotals.longLb / weightTotals.totalLenFt).toFixed(1)} lb/ft avg</div>
            </div>
            <div>
              <div style={{ color: '#9ca3af' }}>Stirrups</div>
              <div style={{ fontFamily: 'monospace', fontWeight: 700, color: '#374151' }}>
                {weightTotals.stirrupLb.toFixed(0)} lb
              </div>
              <div style={{ color: '#6b7280' }}>{(weightTotals.stirrupLb / weightTotals.totalLenFt).toFixed(1)} lb/ft avg</div>
            </div>
            <div>
              <div style={{ color: '#9ca3af' }}>Total</div>
              <div style={{ fontFamily: 'monospace', fontWeight: 700, color: '#111827' }}>
                {(weightTotals.totalLb / 2000).toFixed(2)} tons
              </div>
              <div style={{ color: '#6b7280' }}>{(weightTotals.totalLb / weightTotals.totalLenFt).toFixed(1)} lb/ft avg</div>
            </div>
          </div>
        </div>
      )}

      {!hasResults && (
        <div style={{ fontSize: 11, color: '#9ca3af' }}>
          Design members first to see savings estimates.
        </div>
      )}

      {/* Consolidation tips */}
      {consolidationTips.length > 0 && (
        <div>
          <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, marginBottom: 4 }}>Consolidation ideas</div>
          {consolidationTips.map((tip, i) => (
            <div key={i} style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '5px 8px', marginBottom: 4, fontSize: 10 }}>
              <span style={{ color: '#166534' }}>{tip.label}</span>
              {onMergeGroups && (
                <button onClick={() => onMergeGroups(tip.keepId, tip.removeId)}
                  style={{ marginLeft: 8, fontSize: 9, padding: '1px 6px', border: '1px solid #16a34a', borderRadius: 4, background: 'white', color: '#16a34a', cursor: 'pointer' }}>
                  Merge
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Per-group table */}
      {hasResults && (
        <div>
          <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, marginBottom: 4 }}>
            By group <span style={{ fontWeight: 400 }}>(click to expand)</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
            <thead>
              <tr style={{ color: '#9ca3af', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>
                <th style={{ padding: '2px 4px', fontWeight: 500 }}>Group</th>
                <th style={{ padding: '2px 4px', fontWeight: 500, textAlign: 'right' }}>Members</th>
                <th style={{ padding: '2px 4px', fontWeight: 500, textAlign: 'right' }}>DCR</th>
                <th style={{ padding: '2px 4px', fontWeight: 500, textAlign: 'right' }}>Savings</th>
              </tr>
            </thead>
            <tbody>
              {groupSavings.map(({ group, lb, worstDCR, count }) => (
                <>
                  <tr key={group.id}
                    style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
                    onClick={() => setExpanded(expanded === group.id ? null : group.id)}>
                    <td style={{ padding: '3px 4px', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: group.color ?? '#9ca3af', flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}>{group.label}</span>
                    </td>
                    <td style={{ padding: '3px 4px', textAlign: 'right', color: '#374151' }}>{count}</td>
                    <td style={{ padding: '3px 4px', textAlign: 'right', fontFamily: 'monospace', color: worstDCR >= 1 ? '#dc2626' : '#374151' }}>
                      {worstDCR.toFixed(2)}
                    </td>
                    <td style={{ padding: '3px 4px', textAlign: 'right', color: lb > 50 ? '#16a34a' : '#6b7280', fontWeight: lb > 50 ? 600 : 400 }}>
                      {lb.toFixed(0)} lb
                    </td>
                  </tr>
                  {expanded === group.id && savings.perMember
                    .filter(m => memberGroupId[m.memberId] === group.id)
                    .map(m => (
                      <tr key={m.memberId} style={{ background: '#f9fafb' }}>
                        <td colSpan={2} style={{ padding: '2px 12px', color: '#6b7280' }}>{m.label} <span style={{ color: '#9ca3af' }}>{m.story}</span></td>
                        <td style={{ padding: '2px 4px', textAlign: 'right', fontFamily: 'monospace', fontSize: 9, color: '#374151' }}>{m.dcrGov.toFixed(2)}</td>
                        <td style={{ padding: '2px 4px', textAlign: 'right', fontSize: 9, color: '#374151' }}>{m.totalSlackLb.toFixed(0)}</td>
                      </tr>
                    ))}
                </>
              ))}
              {/* Ungrouped members */}
              {savings.perMember.filter(m => !memberGroupId[m.memberId]).length > 0 && (
                <>
                  <tr style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
                    onClick={() => setExpanded(expanded === '_ungrouped' ? null : '_ungrouped')}>
                    <td style={{ padding: '3px 4px', color: '#9ca3af' }}>Ungrouped</td>
                    <td style={{ padding: '3px 4px', textAlign: 'right', color: '#9ca3af' }}>
                      {savings.perMember.filter(m => !memberGroupId[m.memberId]).length}
                    </td>
                    <td />
                    <td style={{ padding: '3px 4px', textAlign: 'right', color: '#6b7280' }}>
                      {savings.perMember.filter(m => !memberGroupId[m.memberId]).reduce((s, m) => s + m.totalSlackLb, 0).toFixed(0)} lb
                    </td>
                  </tr>
                  {expanded === '_ungrouped' && savings.perMember
                    .filter(m => !memberGroupId[m.memberId])
                    .map(m => (
                      <tr key={m.memberId} style={{ background: '#f9fafb' }}>
                        <td colSpan={2} style={{ padding: '2px 12px', color: '#6b7280' }}>{m.label}</td>
                        <td style={{ padding: '2px 4px', textAlign: 'right', fontFamily: 'monospace', fontSize: 9 }}>{m.dcrGov.toFixed(2)}</td>
                        <td style={{ padding: '2px 4px', textAlign: 'right', fontSize: 9 }}>{m.totalSlackLb.toFixed(0)}</td>
                      </tr>
                    ))}
                </>
              )}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid #e5e7eb', fontWeight: 700 }}>
                <td colSpan={3} style={{ padding: '4px 4px', color: '#374151', fontSize: 11 }}>Total</td>
                <td style={{ padding: '4px 4px', textAlign: 'right', color: '#16a34a', fontSize: 11 }}>
                  {savings.totalLb.toFixed(0)} lb<br />
                  <span style={{ fontSize: 9, color: '#6b7280' }}>{savings.totalTons.toFixed(3)} tons</span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
