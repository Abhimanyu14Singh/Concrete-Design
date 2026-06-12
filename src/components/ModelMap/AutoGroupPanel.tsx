/**
 * AutoGroupPanel — demand-based beam grouping wizard.
 *
 * Shows a histogram of governing demand per section family with draggable
 * group-boundary sliders (Jenks or quantile clustering). Lets the user
 * preview and apply the groupings as DesignGroups.
 */
import { useState, useMemo, useEffect } from 'react';
import type { Member, DesignGroup, AutoGroupBin } from '../../types';
import {
  suggestGroups, extractDemands, assignByBreaks,
  type AutoGroupSuggestion,
} from '../../utils/autoGroup';
import HistogramPanel from './HistogramPanel';

const GROUP_PALETTE = [
  '#2563eb','#16a34a','#d97706','#9333ea','#0891b2','#dc2626',
];

interface AutoGroupPanelProps {
  members: Member[];
  onHighlightChange?: (frameNames: Set<string>) => void;
  onApplySuggestion: (groups: DesignGroup[]) => void;
  onOverlayChange?: (bins: AutoGroupBin[]) => void;
}

export default function AutoGroupPanel({
  members,
  onHighlightChange,
  onApplySuggestion,
  onOverlayChange,
}: AutoGroupPanelProps) {
  const [algorithm, setAlgorithm] = useState<'jenks' | 'quantile'>('jenks');
  const [kPerFamily, setKPerFamily] = useState<number | 'auto'>('auto');

  // Live suggestions (recomputed on algorithm / k change)
  const baseSuggestions = useMemo(
    () => suggestGroups(members, kPerFamily, algorithm),
    [members, algorithm, kPerFamily]
  );

  // Per-family user-tweaked breaks (initially from suggestion)
  const [tweakedBreaks, setTweakedBreaks] = useState<Record<string, number[]>>({});

  function getBreaks(fk: string, suggestion: AutoGroupSuggestion): number[] {
    return tweakedBreaks[fk] ?? suggestion.breaks;
  }

  function handleBreaksChange(fk: string, breaks: number[]) {
    setTweakedBreaks(prev => ({ ...prev, [fk]: breaks }));
  }

  // Family selector
  const families = baseSuggestions.map(s => s.familyKey);
  const [selectedFamily, setSelectedFamily] = useState<string>('');
  const activeFamily = selectedFamily || families[0] || '';

  const activeSuggestion = baseSuggestions.find(s => s.familyKey === activeFamily);
  const demands = useMemo(() => extractDemands(members), [members]);
  const familyDemands = useMemo(
    () => demands.filter(d => d.familyKey === activeFamily),
    [demands, activeFamily]
  );

  const currentBreaks = activeSuggestion ? getBreaks(activeFamily, activeSuggestion) : [];
  const vals = familyDemands.map(d => d.governing);
  const binAssignment = vals.length ? assignByBreaks(vals, currentBreaks) : [];

  // Bin preview
  const numBins = currentBreaks.length + 1;
  const binMemberIds: string[][] = Array.from({ length: numBins }, () => []);
  familyDemands.forEach((d, i) => {
    const bin = binAssignment[i] ?? 0;
    if (binMemberIds[bin]) binMemberIds[bin].push(d.memberId);
  });

  // Compute full overlay (all families) and fire onOverlayChange
  const allOverlayBins = useMemo<AutoGroupBin[]>(() => {
    const bins: AutoGroupBin[] = [];
    for (const sug of baseSuggestions) {
      const breaks = getBreaks(sug.familyKey, sug);
      const famDemands = demands.filter(d => d.familyKey === sug.familyKey);
      const famVals = famDemands.map(d => d.governing);
      const assign = famVals.length ? assignByBreaks(famVals, breaks) : [];
      const numB = breaks.length + 1;
      const binsArr: string[][] = Array.from({ length: numB }, () => []);
      famDemands.forEach((d, i) => binsArr[assign[i] ?? 0].push(d.memberId));
      binsArr.forEach((mIds, bi) => {
        if (!mIds.length) return;
        bins.push({
          binKey: `${sug.familyKey}-${bi}`,
          memberIds: mIds,
          color: GROUP_PALETTE[bi % GROUP_PALETTE.length],
          label: `${sug.familyLabel} G${bi + 1}`,
        });
      });
    }
    return bins;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseSuggestions, tweakedBreaks, demands]);

  useEffect(() => {
    onOverlayChange?.(allOverlayBins);
  }, [allOverlayBins, onOverlayChange]);

  // Member → frame name for highlight sync
  const memberToFrame = useMemo(() => {
    const m = new Map<string, string>();
    for (const mem of members) {
      if (mem.etabs?.frameName) m.set(mem.id, mem.etabs.frameName);
    }
    return m;
  }, [members]);

  function highlightBin(binIdx: number) {
    const frameNames = new Set(
      (binMemberIds[binIdx] ?? []).flatMap(mid => {
        const fn = memberToFrame.get(mid);
        return fn ? [fn] : [];
      })
    );
    onHighlightChange?.(frameNames);
  }

  function clearHighlight() {
    onHighlightChange?.(new Set());
  }

  function handleApply() {
    const newGroups: DesignGroup[] = [];
    let groupCount = 0;
    for (const sug of baseSuggestions) {
      // Use current breaks (already user-adjusted via the sliders)
      const breaks = getBreaks(sug.familyKey, sug);
      const famDemands = demands.filter(d => d.familyKey === sug.familyKey);
      const famVals = famDemands.map(d => d.governing);
      const assign = assignByBreaks(famVals, breaks);
      const numB = breaks.length + 1;
      const bins: string[][] = Array.from({ length: numB }, () => []);
      famDemands.forEach((d, i) => bins[assign[i] ?? 0].push(d.memberId));

      bins.forEach((mIds, bi) => {
        if (!mIds.length) return;
        const worstMuPos = Math.max(...famDemands.filter(d => mIds.includes(d.memberId)).map(d => d.MuPos));
        const label = `${sug.familyLabel} — G${bi + 1} (Mu≤${Math.round(worstMuPos)} k-ft)`;
        newGroups.push({
          id: `auto-${sug.familyKey}-${bi}-${Date.now()}-${groupCount++}`,
          label,
          memberIds: mIds,
          // bin index keys the color so applied groups match the preview swatches
          color: GROUP_PALETTE[bi % GROUP_PALETTE.length],
          source: 'auto',
        });
      });
    }
    onApplySuggestion(newGroups);
  }

  if (!baseSuggestions.length) {
    return (
      <div style={{ padding: 12, color: '#9ca3af', fontSize: 12 }}>
        Import beams first to enable auto-grouping.
      </div>
    );
  }

  const lbl: React.CSSProperties = { fontSize: 10, color: '#6b7280', marginBottom: 3 };

  return (
    <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <div style={lbl}>Algorithm</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['jenks', 'quantile'] as const).map(alg => (
              <button key={alg}
                onClick={() => { setAlgorithm(alg); setTweakedBreaks({}); }}
                style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: '1px solid #d1d5db', background: algorithm === alg ? '#2563eb' : 'white', color: algorithm === alg ? 'white' : '#374151', cursor: 'pointer' }}>
                {alg === 'jenks' ? 'Jenks' : 'Quantile'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={lbl}>Groups / family</div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={() => { setKPerFamily('auto'); setTweakedBreaks({}); }}
              style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: '1px solid #d1d5db', background: kPerFamily === 'auto' ? '#2563eb' : 'white', color: kPerFamily === 'auto' ? 'white' : '#374151', cursor: 'pointer' }}>
              Auto
            </button>
            {[2, 3, 4, 5].map(k => (
              <button key={k}
                onClick={() => { setKPerFamily(k); setTweakedBreaks({}); }}
                style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: '1px solid #d1d5db', background: kPerFamily === k ? '#2563eb' : 'white', color: kPerFamily === k ? 'white' : '#374151', cursor: 'pointer' }}>
                {k}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Family selector */}
      {families.length > 1 && (
        <div>
          <div style={lbl}>Section family</div>
          <select
            value={activeFamily}
            onChange={e => setSelectedFamily(e.target.value)}
            style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, border: '1px solid #d1d5db', width: '100%' }}>
            {baseSuggestions.map(s => (
              <option key={s.familyKey} value={s.familyKey}>
                {s.familyLabel} ({demands.filter(d => d.familyKey === s.familyKey).length} beams)
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Histogram */}
      {activeSuggestion && (
        <div>
          <div style={{ ...lbl, marginBottom: 6 }}>
            Demand distribution — {activeSuggestion.familyLabel}
            <span style={{ marginLeft: 6, color: '#2563eb' }}>GVF {(activeSuggestion.gvf * 100).toFixed(0)}%</span>
          </div>
          <HistogramPanel
            values={vals}
            binAssignment={binAssignment}
            breaks={currentBreaks}
            onBreaksChange={br => handleBreaksChange(activeFamily, br)}
            xLabel="Normalised governing demand →"
          />
        </div>
      )}

      {/* Bin preview list */}
      <div>
        <div style={lbl}>Group preview ({numBins} groups)</div>
        {binMemberIds.map((mIds, bi) => {
          if (!mIds.length) return null;
          const worstDemand = Math.max(...familyDemands.filter(d => mIds.includes(d.memberId)).map(d => d.governing));
          return (
            <div key={bi}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', cursor: 'pointer' }}
              onMouseEnter={() => highlightBin(bi)}
              onMouseLeave={clearHighlight}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: GROUP_PALETTE[bi % GROUP_PALETTE.length], flexShrink: 0 }} />
              <span style={{ fontSize: 11, flex: 1 }}>Group {bi + 1}</span>
              <span style={{ fontSize: 10, color: '#6b7280' }}>{mIds.length} beams</span>
              <span style={{ fontSize: 10, color: '#374151', fontFamily: 'monospace' }}>{(worstDemand * 100).toFixed(0)}%</span>
            </div>
          );
        })}
      </div>

      <button
        onClick={handleApply}
        style={{ background: '#2563eb', color: 'white', border: 'none', borderRadius: 6, padding: '7px 0', fontWeight: 600, fontSize: 12, cursor: 'pointer', width: '100%' }}>
        Commit as Design Groups
      </button>
      <div style={{ fontSize: 9, color: '#9ca3af' }}>
        Overlay is reference-only. Commit replaces existing auto-groups; manual groups untouched.
      </div>
    </div>
  );
}
