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
  demandValueFor,
  ALL_BEAMS_FAMILY_KEY,
  type AutoGroupSuggestion,
} from '../../utils/autoGroup';
import type { Quantity } from '../../utils/units';
import HistogramPanel from './HistogramPanel';
import { GROUP_PALETTE } from './groupColors';
import { useUnits } from '../../contexts/UnitsContext';

/**
 * Reformat a section-family label for the active unit system. Family labels
 * are baked as inch dimensions ("19.685×39.37"); when SI is active we convert
 * to mm so they read like the ETABS sections the user picked.
 */
function displayFamilyLabel(label: string, units: 'imperial' | 'si'): string {
  if (units !== 'si') return label;
  const m = label.match(/^([\d.]+)×([\d.]+)$/);
  if (!m) return label;
  const mm = (inch: string) => Math.round(parseFloat(inch) * 25.4);
  return `${mm(m[1])}×${mm(m[2])} mm`;
}

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
  const { units, toDisplay, fromDisplay, label: unitLabel } = useUnits();
  const [algorithm, setAlgorithm] = useState<'jenks' | 'quantile'>('jenks');
  const [kPerFamily, setKPerFamily] = useState<number | 'auto'>('auto');
  const [metric, setMetric] = useState<import('../../utils/autoGroup').DemandMetric>('governing');
  // Global budget: total groups across the whole model (null = use per-family k)
  const [totalGroups, setTotalGroups] = useState<number | null>(null);
  // Cross-family: ignore section boundaries and cluster all beams as one pool
  const [groupAllBeams, setGroupAllBeams] = useState(false);
  const [totalGroupsDraft, setTotalGroupsDraft] = useState('');

  // Live suggestions (recomputed on algorithm / k / total change)
  const baseSuggestions = useMemo(
    () => suggestGroups(members, kPerFamily, algorithm, metric, totalGroups ?? undefined, groupAllBeams),
    [members, algorithm, kPerFamily, metric, totalGroups, groupAllBeams]
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
  // When baseSuggestions recomputes (algorithm/metric/k/totalGroups change),
  // the stored selectedFamily may no longer be in the new list. Guard the
  // activeFamily derivation so the <select> value is ALWAYS one of its
  // <option> values — a mismatch causes the browser to show the first option
  // visually while React thinks a different value is selected, making
  // subsequent onChange events fire with the "wrong" starting value.
  useEffect(() => {
    if (selectedFamily && !families.includes(selectedFamily)) {
      setSelectedFamily('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseSuggestions]);
  const activeFamily = (selectedFamily && families.includes(selectedFamily))
    ? selectedFamily
    : (families[0] || '');

  const activeSuggestion = baseSuggestions.find(s => s.familyKey === activeFamily);
  const demands = useMemo(() => extractDemands(members), [members]);
  const familyDemands = useMemo(
    // In all-beams mode the active pool is the synthetic family, which no
    // demand carries as its own familyKey — use every demand instead.
    () => activeFamily === ALL_BEAMS_FAMILY_KEY
      ? demands
      : demands.filter(d => d.familyKey === activeFamily),
    [demands, activeFamily]
  );

  const currentBreaks = activeSuggestion ? getBreaks(activeFamily, activeSuggestion) : [];
  const vals = familyDemands.map(d => demandValueFor(d, metric));
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
    // Global running index so no two groups across families share a color.
    let colorIdx = 0;
    for (const sug of baseSuggestions) {
      const breaks = getBreaks(sug.familyKey, sug);
      const famDemands = sug.familyKey === ALL_BEAMS_FAMILY_KEY
        ? demands
        : demands.filter(d => d.familyKey === sug.familyKey);
      const famVals = famDemands.map(d => demandValueFor(d, metric));
      const assign = famVals.length ? assignByBreaks(famVals, breaks) : [];
      const numB = breaks.length + 1;
      const binsArr: string[][] = Array.from({ length: numB }, () => []);
      famDemands.forEach((d, i) => binsArr[assign[i] ?? 0].push(d.memberId));
      binsArr.forEach((mIds, bi) => {
        if (!mIds.length) return;
        bins.push({
          binKey: `${sug.familyKey}-${bi}`,
          memberIds: mIds,
          color: GROUP_PALETTE[colorIdx++ % GROUP_PALETTE.length],
          label: `${displayFamilyLabel(sug.familyLabel, units)} G${bi + 1}`,
        });
      });
    }
    return bins;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseSuggestions, tweakedBreaks, demands, metric, units]);

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
    const sortedSuggestions = [...baseSuggestions].sort((a, b) => a.familyLabel.localeCompare(b.familyLabel));
    const familyLetters = new Map(sortedSuggestions.map((s, i) => [s.familyKey, String.fromCharCode(65 + i)]));
    for (const sug of sortedSuggestions) {
      // Use current breaks (already user-adjusted via the sliders)
      const breaks = getBreaks(sug.familyKey, sug);
      const famDemands = sug.familyKey === ALL_BEAMS_FAMILY_KEY
        ? demands
        : demands.filter(d => d.familyKey === sug.familyKey);
      const famVals = famDemands.map(d => demandValueFor(d, metric));
      const assign = assignByBreaks(famVals, breaks);
      const numB = breaks.length + 1;
      const bins: string[][] = Array.from({ length: numB }, () => []);
      famDemands.forEach((d, i) => bins[assign[i] ?? 0].push(d.memberId));

      bins.forEach((mIds, bi) => {
        if (!mIds.length) return;
        const dimStr = displayFamilyLabel(sug.familyLabel, units).replace('×', 'x').replace(' mm', '');
        const letter = familyLetters.get(sug.familyKey) ?? '?';
        const label = `${letter}_${dimStr}_${bi + 1}`;
        newGroups.push({
          id: `auto-${sug.familyKey}-${bi}-${Date.now()}-${groupCount}`,
          label,
          memberIds: mIds,
          // global running index keeps every committed group a distinct color,
          // matching the preview swatches and the map plan
          color: GROUP_PALETTE[groupCount % GROUP_PALETTE.length],
          source: 'auto',
        });
        groupCount++;
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

  // Color of each preview bin, looked up from the overlay so swatches match
  // exactly what the map plan and the committed groups will show.
  const overlayColorByKey = new Map(allOverlayBins.map(b => [b.binKey, b.color]));
  const previewColor = (bi: number) =>
    overlayColorByKey.get(`${activeFamily}-${bi}`) ?? GROUP_PALETTE[bi % GROUP_PALETTE.length];

  return (
    <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Demand metric selector */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 10, color: '#9ca3af', alignSelf: 'center', marginRight: 4 }}>Cluster by:</span>
        {(['governing', 'Mu_pos', 'Mu_neg', 'Vu'] as const).map(m => (
          <button key={m} onClick={() => setMetric(m)}
            style={{ padding: '3px 8px', border: '1px solid #d1d5db', borderRadius: 5, fontSize: 10, cursor: 'pointer',
              background: metric === m ? '#2563eb' : 'white', color: metric === m ? 'white' : '#374151' }}>
            {m === 'governing' ? 'Governing' : m === 'Mu_pos' ? 'M⁺' : m === 'Mu_neg' ? 'M⁻' : 'Shear'}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: '#6b7280' }}>Pool:</span>
          <button
            onClick={() => { setGroupAllBeams(false); setSelectedFamily(''); setTweakedBreaks({}); }}
            style={{ padding: '3px 8px', border: '1px solid #d1d5db', borderRadius: 5, fontSize: 10, cursor: 'pointer',
              background: !groupAllBeams ? '#2563eb' : 'white', color: !groupAllBeams ? 'white' : '#374151' }}
            title="Group beams within each section family independently">
            By family
          </button>
          <button
            onClick={() => { setGroupAllBeams(true); setSelectedFamily(''); setTweakedBreaks({}); }}
            style={{ padding: '3px 8px', border: '1px solid #d1d5db', borderRadius: 5, fontSize: 10, cursor: 'pointer',
              background: groupAllBeams ? '#2563eb' : 'white', color: groupAllBeams ? 'white' : '#374151' }}
            title="Cluster all beams together regardless of section dimensions or material">
            All beams
          </button>
        </div>
      </div>

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
        <div style={{ opacity: totalGroups !== null ? 0.4 : 1 }}>
          <div style={lbl}>Groups / family</div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={() => { setKPerFamily('auto'); setTotalGroups(null); setTweakedBreaks({}); }}
              style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: '1px solid #d1d5db', background: totalGroups === null && kPerFamily === 'auto' ? '#2563eb' : 'white', color: totalGroups === null && kPerFamily === 'auto' ? 'white' : '#374151', cursor: 'pointer' }}>
              Auto
            </button>
            {[2, 3, 4, 5].map(k => (
              <button key={k}
                onClick={() => { setKPerFamily(k); setTotalGroups(null); setTweakedBreaks({}); }}
                style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: '1px solid #d1d5db', background: totalGroups === null && kPerFamily === k ? '#2563eb' : 'white', color: totalGroups === null && kPerFamily === k ? 'white' : '#374151', cursor: 'pointer' }}>
                {k}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={lbl}>Total groups (model)</div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="—"
              value={totalGroupsDraft}
              onChange={e => {
                setTotalGroupsDraft(e.target.value);
                const v = e.target.value === '' ? null : parseInt(e.target.value, 10);
                if (e.target.value === '' || (Number.isFinite(v) && v! >= 1)) {
                  setTotalGroups(e.target.value === '' ? null : v!);
                  setTweakedBreaks({});
                }
              }}
              onBlur={e => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isFinite(v) || v < 1) {
                  setTotalGroups(null);
                  setTotalGroupsDraft('');
                } else {
                  setTotalGroups(v);
                  setTotalGroupsDraft(String(v));
                }
                setTweakedBreaks({});
              }}
              style={{ width: 56, fontSize: 11, padding: '2px 6px', borderRadius: 4, border: `1px solid ${totalGroups !== null ? '#2563eb' : '#d1d5db'}`, background: totalGroups !== null ? '#eff6ff' : 'white', fontFamily: 'monospace' }}
              title="Total design groups across the whole model, distributed across families by demand spread"
            />
            {totalGroups !== null && (
              <button onClick={() => { setTotalGroups(null); setTotalGroupsDraft(''); setTweakedBreaks({}); }}
                style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #d1d5db', background: 'white', color: '#6b7280', cursor: 'pointer' }}>
                clear
              </button>
            )}
          </div>
          {totalGroups !== null && (
            <div style={{ fontSize: 9, color: '#6b7280', marginTop: 2 }}>
              ≈ {baseSuggestions.reduce((s, sg) => s + sg.bins.length, 0)} across {baseSuggestions.length} famil{baseSuggestions.length === 1 ? 'y' : 'ies'}
            </div>
          )}
        </div>
      </div>

      {/* Family selector — hidden when all-beams mode has a single pseudo-family */}
      {families.length > 1 && (
        <div>
          <div style={lbl}>{groupAllBeams ? 'Pool' : 'Section family'}</div>
          <select
            value={activeFamily}
            onChange={e => setSelectedFamily(e.target.value)}
            style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, border: '1px solid #d1d5db', width: '100%' }}>
            {baseSuggestions.map(s => {
              const count = groupAllBeams
                ? demands.length
                : demands.filter(d => d.familyKey === s.familyKey).length;
              return (
                <option key={s.familyKey} value={s.familyKey}>
                  {displayFamilyLabel(s.familyLabel, units)} ({count} beams)
                </option>
              );
            })}
          </select>
        </div>
      )}

      {/* Histogram */}
      {activeSuggestion && (() => {
        const q: Quantity | null = metric === 'Vu' ? 'force' : metric === 'governing' ? null : 'moment';
        const dispVals = q ? vals.map(v => toDisplay(v, q)) : vals;
        const dispBreaks = q ? currentBreaks.map(b => toDisplay(b, q)) : currentBreaks;
        const xLabelDisp = metric === 'governing' ? 'Governing demand →'
          : metric === 'Vu' ? `Shear (${unitLabel('force')}) →`
          : metric === 'Mu_pos' ? `M⁺ (${unitLabel('moment')}) →`
          : `M⁻ (${unitLabel('moment')}) →`;
        return (
          <div>
            <div style={{ ...lbl, marginBottom: 6 }}>
              Demand distribution — {displayFamilyLabel(activeSuggestion.familyLabel, units)}
              <span style={{ marginLeft: 6, color: '#2563eb' }}>GVF {(activeSuggestion.gvf * 100).toFixed(0)}%</span>
            </div>
            <HistogramPanel
              values={dispVals}
              binAssignment={binAssignment}
              breaks={dispBreaks}
              onBreaksChange={dispBrs => {
                const rawBrs = q ? dispBrs.map(b => fromDisplay(b, q)) : dispBrs;
                handleBreaksChange(activeFamily, rawBrs);
              }}
              xLabel={xLabelDisp}
            />
          </div>
        );
      })()}

      {/* Bin preview list */}
      <div>
        <div style={lbl}>Group preview ({numBins} groups)</div>
        {binMemberIds.map((mIds, bi) => {
          if (!mIds.length) return null;
          const worstDemand = Math.max(...familyDemands.filter(d => mIds.includes(d.memberId)).map(d => demandValueFor(d, metric)));
          const q: Quantity | null = metric === 'Vu' ? 'force' : metric === 'governing' ? null : 'moment';
          const demandStr = metric === 'governing'
            ? `${(worstDemand * 100).toFixed(0)}%`
            : `${Math.round(toDisplay(worstDemand, q!))} ${unitLabel(q!)}`;
          return (
            <div key={bi}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', cursor: 'pointer' }}
              onMouseEnter={() => highlightBin(bi)}
              onMouseLeave={clearHighlight}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: previewColor(bi), flexShrink: 0 }} />
              <span style={{ fontSize: 11, flex: 1 }}>Group {bi + 1}</span>
              <span style={{ fontSize: 10, color: '#6b7280' }}>{mIds.length} beams</span>
              <span style={{ fontSize: 10, color: '#374151', fontFamily: 'monospace' }}>{demandStr}</span>
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
