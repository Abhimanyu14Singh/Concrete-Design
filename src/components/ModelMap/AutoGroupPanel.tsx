/**
 * AutoGroupPanel — demand-based beam grouping wizard.
 *
 * Shows a histogram of governing demand per section family with draggable
 * group-boundary sliders (Jenks or quantile clustering). Lets the user
 * preview and apply the groupings as DesignGroups.
 */
import { useState, useMemo, useEffect, useDeferredValue } from 'react';
import type { Member, DesignGroup, AutoGroupBin } from '../../types';
import {
  suggestGroups, extractDemands, assignByBreaks,
  demandValueFor, governingFace,
  jenksBreaks, quantileBreaks,
  ALL_BEAMS_FAMILY_KEY,
  type AutoGroupSuggestion,
} from '../../utils/autoGroup';
import { formatGroupName, depthCodeMm, GROUP_NAME_TOKENS } from '../../utils/autoGroupName';
import type { Quantity } from '../../utils/units';
import HistogramPanel from './HistogramPanel';
import { GROUP_PALETTE } from './groupColors';
import { useUnits } from '../../contexts/UnitsContext';
import Dropdown from '../common/Dropdown';
import { ACCENT, BORDER, INK, MONO_NUM } from '../../theme';

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
  const [splitByFace, setSplitByFace] = useState(false);
  const [totalGroupsDraft, setTotalGroupsDraft] = useState('');
  // Optional group-name template (e.g. "{type}-{depth}-{seq}" → "B-07-01"). Empty
  // keeps the legacy "letter_dim_faceN" naming untouched.
  const [nameTemplate, setNameTemplate] = useState('');
  const [templateSeeded, setTemplateSeeded] = useState(false);
  // Typing in the template box drives the (heavy) plannedGroups recompute; defer
  // it so the input stays responsive — the box updates instantly, the name
  // preview catches up a beat later instead of blocking each keystroke.
  const deferredTemplate = useDeferredValue(nameTemplate);
  const NAME_TEMPLATE_HINT = '{type}-{depth}-{seq}';

  // Live suggestions (recomputed on algorithm / k / total change)
  const baseSuggestions = useMemo(
    () => suggestGroups(members, kPerFamily, algorithm, metric, totalGroups ?? undefined, groupAllBeams, splitByFace),
    [members, algorithm, kPerFamily, metric, totalGroups, groupAllBeams, splitByFace]
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
  const familyDemands = useMemo(() => {
    if (activeFamily === ALL_BEAMS_FAMILY_KEY) return demands;
    // In face-split mode filter by raw family key + governing face
    if (activeSuggestion?.face && activeSuggestion.rawFamilyKey) {
      return demands.filter(d =>
        d.familyKey === activeSuggestion.rawFamilyKey &&
        governingFace(d) === activeSuggestion.face
      );
    }
    return demands.filter(d => d.familyKey === activeFamily);
  }, [demands, activeFamily, activeSuggestion]);

  const currentBreaks = activeSuggestion ? getBreaks(activeFamily, activeSuggestion) : [];
  // Use the suggestion's metric (may differ from panel metric in face-split mode)
  const poolMetric = activeSuggestion?.metric ?? metric;
  const vals = familyDemands.map(d => demandValueFor(d, poolMetric));
  const binAssignment = vals.length ? assignByBreaks(vals, currentBreaks) : [];

  // Per-family group-count override: re-cluster JUST the active family at the
  // chosen k and store its breaks, so it overrides the global default without
  // touching the other families. 'auto' clears the override (back to default).
  const familyIsCustom = !!tweakedBreaks[activeFamily];
  const familyGroupCount = currentBreaks.length + 1;
  function setFamilyK(k: number | 'auto') {
    if (!activeFamily) return;
    if (k === 'auto') {
      setTweakedBreaks(prev => { const n = { ...prev }; delete n[activeFamily]; return n; });
      return;
    }
    const breakFn = algorithm === 'jenks' ? jenksBreaks : quantileBreaks;
    setTweakedBreaks(prev => ({ ...prev, [activeFamily]: breakFn(vals, Math.max(1, Math.min(k, vals.length))) }));
  }

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
        : (sug.face && sug.rawFamilyKey)
          ? demands.filter(d => d.familyKey === sug.rawFamilyKey && governingFace(d) === sug.face)
          : demands.filter(d => d.familyKey === sug.familyKey);
      const famVals = famDemands.map(d => demandValueFor(d, sug.metric));
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

  // The exact groups a Commit would produce — shared by the name preview and
  // handleApply so what you see is what you get. Deterministic (no ids/timestamps).
  const plannedGroups = useMemo(() => {
    type Planned = { label: string; memberIds: string[]; color: string; face?: 'top' | 'bot' };
    const out: Planned[] = [];
    let groupCount = 0;
    const seqByDepth: Record<string, number> = {}; // {seq} counts groups per depth code
    const memberById = new Map(members.map(m => [m.id, m]));
    const sortedSuggestions = [...baseSuggestions].sort((a, b) => a.familyLabel.localeCompare(b.familyLabel));
    // In face-split mode both sub-pools share the same raw family key and letter
    const rawKeys = [...new Set(sortedSuggestions.map(s => s.rawFamilyKey ?? s.familyKey))].sort();
    const familyLetters = new Map(rawKeys.map((rk, i) => [rk, String.fromCharCode(65 + i)]));
    const tmpl = deferredTemplate.trim();
    for (const sug of sortedSuggestions) {
      const breaks = getBreaks(sug.familyKey, sug);
      const famDemands = sug.familyKey === ALL_BEAMS_FAMILY_KEY
        ? demands
        : (sug.face && sug.rawFamilyKey)
          ? demands.filter(d => d.familyKey === sug.rawFamilyKey && governingFace(d) === sug.face)
          : demands.filter(d => d.familyKey === sug.familyKey);
      const famVals = famDemands.map(d => demandValueFor(d, sug.metric));
      const assign = assignByBreaks(famVals, breaks);
      const numB = breaks.length + 1;
      const bins: string[][] = Array.from({ length: numB }, () => []);
      famDemands.forEach((d, i) => bins[assign[i] ?? 0].push(d.memberId));

      bins.forEach((mIds, bi) => {
        if (!mIds.length) return;
        let label: string;
        let face: 'top' | 'bot' | undefined;
        if (tmpl) {
          // Template naming — the T/B stays OUT of the name (kept as `face`).
          const rep = memberById.get(mIds[0]);
          const depthMm = (rep?.section.h ?? 24) * 25.4;
          const widthMm = (rep?.section.bw ?? rep?.section.b ?? 12) * 25.4;
          const isColumn = rep?.memberType === 'column';
          const dKey = depthCodeMm(depthMm);
          seqByDepth[dKey] = (seqByDepth[dKey] ?? 0) + 1;
          label = formatGroupName(tmpl, {
            isColumn, depthMm, widthMm, seq: seqByDepth[dKey], n: groupCount + 1,
            face: sug.face, story: rep?.etabs?.story,
          });
          if (sug.face) face = sug.face;
        } else {
          // Legacy naming (unchanged): letter_dim_faceN, face baked in.
          const dimStr = displayFamilyLabel(sug.familyLabel, units).replace('×', 'x').replace(' mm', '');
          const letter = familyLetters.get(sug.rawFamilyKey ?? sug.familyKey) ?? '?';
          const faceSuffix = sug.face === 'bot' ? 'B' : sug.face === 'top' ? 'T' : '';
          label = `${letter}_${dimStr}_${faceSuffix}${bi + 1}`;
        }
        out.push({ label, memberIds: mIds, color: GROUP_PALETTE[groupCount % GROUP_PALETTE.length], ...(face ? { face } : {}) });
        groupCount++;
      });
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseSuggestions, tweakedBreaks, demands, members, units, deferredTemplate]);

  function handleApply() {
    const stamp = Date.now();
    const newGroups: DesignGroup[] = plannedGroups.map((g, i) => ({
      id: `auto-${stamp}-${i}`,
      label: g.label,
      memberIds: g.memberIds,
      color: g.color,
      source: 'auto',
      ...(g.face ? { face: g.face } : {}),
    }));
    onApplySuggestion(newGroups);
  }

  if (!baseSuggestions.length) {
    return (
      <div style={{ padding: 12, color: INK.muted, fontSize: 12 }}>
        Import beams first to enable auto-grouping.
      </div>
    );
  }

  const lbl: React.CSSProperties = { fontSize: 10, color: INK.secondary, marginBottom: 3 };

  // Color of each preview bin, looked up from the overlay so swatches match
  // exactly what the map plan and the committed groups will show.
  const overlayColorByKey = new Map(allOverlayBins.map(b => [b.binKey, b.color]));
  const previewColor = (bi: number) =>
    overlayColorByKey.get(`${activeFamily}-${bi}`) ?? GROUP_PALETTE[bi % GROUP_PALETTE.length];

  return (
    <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Demand metric selector */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 10, color: INK.muted, alignSelf: 'center', marginRight: 4 }}>Cluster by:</span>
        {(['governing', 'Mu_pos', 'Mu_neg', 'Vu'] as const).map(m => (
          <button key={m} onClick={() => setMetric(m)}
            style={{ padding: '3px 8px', border: `1px solid ${BORDER.strong}`, borderRadius: 5, fontSize: 10, cursor: 'pointer',
              background: metric === m ? ACCENT.primary : 'white', color: metric === m ? 'white' : INK.base }}>
            {m === 'governing' ? 'Governing' : m === 'Mu_pos' ? 'M⁺' : m === 'Mu_neg' ? 'M⁻' : 'Shear'}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: INK.secondary }}>Pool:</span>
          <button
            onClick={() => { setGroupAllBeams(false); setSelectedFamily(''); setTweakedBreaks({}); }}
            style={{ padding: '3px 8px', border: `1px solid ${BORDER.strong}`, borderRadius: 5, fontSize: 10, cursor: 'pointer',
              background: !groupAllBeams ? ACCENT.primary : 'white', color: !groupAllBeams ? 'white' : INK.base }}
            title="Group beams within each section family independently">
            By family
          </button>
          <button
            onClick={() => { setGroupAllBeams(true); setSelectedFamily(''); setTweakedBreaks({}); }}
            style={{ padding: '3px 8px', border: `1px solid ${BORDER.strong}`, borderRadius: 5, fontSize: 10, cursor: 'pointer',
              background: groupAllBeams ? ACCENT.primary : 'white', color: groupAllBeams ? 'white' : INK.base }}
            title="Cluster all beams together regardless of section dimensions or material">
            All beams
          </button>
          <span style={{ color: BORDER.strong, margin: '0 2px', fontSize: 12, alignSelf: 'center' }}>|</span>
          <button
            disabled={groupAllBeams}
            onClick={() => { setSplitByFace(v => !v); setTweakedBreaks({}); }}
            style={{ padding: '3px 8px', border: `1px solid ${BORDER.strong}`, borderRadius: 5, fontSize: 10, cursor: groupAllBeams ? 'not-allowed' : 'pointer',
              opacity: groupAllBeams ? 0.4 : 1,
              background: splitByFace && !groupAllBeams ? '#7c3aed' : 'white',
              color: splitByFace && !groupAllBeams ? 'white' : INK.base }}
            title="Split each section family into M⁺-governed (bottom bars) and M⁻-governed (top bars) sub-pools before clustering — prevents mixing sagging and hogging beams in the same group">
            Split by face
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
                style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: `1px solid ${BORDER.strong}`, background: algorithm === alg ? ACCENT.primary : 'white', color: algorithm === alg ? 'white' : INK.base, cursor: 'pointer' }}>
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
              style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: `1px solid ${BORDER.strong}`, background: totalGroups === null && kPerFamily === 'auto' ? ACCENT.primary : 'white', color: totalGroups === null && kPerFamily === 'auto' ? 'white' : INK.base, cursor: 'pointer' }}>
              Auto
            </button>
            {[2, 3, 4, 5].map(k => (
              <button key={k}
                onClick={() => { setKPerFamily(k); setTotalGroups(null); setTweakedBreaks({}); }}
                style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: `1px solid ${BORDER.strong}`, background: totalGroups === null && kPerFamily === k ? ACCENT.primary : 'white', color: totalGroups === null && kPerFamily === k ? 'white' : INK.base, cursor: 'pointer' }}>
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
              style={{ width: 56, fontSize: 11, padding: '2px 6px', borderRadius: 4, border: `1px solid ${totalGroups !== null ? ACCENT.primary : BORDER.strong}`, background: totalGroups !== null ? ACCENT.softBg : 'white', ...MONO_NUM }}
              title="Total design groups across the whole model, distributed across families by demand spread"
            />
            {totalGroups !== null && (
              <button onClick={() => { setTotalGroups(null); setTotalGroupsDraft(''); setTweakedBreaks({}); }}
                style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: `1px solid ${BORDER.strong}`, background: 'white', color: INK.secondary, cursor: 'pointer' }}>
                clear
              </button>
            )}
          </div>
          {totalGroups !== null && (
            <div style={{ fontSize: 10, color: INK.secondary, marginTop: 2 }}>
              ≈ {baseSuggestions.reduce((s, sg) => s + sg.bins.length, 0)} across {baseSuggestions.length} famil{baseSuggestions.length === 1 ? 'y' : 'ies'}
            </div>
          )}
        </div>
      </div>

      {/* Family selector — hidden when all-beams mode has a single pseudo-family */}
      {families.length > 1 && (
        <div>
          <div style={lbl}>{groupAllBeams ? 'Pool' : 'Section family'}</div>
          <Dropdown
            value={activeFamily}
            options={baseSuggestions.map(s => {
              const count = s.bins.reduce((sum, b) => sum + b.memberIds.length, 0);
              const faceLabel = s.face === 'bot' ? ' — M⁺ gov' : s.face === 'top' ? ' — M⁻ gov' : '';
              // Mark families with a user-set group count (✎) vs auto-grouped.
              const custom = !!tweakedBreaks[s.familyKey];
              const grp = custom ? tweakedBreaks[s.familyKey].length + 1 : s.bins.length;
              const tag = custom ? `✎ ${grp} grp` : `auto ${grp}`;
              return { value: s.familyKey, label: `${displayFamilyLabel(s.familyLabel, units)}${faceLabel} (${count} beams) · ${tag}` };
            })}
            onChange={setSelectedFamily}
            style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, border: `1px solid ${BORDER.strong}`, width: '100%' }}
          />
        </div>
      )}

      {/* Per-family group-count override — set a custom number for JUST the family
          selected above; every other family keeps the global "Groups / family". */}
      {families.length > 1 && totalGroups === null && activeSuggestion && (
        <div style={{ marginTop: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ ...lbl, marginBottom: 0 }}>Groups for this family</div>
            {familyIsCustom
              ? <span style={{ fontSize: 9, color: ACCENT.primary, fontWeight: 700 }}>✎ custom ({familyGroupCount})</span>
              : <span style={{ fontSize: 9, color: INK.muted }}>auto ({familyGroupCount})</span>}
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
            <button onClick={() => setFamilyK('auto')}
              style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: `1px solid ${BORDER.strong}`, background: !familyIsCustom ? ACCENT.primary : 'white', color: !familyIsCustom ? 'white' : INK.base, cursor: 'pointer' }}>
              Auto
            </button>
            {[2, 3, 4, 5].map(k => (
              <button key={k} onClick={() => setFamilyK(k)}
                style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: `1px solid ${BORDER.strong}`, background: familyIsCustom && familyGroupCount === k ? ACCENT.primary : 'white', color: familyIsCustom && familyGroupCount === k ? 'white' : INK.base, cursor: 'pointer' }}>
                {k}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 9, color: INK.muted, marginTop: 3 }}>
            Overrides “Groups / family” for {displayFamilyLabel(activeSuggestion.familyLabel, units)} only — the dropdown marks ✎ custom families.
          </div>
        </div>
      )}

      {/* Histogram */}
      {activeSuggestion && (() => {
        // Use poolMetric (may differ from panel metric in face-split mode)
        const q: Quantity | null = poolMetric === 'Vu' ? 'force' : poolMetric === 'governing' ? null : 'moment';
        const dispVals = q ? vals.map(v => toDisplay(v, q)) : vals;
        const dispBreaks = q ? currentBreaks.map(b => toDisplay(b, q)) : currentBreaks;
        const xLabelDisp = poolMetric === 'governing' ? 'Governing demand →'
          : poolMetric === 'Vu' ? `Shear (${unitLabel('force')}) →`
          : poolMetric === 'Mu_pos' ? `M⁺ (${unitLabel('moment')}) →`
          : `M⁻ (${unitLabel('moment')}) →`;
        return (
          <div>
            <div style={{ ...lbl, marginBottom: 6 }}>
              Demand distribution — {displayFamilyLabel(activeSuggestion.familyLabel, units)}
              <span style={{ marginLeft: 6, color: ACCENT.primary }}>GVF {(activeSuggestion.gvf * 100).toFixed(0)}%</span>
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
          const worstDemand = Math.max(...familyDemands.filter(d => mIds.includes(d.memberId)).map(d => demandValueFor(d, poolMetric)));
          const q: Quantity | null = poolMetric === 'Vu' ? 'force' : poolMetric === 'governing' ? null : 'moment';
          const demandStr = poolMetric === 'governing'
            ? `${(worstDemand * 100).toFixed(0)}%`
            : `${Math.round(toDisplay(worstDemand, q!))} ${unitLabel(q!)}`;
          return (
            <div key={bi}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', cursor: 'pointer' }}
              onMouseEnter={() => highlightBin(bi)}
              onMouseLeave={clearHighlight}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: previewColor(bi), flexShrink: 0 }} />
              <span style={{ fontSize: 11, flex: 1 }}>Group {bi + 1}</span>
              <span style={{ fontSize: 10, color: INK.secondary }}>{mIds.length} beams</span>
              <span style={{ fontSize: 10, color: INK.base, ...MONO_NUM }}>{demandStr}</span>
            </div>
          );
        })}
      </div>

      {/* Group name template + live preview. Empty = legacy "letter_dim_faceN". */}
      <div style={{ borderTop: `1px solid ${BORDER.default}`, paddingTop: 8 }}>
        <div style={lbl}>Group name template <span style={{ color: INK.muted }}>(optional)</span></div>
        <input
          value={nameTemplate}
          onChange={e => setNameTemplate(e.target.value)}
          // Seed the template on first click so the format is right there to
          // tweak, not typed from scratch. Only once — clearing it stays cleared.
          onFocus={() => { if (!templateSeeded && !nameTemplate) { setNameTemplate(NAME_TEMPLATE_HINT); setTemplateSeeded(true); } }}
          placeholder="e.g.  {type}-{depth}-{seq}"
          spellCheck={false}
          style={{ width: '100%', fontSize: 12, padding: '5px 8px', borderRadius: 5, border: `1px solid ${nameTemplate.trim() ? ACCENT.primary : BORDER.strong}`, boxSizing: 'border-box', ...MONO_NUM }}
        />
        <div style={{ fontSize: 9, color: INK.muted, marginTop: 3, lineHeight: 1.6 }}>
          {GROUP_NAME_TOKENS.map(t => `${t.token} ${t.desc}`).join('  ·  ')}
        </div>
        {plannedGroups.length > 0 && (
          <div style={{ fontSize: 10.5, color: INK.secondary, marginTop: 5 }}>
            Names:{' '}
            <span style={{ color: ACCENT.primary, fontWeight: 600, ...MONO_NUM }}>
              {plannedGroups.slice(0, 4).map(g => g.label).join(',  ')}{plannedGroups.length > 4 ? ' …' : ''}
            </span>
            {plannedGroups.some(g => g.face) && (
              <div style={{ fontSize: 9.5, color: INK.muted, marginTop: 2 }}>
                Split by face → the legend shows the name; the dashboard adds{' '}
                <span style={{ color: '#7c3aed', fontWeight: 700 }}>(T)</span>/<span style={{ color: '#7c3aed', fontWeight: 700 }}>(B)</span>.
              </div>
            )}
          </div>
        )}
      </div>

      <button
        onClick={handleApply}
        style={{ background: ACCENT.primary, color: 'white', border: 'none', borderRadius: 6, padding: '7px 0', fontWeight: 600, fontSize: 12, cursor: 'pointer', width: '100%' }}>
        Commit as Design Groups
      </button>
      <div style={{ fontSize: 10, color: INK.muted }}>
        Overlay is reference-only. Commit replaces existing auto-groups; manual groups untouched.
      </div>
    </div>
  );
}
