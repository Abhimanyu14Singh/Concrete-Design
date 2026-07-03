/**
 * SavingsPanel — shows DCR slack per group/member as potential rebar tonnage savings,
 * with a target-DCR slider and a consolidation advisor for adjacent bins.
 */
import { useState, useMemo, Fragment } from 'react';
import type { Member, DesignResults, DesignGroup } from '../../types';
import { computeSavings, familyKey, steelWeightPerFt, flexSteelRatioPct } from '../../utils/autoGroup';
import { useUnits } from '../../contexts/UnitsContext';
import { ACCENT, BORDER, INK, MONO_NUM, STATUS, SURFACE } from '../../theme';

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
  const { units, fmtVal, label, toDisplay } = useUnits();
  function fmtTons(lb: number): string {
    return units === 'si'
      ? `${(toDisplay(lb, 'steelWeight') / 1000).toFixed(2)} t`
      : `${(lb / 2000).toFixed(2)} tons`;
  }
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

  // Per-group rollup. Reinforcement ratio ρ is averaged over the group's
  // members for top and bottom faces. The "yield" ρ is what each face would
  // drop to if trimmed to the required area at the target DCR — i.e. the ρ the
  // estimated savings correspond to. Computed by scaling the provided ρ by
  // (As required / As provided) per member, so it needs no extra geometry.
  const memberById = useMemo(() => new Map(members.map(m => [m.id, m])), [members]);

  const groupSavings = useMemo(() => {
    return designGroups.map(g => {
      const lb = savings.perGroup[g.id] ?? 0;
      const mems = savings.perMember.filter(m => memberGroupId[m.memberId] === g.id);
      const worstDCR = mems.length ? Math.max(...mems.map(m => m.dcrGov)) : 0;

      let rtP = 0, rbP = 0, rtY = 0, rbY = 0, n = 0;
      for (const sm of mems) {
        const member = memberById.get(sm.memberId);
        if (!member) continue;
        const rTop = flexSteelRatioPct(member, 'top');
        const rBot = flexSteelRatioPct(member, 'bot');
        rtP += rTop; rbP += rBot;
        rtY += sm.AsProvTop > 0 ? rTop * Math.min(1, sm.AsReqTop / sm.AsProvTop) : rTop;
        rbY += sm.AsProvBot > 0 ? rBot * Math.min(1, sm.AsReqBot / sm.AsProvBot) : rBot;
        n++;
      }
      const rho = n > 0
        ? { topProv: rtP / n, botProv: rbP / n, topYield: rtY / n, botYield: rbY / n }
        : null;

      return { group: g, lb, worstDCR, count: mems.length, rho };
    }).sort((a, b) => b.lb - a.lb);
  }, [savings, designGroups, memberGroupId, memberById]);

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
        // Cost of merging = light members adopt the heavy group's required
        // areas (the merged group is sized for the heaviest demand): extra
        // steel = Σ (AsReq_heavy − AsReq_own)⁺ per face × length × 3.4.
        const lightMems = savings.perMember.filter(m => memberGroupId[m.memberId] === light.group.id);
        const heavyMems = savings.perMember.filter(m => memberGroupId[m.memberId] === heavy.group.id);
        if (!lightMems.length || !heavyMems.length) continue;
        const heavyReqTop = Math.max(...heavyMems.map(m => m.AsReqTop));
        const heavyReqBot = Math.max(...heavyMems.map(m => m.AsReqBot));
        const extraLb = lightMems.reduce((s, m) => {
          const dAs = Math.max(0, heavyReqTop - m.AsReqTop) + Math.max(0, heavyReqBot - m.AsReqBot);
          return s + dAs * m.lengthFt * 3.4;
        }, 0);
        if (extraLb < Math.max(50, light.lb * 0.5)) {
          tips.push({
            keepId: heavy.group.id,
            removeId: light.group.id,
            extraLb,
            label: `Merge "${light.group.label}" → "${heavy.group.label}": +${fmtVal(extraLb, 'steelWeight')} ${label('steelWeight')}, −1 callout`,
          });
        }
      }
    }
    return tips.slice(0, 4);
  }, [designGroups, groupSavings, savings.perMember, memberGroupId, members, fmtVal, label]);

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

  // Total in-place steel for % savings computation
  const totalInPlaceLb = weightTotals.totalLb;
  const savingsPct = totalInPlaceLb > 0 ? (savings.totalLb / totalInPlaceLb * 100) : 0;

  return (
    <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: INK.strong }}>
            {hasResults ? `~${fmtTons(savings.totalLb)}` : '—'} potential savings
            {hasResults && totalInPlaceLb > 0 && (
              <span style={{ marginLeft: 6, fontSize: 11, color: STATUS.ok }}>({savingsPct.toFixed(0)}%)</span>
            )}
          </div>
          <div style={{ fontSize: 10, color: INK.secondary }}>at target DCR {(targetDCR * 100).toFixed(0)}%</div>
        </div>
        {hasResults && (
          <button onClick={exportCSV} style={{ fontSize: 10, padding: '4px 8px', borderRadius: 5, border: `1px solid ${BORDER.strong}`, background: 'white', cursor: 'pointer', color: INK.base }}>
            ↓ CSV
          </button>
        )}
      </div>

      {/* Target DCR slider */}
      <div>
        <div style={{ fontSize: 10, color: INK.secondary, marginBottom: 3 }}>
          Target DCR: <span style={{ fontWeight: 700, color: INK.base }}>{(targetDCR * 100).toFixed(0)}%</span>
        </div>
        <input type="range" min={0.70} max={1.00} step={0.01} value={targetDCR}
          onChange={e => onTargetDCRChange(parseFloat(e.target.value))}
          style={{ width: '100%', accentColor: ACCENT.primary }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: INK.muted }}>
          <span>70% (conservative)</span><span>100% (use everything)</span>
        </div>
      </div>

      {/* Steel in place, split longitudinal vs stirrups */}
      {weightTotals.totalLenFt > 0 && (
        <div style={{ background: '#f8fafc', border: `1px solid ${BORDER.default}`, borderRadius: 6, padding: '6px 10px' }}>
          <div style={{ fontSize: 10, color: INK.secondary, fontWeight: 600, marginBottom: 4 }}>Steel in place</div>
          <div style={{ display: 'flex', gap: 12, fontSize: 10 }}>
            <div>
              <div style={{ color: INK.muted }}>Longitudinal</div>
              <div style={{ ...MONO_NUM, fontWeight: 700, color: INK.base }}>
                {fmtVal(weightTotals.longLb, 'steelWeight')} {label('steelWeight')}
              </div>
              <div style={{ color: INK.secondary }}>{fmtVal(weightTotals.longLb / weightTotals.totalLenFt, 'steelWeightPerLength')} {label('steelWeightPerLength')} avg</div>
            </div>
            <div>
              <div style={{ color: INK.muted }}>Stirrups</div>
              <div style={{ ...MONO_NUM, fontWeight: 700, color: INK.base }}>
                {fmtVal(weightTotals.stirrupLb, 'steelWeight')} {label('steelWeight')}
              </div>
              <div style={{ color: INK.secondary }}>{fmtVal(weightTotals.stirrupLb / weightTotals.totalLenFt, 'steelWeightPerLength')} {label('steelWeightPerLength')} avg</div>
            </div>
            <div>
              <div style={{ color: INK.muted }}>Total</div>
              <div style={{ ...MONO_NUM, fontWeight: 700, color: INK.strong }}>
                {fmtTons(weightTotals.totalLb)}
              </div>
              <div style={{ color: INK.secondary }}>{fmtVal(weightTotals.totalLb / weightTotals.totalLenFt, 'steelWeightPerLength')} {label('steelWeightPerLength')} avg</div>
            </div>
          </div>
        </div>
      )}

      {!hasResults && (
        <div style={{ fontSize: 11, color: INK.muted }}>
          Design members first to see savings estimates.
        </div>
      )}

      {/* Consolidation tips */}
      {consolidationTips.length > 0 && (
        <div>
          <div style={{ fontSize: 10, color: INK.secondary, fontWeight: 600, marginBottom: 4 }}>Consolidation ideas</div>
          {consolidationTips.map((tip, i) => (
            <div key={i} style={{ background: STATUS.okBg, border: `1px solid ${STATUS.okBorder}`, borderRadius: 6, padding: '5px 8px', marginBottom: 4, fontSize: 10 }}>
              <span style={{ color: '#166534' }}>{tip.label}</span>
              {onMergeGroups && (
                <button onClick={() => onMergeGroups(tip.keepId, tip.removeId)}
                  style={{ marginLeft: 8, fontSize: 10, padding: '1px 6px', border: `1px solid ${STATUS.ok}`, borderRadius: 4, background: 'white', color: STATUS.ok, cursor: 'pointer' }}>
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
          <div style={{ fontSize: 10, color: INK.secondary, fontWeight: 600, marginBottom: 4 }}>
            By group <span style={{ fontWeight: 400 }}>(click to expand)</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ color: INK.muted, textAlign: 'left', borderBottom: `1px solid ${BORDER.default}` }}>
                <th style={{ padding: '2px 4px', fontWeight: 600 }}>Group</th>
                <th style={{ padding: '2px 4px', fontWeight: 600, textAlign: 'right' }}>Members</th>
                <th style={{ padding: '2px 4px', fontWeight: 600, textAlign: 'right' }}>DCR</th>
                <th style={{ padding: '2px 4px', fontWeight: 600, textAlign: 'right' }}>Savings</th>
                <th style={{ padding: '2px 4px', fontWeight: 600, textAlign: 'right' }}>%</th>
              </tr>
            </thead>
            <tbody>
              {groupSavings.map(({ group, lb, worstDCR, count, rho }) => (
                <Fragment key={group.id}>
                  <tr
                    style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
                    onClick={() => setExpanded(expanded === group.id ? null : group.id)}>
                    <td style={{ padding: '3px 4px', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: group.color ?? INK.muted, flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}>{group.label}</span>
                    </td>
                    <td style={{ padding: '3px 4px', textAlign: 'right', color: INK.base }}>{count}</td>
                    <td style={{ padding: '3px 4px', textAlign: 'right', ...MONO_NUM, color: worstDCR >= 1 ? STATUS.fail : INK.base }}>
                      {worstDCR.toFixed(2)}
                    </td>
                    <td style={{ padding: '3px 4px', textAlign: 'right', color: lb > 50 ? STATUS.ok : INK.secondary, fontWeight: lb > 50 ? 600 : 400 }}>
                      {fmtVal(lb, 'steelWeight')} {label('steelWeight')}
                    </td>
                    <td style={{ padding: '3px 4px', textAlign: 'right', color: INK.secondary, fontSize: 10 }}>
                      {totalInPlaceLb > 0 ? (lb / totalInPlaceLb * 100).toFixed(1) + '%' : '—'}
                    </td>
                  </tr>
                  {expanded === group.id && rho && (
                    <tr style={{ background: SURFACE.subtle }}>
                      <td colSpan={5} style={{ padding: '3px 12px', fontSize: 10, color: INK.secondary }}>
                        <span style={{ fontWeight: 600 }}>ρ (avg):</span>{' '}
                        bot <span style={{ ...MONO_NUM, color: INK.base }}>{rho.botProv.toFixed(2)}%</span>
                        {' → '}<span style={{ ...MONO_NUM, color: STATUS.ok }}>{rho.botYield.toFixed(2)}%</span>
                        {'   '}top <span style={{ ...MONO_NUM, color: INK.base }}>{rho.topProv.toFixed(2)}%</span>
                        {' → '}<span style={{ ...MONO_NUM, color: STATUS.ok }}>{rho.topYield.toFixed(2)}%</span>
                      </td>
                    </tr>
                  )}
                  {expanded === group.id && savings.perMember
                    .filter(m => memberGroupId[m.memberId] === group.id)
                    .map(m => (
                      <tr key={m.memberId} style={{ background: SURFACE.subtle }}>
                        <td colSpan={2} style={{ padding: '2px 12px', color: INK.secondary }}>{m.label} <span style={{ color: INK.muted }}>{m.story}</span></td>
                        <td style={{ padding: '2px 4px', textAlign: 'right', ...MONO_NUM, fontSize: 10, color: INK.base }}>{m.dcrGov.toFixed(2)}</td>
                        <td style={{ padding: '2px 4px', textAlign: 'right', fontSize: 10, color: INK.base }}>{fmtVal(m.totalSlackLb, 'steelWeight')} {label('steelWeight')}</td>
                      </tr>
                    ))}
                </Fragment>
              ))}
              {/* Ungrouped members */}
              {savings.perMember.filter(m => !memberGroupId[m.memberId]).length > 0 && (
                <>
                  <tr style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
                    onClick={() => setExpanded(expanded === '_ungrouped' ? null : '_ungrouped')}>
                    <td style={{ padding: '3px 4px', color: INK.muted }}>Ungrouped</td>
                    <td style={{ padding: '3px 4px', textAlign: 'right', color: INK.muted }}>
                      {savings.perMember.filter(m => !memberGroupId[m.memberId]).length}
                    </td>
                    <td />
                    <td style={{ padding: '3px 4px', textAlign: 'right', color: INK.secondary }}>
                      {fmtVal(savings.perMember.filter(m => !memberGroupId[m.memberId]).reduce((s, m) => s + m.totalSlackLb, 0), 'steelWeight')} {label('steelWeight')}
                    </td>
                  </tr>
                  {expanded === '_ungrouped' && savings.perMember
                    .filter(m => !memberGroupId[m.memberId])
                    .map(m => (
                      <tr key={m.memberId} style={{ background: SURFACE.subtle }}>
                        <td colSpan={2} style={{ padding: '2px 12px', color: INK.secondary }}>{m.label}</td>
                        <td style={{ padding: '2px 4px', textAlign: 'right', ...MONO_NUM, fontSize: 10 }}>{m.dcrGov.toFixed(2)}</td>
                        <td style={{ padding: '2px 4px', textAlign: 'right', fontSize: 10 }}>{m.totalSlackLb.toFixed(0)}</td>
                      </tr>
                    ))}
                </>
              )}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: `2px solid ${BORDER.default}`, fontWeight: 700 }}>
                <td colSpan={3} style={{ padding: '4px 4px', color: INK.base, fontSize: 11 }}>Total</td>
                <td style={{ padding: '4px 4px', textAlign: 'right', color: STATUS.ok, fontSize: 11 }}>
                  {fmtVal(savings.totalLb, 'steelWeight')} {label('steelWeight')}<br />
                  <span style={{ fontSize: 10, color: INK.secondary }}>{fmtTons(savings.totalLb)}</span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
