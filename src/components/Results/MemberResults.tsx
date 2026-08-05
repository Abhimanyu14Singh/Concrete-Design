import { useState } from 'react';
import type { Member, DesignResults, RebarLayout, DesignCode, OverrideKey, MemberOverride, SconcreteResult, BarGroup } from '../../types';
import { memberScoSummary, scoAgreesWithApp } from '../../utils/sconcreteMemberResult';
import { DEFAULT_CRACK_PARAMS } from '../../types';
import {
  OVERRIDE_KEY_LABEL, failingKeys, isOverridden, effectiveStatus,
  visibleWarnings, overrideEntries,
} from '../../utils/overrides';
import { runDesign } from '../../engines';
import { resolveCrack } from '../../utils/resolveCrack';
import { coverFor, zonedShearCheck, zoneShearDemands } from '../../utils/concreteDesign';
import { zonedShearCheckEC2 } from '../../engines/ec2/ec2Beam';
import { capacityLabels } from '../../utils/units';
import { formatBarLabel } from '../../utils/rebar';
import { useUnits } from '../../contexts/UnitsContext';
import SectionView from '../Detailing/SectionView';
import ElevationView from '../Detailing/ElevationView';
import ForceDiagram from '../Detailing/ForceDiagram';
import CalcBreakdownModal from './CalcBreakdownModal';
import CodeBadge from '../common/CodeBadge';
import InfoTooltip from '../common/InfoTooltip';
import Dropdown from '../common/Dropdown';
import { ACCENT, BORDER, DCR, ICON, INK, LABEL_STYLE, MEMBER_COLOR, MONO_NUM, STATUS, SURFACE, TRACK, TYPE, codeAccent, dcrBg as themeDcrBg, dcrColor as themeDcrColor } from '../../theme';
import { Icon } from '../common/Icon';
import type { IconName } from '../common/Icon';
import { flexSteelRatioPct } from '../../utils/autoGroup';

interface Props {
  member: Member;
  code?: DesignCode;
  /** Project-level EC2 SLS quasi-permanent combo name (auto-applied to crack checks). */
  slsCombo?: string;
  /** Project-level EC2 §6.2.3 strut angle cotθ (default 2.5). */
  cotTheta?: number;
  ignoreTorsion?: boolean;
  /** Project engineer name — pre-fills the "Reviewed by" field on overrides. */
  engineer?: string;
  /** Persisted S-Concrete batch results (for the verification card). */
  sconcreteResults?: SconcreteResult[];
  /** ISO timestamp of the last S-Concrete batch run. */
  sconcreteRanAt?: string;
  onRebarChange?: (updated: Member) => void;
  /** The member's group per-region top cages — passed to the moment diagram so its
   *  stepped hogging capacity reflects the middle-third / opposite-end top steel. */
  midThirdTopBars?: BarGroup[];
  oppositeTopBars?: BarGroup[];
  /** The member's group reduced end-third bottom cage — passed to the moment
   *  diagram so its stepped sagging capacity (φMn⁺) reflects the end-third steel. */
  endThirdBotBars?: BarGroup[];
}

function KV({ k, v, dcr, tip, formula, overridden }: { k: string; v: string; dcr?: number; tip?: string; formula?: string; overridden?: boolean }) {
  // An engineer-overridden check renders green regardless of its true DCR.
  const dcrColor = overridden ? DCR.pass : dcr !== undefined ? themeDcrColor(dcr) : undefined;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid #f3f4f6', gap: 8, minWidth: 0 }}>
      <span style={{ fontSize: 11, color: INK.secondary, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        {k}{tip && <InfoTooltip text={tip} formula={formula} />}
      </span>
      <span style={{ fontSize: 11, color: dcrColor ?? INK.strong, ...MONO_NUM, fontWeight: dcr !== undefined ? 700 : 400 }}>
        {v}{overridden && <span title="Reviewed by engineer" style={{ marginLeft: 4 }}>✓</span>}
      </span>
    </div>
  );
}

function SectionLabel({ title, icon }: { title: string; icon?: IconName }) {
  return (
    <div style={{ ...LABEL_STYLE, margin: '10px 0 4px', display: 'flex', alignItems: 'center', gap: 6 }}>
      {icon && <Icon name={icon} size={ICON.sm} />}{title}
    </div>
  );
}

/** A collapsible results check. The governing check (highest DCR) opens by
 *  default; the rest collapse to a header + DCR chip so the column isn't a wall
 *  of 15-20 numbers. */
function CheckSection({ title, icon, dcr, defaultOpen, onJumpToGoverning, children }: { title: string; icon?: IconName; dcr?: number; defaultOpen: boolean; onJumpToGoverning?: (title: string) => void; children: React.ReactNode }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? defaultOpen;
  return (
    <div>
      <button
        // Expanding a check jumps the applied loads / calc sheet / diagram to the
        // load case that GOVERNS this specific check — so the numbers below (and the
        // Calc Sheet) match the chip, which is the worst DCR across all load rows.
        onClick={() => { const willOpen = !open; setOverride(willOpen); if (willOpen) onJumpToGoverning?.(title); }}
        title={onJumpToGoverning ? `Show the load case that governs ${title} (the chip is the worst across all load rows)` : undefined}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '10px 0 4px', margin: 0 }}
      >
        <span style={{ ...LABEL_STYLE, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-block', width: 10, color: INK.muted }}>{open ? '▾' : '▸'}</span>
          {icon && <Icon name={icon} size={ICON.sm} />}{title}
        </span>
        {dcr !== undefined && <span style={dcrStyle(dcr)}>{dcr.toFixed(2)}</span>}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

function dcrStyle(dcr: number): React.CSSProperties {
  return { background: themeDcrBg(dcr), color: themeDcrColor(dcr), fontWeight: 700, ...MONO_NUM, padding: '1px 5px', borderRadius: 4, fontSize: 11 };
}

const fmtUtil = (v: number | null): string => (v == null ? '—' : v.toFixed(2));
const utilColor = (v: number | null): string => (v == null ? INK.muted : themeDcrColor(v));

export default function MemberResults({ member, code = 'ACI318-19', slsCombo, cotTheta, ignoreTorsion, engineer, sconcreteResults, sconcreteRanAt, onRebarChange, midThirdTopBars, oppositeTopBars, endThirdBotBars }: Props) {
  const [activeLoad, setActiveLoad] = useState(''); // '' = auto (governing-overall case)
  const [showCalc, setShowCalc] = useState(false);
  const [showAllLC, setShowAllLC] = useState(false);
  const [elevZoom, setElevZoom] = useState(1);
  const [showReviewForm, setShowReviewForm] = useState(false);
  const { fmt } = useUnits();
  const cap = capacityLabels(code);

  // Design EVERY load row once. The member tab must report the GOVERNING DCR per
  // check across all rows — a beam now carries many per-station rows and different
  // rows govern different checks, so a single row (the old loads[0]) understated
  // DCRs and could hide an NG on another row.
  const crackP = resolveCrack(member, code, slsCombo);
  const allRowResults = member.loads.map(l => ({
    id: l.id,
    r: runDesign(member.section, member.material, member.rebar, l, member.span, code, crackP, cotTheta, ignoreTorsion),
  }));
  const rowMax = (r: DesignResults) => Math.max(
    r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear, r.DCR_torsion,
    r.DCR_crack ?? 0, r.VT_util ?? 0, r.DCR_PM ?? 0, r.DCR_axial ?? 0,
  );
  // The drill-in view (applied loads, section diagram, calc sheet) defaults to the
  // worst-overall load case rather than loads[0]; the dropdown still lets the user
  // pick any row.
  const govOverallId = allRowResults.length
    ? allRowResults.reduce((a, b) => rowMax(b.r) > rowMax(a.r) ? b : a).id : undefined;
  const load = member.loads.find(l => l.id === (activeLoad || govOverallId)) ?? member.loads[0];
  const result: DesignResults = allRowResults.find(a => a.id === load.id)?.r
    ?? runDesign(member.section, member.material, member.rebar, load, member.span, code, crackP, cotTheta, ignoreTorsion);

  // Governing display result: load-independent capacities (φMn, φVn, φTn, Vc, Vs,
  // Tcr, As_min/max) are kept from the active case; DCRs, required steel, crack
  // widths and warnings are lifted to the worst across ALL rows so the check chips
  // and status reflect the true governing envelope, not one row.
  const maxOf = (sel: (r: DesignResults) => number) => allRowResults.reduce((m, a) => Math.max(m, sel(a.r)), 0);
  const seenW = new Set<string>();
  const govWarnings = allRowResults.flatMap(a => a.r.warnings).filter(w => {
    const k = `${w.code}|${w.message}`; if (seenW.has(k)) return false; seenW.add(k); return true;
  });
  const govPeak = allRowResults.reduce((m, a) => Math.max(m, rowMax(a.r)), 0);
  const govResult: DesignResults = {
    ...result,
    DCR_flex_pos: maxOf(r => r.DCR_flex_pos), DCR_flex_neg: maxOf(r => r.DCR_flex_neg),
    DCR_shear: maxOf(r => r.DCR_shear), DCR_torsion: maxOf(r => r.DCR_torsion),
    DCR_PM: result.DCR_PM !== undefined ? maxOf(r => r.DCR_PM ?? 0) : undefined,
    DCR_axial: result.DCR_axial !== undefined ? maxOf(r => r.DCR_axial ?? 0) : undefined,
    VT_util: maxOf(r => r.VT_util ?? 0),
    DCR_crack: maxOf(r => r.DCR_crack ?? 0),
    wk_bot: maxOf(r => r.wk_bot ?? 0), wk_top: maxOf(r => r.wk_top ?? 0),
    wk_face: result.wk_face !== undefined ? maxOf(r => r.wk_face ?? 0) : undefined,
    As_req_pos: maxOf(r => r.As_req_pos), As_req_neg: maxOf(r => r.As_req_neg),
    warnings: govWarnings,
    status: govPeak > 1 ? 'NG' : (govWarnings.length ? 'Warning' : 'OK'),
  };

  // S-Concrete verification: the persisted .SCRS result for THIS member, next to
  // the app's own governing DCR (worst across all its load cases) so the engineer
  // can see whether the two tools agree.
  const scoSummary = memberScoSummary(sconcreteResults, member.id);
  const appGovDCR = govPeak; // worst DCR across all load rows (reused from above)
  const scoAgree = scoAgreesWithApp(scoSummary?.status ?? null, appGovDCR);
  const scoEligible = true; // every member is a beam

  // R6: per-section governing DCRs so the results column can collapse to the
  // governing check (the highest-DCR section stays open; the rest fold to a chip).
  const crackDcr = code === 'EN1992-1-1'
    ? (govResult.DCR_crack ?? Math.max(
        (govResult.wk_bot ?? 0) / (member.crackParams?.wLimitBot ?? 0.3),
        (govResult.wk_top ?? 0) / (member.crackParams?.wLimitTop ?? 0.3),
        govResult.wk_face !== undefined ? govResult.wk_face / (member.crackParams?.wLimitFace ?? 0.3) : 0,
      ))
    : 0;
  const anyTorsion = member.loads.some(l => l.Tu > 0);
  const secDcr: Record<string, number> = {
        Flexure: Math.max(govResult.DCR_flex_pos, govResult.DCR_flex_neg),
        Shear: govResult.DCR_shear,
        // Torsion checks are suppressed entirely when the project neglects torsion.
        ...(ignoreTorsion ? {} : { Torsion: govResult.DCR_torsion }),
        // EC2 combined shear+torsion link check (S-CONCRETE "V&T Util") — only
        // meaningful, and only shown, when torsion is applied (and not neglected).
        ...(code === 'EN1992-1-1' && anyTorsion && !ignoreTorsion ? { 'Shear + Torsion Links': govResult.VT_util ?? 0 } : {}),
        ...(code === 'EN1992-1-1' ? { 'Crack Width §7.3.4': crackDcr } : {}),
      };
  const maxSecDcr = Math.max(...Object.values(secDcr), 0);
  const isGov = (title: string) => secDcr[title] === maxSecDcr && maxSecDcr > 0;

  // Per-zone shear DCRs for beams with zoned stirrups + station forces
  const zoneResults = member.memberType === 'beam' && member.rebar.tieZones && member.stationForces?.length
    ? code === 'EN1992-1-1'
      ? zonedShearCheckEC2(
          member.section, member.material, member.rebar,
          zoneShearDemands(member.stationForces, member.span ?? 20),
          cotTheta ?? 2.5,
        )
      : zonedShearCheck(
          member.section, member.material, member.rebar,
          zoneShearDemands(member.stationForces, member.span ?? 20),
          load.Pu,
        )
    : [];

  // C1: compute all-LC results to find governing cases
  const allResults = member.loads.map(l => ({
    id: l.id, label: l.label,
    r: runDesign(member.section, member.material, member.rebar, l, member.span, code, resolveCrack(member, code, slsCombo), cotTheta, ignoreTorsion),
  }));
  const govFlexPos  = allResults.reduce((a, b) => b.r.DCR_flex_pos  > a.r.DCR_flex_pos  ? b : a).id;
  const govFlexNeg  = allResults.reduce((a, b) => b.r.DCR_flex_neg  > a.r.DCR_flex_neg  ? b : a).id;
  const govShear    = allResults.reduce((a, b) => b.r.DCR_shear     > a.r.DCR_shear     ? b : a).id;
  const govTorsion  = allResults.reduce((a, b) => b.r.DCR_torsion   > a.r.DCR_torsion   ? b : a).id;
  const govPM       = allResults.reduce((a, b) => (b.r.DCR_PM ?? 0) > (a.r.DCR_PM ?? 0) ? b : a).id;
  const govSet      = new Set([govFlexPos, govFlexNeg, govShear, govTorsion]);

  // The check chips report the GOVERNING DCR across all load rows, but the applied
  // loads / calc sheet show ONE selected case. Expanding a check jumps the selected
  // case to the row that governs THAT check, so the two agree. Keyed by section title.
  const worstIdBy = (sel: (r: DesignResults) => number) =>
    allResults.reduce((a, b) => sel(b.r) > sel(a.r) ? b : a).id;
  const govCaseFor: Record<string, string> = {
    Flexure: worstIdBy(r => Math.max(r.DCR_flex_pos, r.DCR_flex_neg)),
    Shear: govShear,
    Torsion: govTorsion,
    'Shear + Torsion Links': worstIdBy(r => r.VT_util ?? 0),
    'Crack Width §7.3.4': worstIdBy(r => r.DCR_crack ?? 0),
    Axial: worstIdBy(r => r.DCR_axial ?? 0),
    'P-M Interaction': govPM,
  };
  const jumpToGov = (title: string) => { const id = govCaseFor[title]; if (id) setActiveLoad(id); };

  function handleRebarChange(rebar: RebarLayout) {
    onRebarChange?.({ ...member, rebar });
  }

  // C5: rebar optimizer
  function handleOptimize() {
    let best = { ...member.rebar };
    const worstDCR = (r: RebarLayout) => {
      const allR = member.loads.map(l => runDesign(member.section, member.material, { ...member.rebar, ...r }, l, member.span, code, resolveCrack(member, code, slsCombo), cotTheta, ignoreTorsion));
      return Math.max(...allR.map(res => Math.max(res.DCR_flex_pos, res.DCR_flex_neg, res.DCR_shear)));
    };

    let changed = false;
    // Try reducing bottom bars first
    let rebar = { ...member.rebar };
    while (rebar.botBars[0] && rebar.botBars[0].numBars > 1) {
      const candidate = { ...rebar, botBars: [{ ...rebar.botBars[0], numBars: rebar.botBars[0].numBars - 1 }] };
      if (worstDCR(candidate) < 0.90) {
        rebar = candidate;
        changed = true;
      } else break;
    }
    // Try reducing top bars
    while (rebar.topBars[0] && rebar.topBars[0].numBars > 1) {
      const candidate = { ...rebar, topBars: [{ ...rebar.topBars[0], numBars: rebar.topBars[0].numBars - 1 }] };
      if (worstDCR(candidate) < 0.90) {
        rebar = candidate;
        changed = true;
      } else break;
    }

    if (changed) {
      best = rebar;
      onRebarChange?.({ ...member, rebar: best });
    } else {
      alert('Section is already at or near minimum reinforcement. No reduction possible while keeping DCR < 0.90.');
    }
  }

  // Engineer overrides (display-layer only — engine results keep true DCRs).
  const overrides = member.overrides;
  // Status, warnings and the reviewable set all reflect the GOVERNING result across
  // every load row — not the single drilled-in case — so the header pill can never
  // read "All checks pass" while another row is NG.
  const dispStatus = effectiveStatus(govResult, overrides);
  const isReviewed = dispStatus === 'OK' && govResult.status !== 'OK';
  const statusColor = dispStatus === 'OK' ? DCR.pass : dispStatus === 'NG' ? DCR.fail : DCR.warn;
  const statusBg    = dispStatus === 'OK' ? DCR.passBg : dispStatus === 'NG' ? DCR.failBg : DCR.warnBg;
  const shownWarnings = visibleWarnings(govResult.warnings, overrides);
  const reviewable = failingKeys(govResult);

  function applyOverride(ov: MemberOverride) {
    onRebarChange?.({ ...member, overrides: { all: ov } });
    setShowReviewForm(false);
  }
  function clearOverride(key: OverrideKey) {
    const next = { ...(member.overrides ?? {}) };
    delete next[key];
    onRebarChange?.({ ...member, overrides: Object.keys(next).length ? next : undefined });
  }

  const s = member.section;
  const t = member.rebar.ties;

  return (
    <div style={{ background: 'white', borderRadius: 12, padding: 16, borderTop: `3px solid ${codeAccent(code)}` }}>
      {showCalc && (
        <CalcBreakdownModal
          member={member}
          loadId={load.id}
          code={code}
          slsCombo={slsCombo}
          cotTheta={cotTheta}
          onClose={() => setShowCalc(false)}
        />
      )}

      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {/* Load case dropdown — C1: mark governing LC */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={LABEL_STYLE}>Load Case</span>
          <Dropdown
            value={load.id}
            options={member.loads.map(l => ({ value: l.id, label: `${govSet.has(l.id) ? '★ ' : ''}${l.label}` }))}
            onChange={setActiveLoad}
            style={{ padding: '4px 8px', border: `1px solid ${BORDER.strong}`, borderRadius: 6, fontSize: 12, color: INK.strong, background: 'white', cursor: 'pointer' }}
          />
        </div>

        {/* Status pill */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 20, background: statusBg, border: `1px solid ${statusColor}40` }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, display: 'inline-block', flexShrink: 0 }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: statusColor }}>
            {isReviewed ? 'Reviewed by Engineer'
              : dispStatus === 'OK' ? 'All checks pass'
              : dispStatus === 'NG' ? 'Section inadequate'
              : 'Near capacity — review'}
          </span>
        </div>

        {/* Code + member-type badges */}
        <CodeBadge code={code} />
        <span style={{
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: TRACK.wide,
          color: MEMBER_COLOR[member.memberType] ?? INK.secondary,
          background: `${MEMBER_COLOR[member.memberType] ?? INK.secondary}14`,
          border: `1px solid ${MEMBER_COLOR[member.memberType] ?? INK.secondary}40`,
          borderRadius: 12, padding: '2px 8px',
        }}>
          {member.memberType}
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {onRebarChange && (
            <button
              onClick={handleOptimize}
              style={{ padding: '5px 10px', border: `1px solid ${STATUS.warn}`, borderRadius: 6, background: STATUS.warnBg, fontSize: 11, cursor: 'pointer', color: STATUS.warn, fontWeight: 600 }}
              title="Reduce bar count until max DCR ≈ 0.90"
            >
              Optimize
            </button>
          )}
          <button
            onClick={() => setShowCalc(true)}
            style={{ padding: '5px 12px', border: `1px solid ${BORDER.default}`, borderRadius: 6, background: 'white', fontSize: 11, cursor: 'pointer', color: INK.base, fontWeight: 600 }}
          >
            ∑ Calc Sheet
          </button>
        </div>
      </div>

      {/* S-Concrete verification card — the external .SCRS result for this member
          alongside the app's own governing DCR (closes the design ↔ verify loop). */}
      {(scoSummary || scoEligible) && (
        <div style={{ marginBottom: 10, border: `1px solid ${BORDER.default}`, borderRadius: 8, padding: '8px 12px',
          background: scoSummary ? (scoSummary.status === 'OK' ? STATUS.okBg : STATUS.failBg) : SURFACE.subtle }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={LABEL_STYLE}>S-Concrete verification</span>
            {scoSummary ? (
              <>
                <span style={{ fontSize: 11, fontWeight: 700, color: scoSummary.status === 'OK' ? STATUS.ok : STATUS.fail }}>
                  {scoSummary.status === 'OK' ? '✓ OK' : '✗ Overstressed'}
                </span>
                {scoSummary.groupLabel && <span style={{ fontSize: 10, color: INK.secondary }}>group “{scoSummary.groupLabel}”</span>}
                {sconcreteRanAt && <span style={{ marginLeft: 'auto', fontSize: 10, color: INK.muted }}>ran {new Date(sconcreteRanAt).toLocaleString()}</span>}
              </>
            ) : (
              <span style={{ fontSize: 11, color: INK.muted }}>not run for this member — run the S-Concrete batch in Map → Verify</span>
            )}
          </div>
          {scoSummary && (
            <div style={{ display: 'flex', gap: 16, marginTop: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, color: INK.base }}>
              <span>N-M <b style={{ ...MONO_NUM, color: utilColor(scoSummary.nmUtil) }}>{fmtUtil(scoSummary.nmUtil)}</b></span>
              <span>V&amp;T <b style={{ ...MONO_NUM, color: utilColor(scoSummary.vtUtil) }}>{fmtUtil(scoSummary.vtUtil)}</b></span>
              {scoSummary.crackStatus && (
                <span>crack <b style={{ color: scoSummary.crackStatus === 'OK' ? STATUS.ok : STATUS.fail }}>{scoSummary.crackStatus}</b></span>
              )}
              <span style={{ marginLeft: 'auto', color: INK.secondary }}>
                app DCR <b style={{ ...MONO_NUM, color: themeDcrColor(appGovDCR) }}>{appGovDCR.toFixed(2)}</b>
                {scoAgree != null && (
                  <span style={{ marginLeft: 6, fontWeight: 700, color: scoAgree ? STATUS.ok : STATUS.warn }}>
                    {scoAgree ? '· agree' : '· differ ⚠'}
                  </span>
                )}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 3-column layout: properties | section SVG | results. Wraps when the host
          panel is narrow (e.g. the Dashboard Design+Verify split) so the fixed-width
          section/elevation drawings never overflow onto the results column. */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Left: member properties + applied loads */}
        <div style={{ width: 168, flexShrink: 0, fontSize: 11 }}>
          <SectionLabel title="Member" icon="member" />
          <KV k={code === 'EN1992-1-1' ? 'fck (cyl)' : "f'c"} v={fmt(member.material.fc, 'stress')}
            tip={code === 'EN1992-1-1' ? 'Characteristic cylinder compressive strength. Design value fcd = αcc·fck/γc (αcc=0.85, γc=1.5).' : 'Specified 28-day cylinder compressive strength.'} />
          <KV k="fy" v={fmt(member.material.fy / 1000, 'stressKsi')}
            tip={code === 'EN1992-1-1' ? 'Characteristic yield strength of longitudinal reinforcement. Design value fyd = fyk/γs (γs=1.15).' : 'Specified yield strength of longitudinal reinforcement.'} />
          <KV k="λ" v={member.material.lambdaConcrete.toFixed(2)}
            tip="Lightweight concrete modification factor (ACI §19.2.4). 1.0 = normal-weight; 0.75 = all-lightweight." />
          <KV k="b" v={fmt(s.b, 'length')} tip="Section width (flange width for T/L beams)." />
          <KV k="h" v={fmt(s.h, 'length')} tip="Overall section depth. Effective depth d = h − cover − stirrup − bar_radius." />
          {s.bw && <KV k="bw" v={fmt(s.bw, 'length')} tip="Web width — governs shear and torsion calculations." />}
          {s.hf && <KV k="hf" v={fmt(s.hf, 'length')} tip="Flange thickness. Compression block confined to flange when a ≤ hf." />}
          <KV
            k="Cover"
            v={coverFor(s, 'top') === coverFor(s, 'bot') && coverFor(s, 'bot') === coverFor(s, 'side')
              ? fmt(s.coverClear, 'length')
              : `${fmt(coverFor(s, 'top'), 'length')} / ${fmt(coverFor(s, 'bot'), 'length')} / ${fmt(coverFor(s, 'side'), 'length')}`}
            tip="Clear cover to the face of the stirrup (top / bottom / side when they differ). Effective depth = h − cover − stirrupDia − barDia/2."
          />
          {t && <KV k="Stirrups" v={`${formatBarLabel(t.barSize)}@${fmt(t.spacing, 'length')}`} tip="Transverse reinforcement: bar size @ spacing. Vs = Av·fy·d/s per stirrup legs." />}
          {member.span && <KV k="Span" v={fmt(member.span, 'spanLength')} tip="Clear span used for minimum steel and deflection checks." />}

          <SectionLabel title="Applied Loads" icon="loadCases" />
          <>
              {load.Mu_pos > 0 && <KV k="Mu+" v={fmt(load.Mu_pos, 'moment')} tip="Factored sagging (positive) moment at the governing section." />}
              {load.Mu_neg > 0 && <KV k="Mu−" v={fmt(load.Mu_neg, 'moment')} tip="Factored hogging (negative) moment at the governing section." />}
              <KV k="Vu" v={fmt(load.Vu, 'force')} tip="Factored shear demand. Checked against φVn = φ(Vc + Vs)." />
              {load.Tu > 0 && <KV k="Tu" v={fmt(load.Tu, 'moment')} tip="Factored torsional demand. Torsion design required when Tu > φTcr." />}
              {load.Pu !== 0 && <KV k="Pu" v={fmt(load.Pu, 'force')} tip="Axial force on beam (positive = compression). Modifies Vc via σcp term." />}
              {(member.stationForces?.length ?? 0) > 0 && (
                <div style={{ fontSize: 10, color: INK.muted, marginTop: 5, lineHeight: 1.4 }}
                  title="These loads are the ENVELOPE (worst case) across the combos below and every station. If ETABS shows higher, that value is from a combo not listed here — re-import including it, or switch the import Force source to Analysis.">
                  Envelope of {member.stationForces!.length} combo{member.stationForces!.length === 1 ? '' : 's'}:{' '}
                  <span style={{ ...MONO_NUM, color: INK.secondary }}>{member.stationForces!.map(cf => cf.combo).join(', ')}</span>
                </div>
              )}
            </>
        </div>

        {/* Center: Section diagram. minWidth holds the 300px section SVG so the
            row wraps rather than crushing/overflowing it when the panel is narrow. */}
        <div style={{ flex: '1 1 316px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, minWidth: 316 }}>
          <SectionView
            section={member.section}
            rebar={member.rebar}
            result={result}
            width={300}
            height={250}
            onRebarChange={onRebarChange ? handleRebarChange : undefined}
          />
          {member.memberType === 'beam' && (
            <div style={{ width: '100%', maxWidth: 560 }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginBottom: 2 }}>
                {([['−', -0.25], ['fit', 0], ['+', 0.25]] as const).map(([lbl, dz]) => (
                  <button key={lbl}
                    onClick={() => setElevZoom(z => dz === 0 ? 1 : Math.min(2.5, Math.max(1, +(z + dz).toFixed(2))))}
                    title={dz === 0 ? 'Fit' : dz > 0 ? 'Zoom in' : 'Zoom out'}
                    style={{ border: `1px solid ${BORDER.default}`, background: 'white', color: INK.secondary, borderRadius: 5, fontSize: 10, padding: '1px 7px', cursor: 'pointer' }}>
                    {lbl}
                  </button>
                ))}
              </div>
              <div style={{ overflowX: 'auto' }}>
                <ElevationView member={member} width={520} height={member.rebar.tieZones ? 200 : 170} zoom={elevZoom} />
              </div>
            </div>
          )}
          {member.memberType === 'beam' && (member.stationForces?.length ?? 0) > 0 && (
            <ForceDiagram member={member} result={result} code={code} height={130} cotTheta={cotTheta}
              midThirdTopBars={midThirdTopBars} oppositeTopBars={oppositeTopBars} endThirdBotBars={endThirdBotBars} />
          )}
          {onRebarChange && (
            <p style={{ fontSize: 10, color: INK.muted, margin: 0, textAlign: 'center' }}>
              Click bar labels to change count • Left = +1, Right-click = −1
            </p>
          )}
        </div>

        {/* Right: design results */}
        <div style={{ width: 168, flexShrink: 0, fontSize: 11 }}>
          <>
          <CheckSection title="Flexure" icon="flexure" dcr={Math.max(govResult.DCR_flex_pos, govResult.DCR_flex_neg)} onJumpToGoverning={jumpToGov} defaultOpen={isGov('Flexure')}>
          <KV k={`${cap.Mn}+`} v={fmt(result.phi_Mn_pos, 'moment')}
            tip={result.DCR_PM !== undefined
              ? 'Sagging capacity AT THE APPLIED AXIAL LOAD, read off the P-M interaction surface — not the pure-bending value. See the Axial + Flexure check below.'
              : 'Sagging (positive) flexural capacity after applying φ=0.9 (ACI) or 1/γ (EC2). Must exceed Mu+.'}
            formula={code === 'EN1992-1-1' ? 'M_Rd = As·fyd·z·(1 − λ·x/(2d))' : 'φMn = φ·As·fy·(d − a/2)'} />
          <KV k="  DCR" v={govResult.DCR_flex_pos.toFixed(3)} dcr={govResult.DCR_flex_pos} overridden={isOverridden(overrides, 'DCR_flex_pos')}
            tip="Demand-to-Capacity Ratio = Mu+ / φMn+. Must be ≤ 1.0. Values ≥ 0.9 are flagged in amber." />
          <KV k={`${cap.Mn}−`} v={fmt(result.phi_Mn_neg, 'moment')}
            tip="Hogging (negative) flexural capacity. Computed using top steel area." />
          <KV k="  DCR" v={govResult.DCR_flex_neg.toFixed(3)} dcr={govResult.DCR_flex_neg} overridden={isOverridden(overrides, 'DCR_flex_neg')}
            tip="Demand-to-Capacity Ratio = Mu− / φMn−. Must be ≤ 1.0." />
          <KV k="As req+" v={fmt(govResult.As_req_pos, 'area')}
            tip="Minimum bottom steel area to carry Mu+. The engine uses this to flag under-reinforced sections." />
          <KV k="As req−" v={fmt(govResult.As_req_neg, 'area')}
            tip="Minimum top steel area to carry Mu−." />
          <KV k="As min" v={fmt(result.As_min, 'area')}
            tip={code === 'EN1992-1-1' ? 'EC2 §9.2.1.1 minimum: max(0.26·fctm/fyk, 0.0013)·bt·d' : 'ACI §9.6.1 minimum: max(3√f\'c/fy, 200/fy)·bw·d'} />
          <KV k="As max" v={fmt(result.As_max, 'area')}
            tip={code === 'EN1992-1-1' ? 'EC2 §9.2.1.1 maximum: 0.04·Ac' : 'ACI §9.3.3.1 maximum: 0.04·Ag'} />
          <KV k="ρ bot" v={`${flexSteelRatioPct(member, 'bot').toFixed(3)}%`}
            tip="Bottom steel ratio ρ = As,bot / (bw · d). Effective depth d measured to centroid of tension steel." />
          <KV k="ρ top" v={`${flexSteelRatioPct(member, 'top').toFixed(3)}%`}
            tip="Top steel ratio ρ = As,top / (bw · d)." />
          </CheckSection>

          {/* Axial + flexure — only for members that actually carry axial load.
              With Pu = 0 the Flexure section above already tells the whole story. */}
          {govResult.DCR_PM !== undefined && (
          <CheckSection title="Axial + Flexure" icon="pmInteraction" dcr={govResult.DCR_PM} onJumpToGoverning={jumpToGov} defaultOpen={isGov('Axial + Flexure')}>
            <KV k="Pu" v={fmt(result.loadCaseId === govResult.loadCaseId ? (member.loads.find(l => l.id === govResult.loadCaseId)?.Pu ?? 0) : 0, 'force')}
              tip="Factored axial load on this row. Positive = compression, negative = tension." />
            <KV k={(govResult.DCR_axial_tens ?? 0) > 0 ? 'φPnt' : 'φPn,max'}
              v={fmt(Math.abs(govResult.phi_Pn ?? govResult.phi_Pn_max ?? 0), 'force')}
              tip={(govResult.DCR_axial_tens ?? 0) > 0
                ? 'Pure axial tension capacity φPnt = 0.9·Ast·fy — the whole longitudinal cage yielding.'
                : 'ACI §22.4.2.1 axial compression cap φPn,max = 0.80·φ·[0.85f\'c(Ag − Ast) + fy·Ast], φ = 0.65 (tied).'} />
            <KV k="  DCR axial" v={(govResult.DCR_axial || govResult.DCR_axial_tens || 0).toFixed(3)}
              dcr={govResult.DCR_axial || govResult.DCR_axial_tens || 0}
              tip="Axial utilisation alone: |Pu| / φPn in the direction of loading." />
            <KV k="  DCR N-M" v={govResult.DCR_PM.toFixed(3)} dcr={govResult.DCR_PM}
              overridden={isOverridden(overrides, 'DCR_PM')}
              tip="Combined axial + flexure utilisation (ACI §22.4). The load vector (Pu, Mu) is scaled radially onto the φ-interaction surface — this is what S-CONCRETE reports as “N vs M Util”. It GOVERNS over flexure alone: a beam with axial load has less moment capacity than its pure-bending φMn."
              formula="util = |(Pu, Mu)| / |(φPn, φMn) on the surface|" />
          </CheckSection>
          )}

          <CheckSection title="Shear" icon="shear" dcr={govResult.DCR_shear} onJumpToGoverning={jumpToGov} defaultOpen={isGov('Shear')}>
          <KV k={cap.Vc} v={fmt(result.Vc, 'force')}
            tip={code === 'EN1992-1-1' ? 'Concrete shear resistance without links V_Rd,c (§6.2.2). Depends on ρl and fck.' : 'ACI concrete contribution Vc. Includes axial modification.'}
            formula={code === 'EN1992-1-1' ? 'V_Rd,c = [CRd,c·k·(100ρl·fck)^⅓]·bw·d' : undefined} />
          <KV k={cap.Vs} v={fmt(result.Vs, 'force')}
            tip="Steel contribution to shear resistance from stirrups."
            formula={code === 'EN1992-1-1' ? 'V_Rd,s = Asw/s · z · fywd · cotθ' : 'Vs = Av·fy·d/s'} />
          <KV k={cap.Vn} v={fmt(result.phi_Vn, 'force')}
            tip="Total design shear resistance = φ(Vc + Vs). Must exceed Vu." />
          <KV k="  DCR" v={govResult.DCR_shear.toFixed(3)} dcr={govResult.DCR_shear} overridden={isOverridden(overrides, 'DCR_shear')}
            tip="Shear DCR = Vu / φVn. Must be ≤ 1.0." />
          {zoneResults.map(z => (
            <KV key={z.zone} k={`  z${z.zone + 1}@${fmt(z.spacing, 'length')}`} v={z.DCR.toFixed(3)} dcr={z.DCR}
              tip={`Zone ${z.zone + 1} shear DCR using the stirrup spacing in this third of the span.`} />
          ))}
          {code !== 'EN1992-1-1' && <KV k="Av req" v={fmt(result.Av_req, 'areaPerLength')}
            tip="Required shear steel area per unit length = Vu/(φ·fy·d)." />}
          {code !== 'EN1992-1-1' && <KV k="Av min/s" v={fmt(result.Av_min_per_s, 'areaPerLength')}
            tip="ACI §9.6.3 minimum transverse reinforcement: 0.75·√f'c/fyt·bw." />}
          </CheckSection>

          {/* The Torsion chip carries the worse of the §22.7.6 capacity check and
              the §22.7.7.1 cross-section check — a section that crushes must not
              read 0.10 on the header just because its torsion demand is small. */}
          {!ignoreTorsion && (
          <CheckSection title="Torsion" icon="torsion" dcr={Math.max(govResult.DCR_torsion, govResult.DCR_crushing ?? 0)} onJumpToGoverning={jumpToGov} defaultOpen={isGov('Torsion')}>
          {/* ACI prints φTcr and the neglect threshold separately, the way
              S-CONCRETE does: the check triggers on the THRESHOLD (= φTcr/4),
              not on φTcr itself, and the old single row said otherwise. */}
          {code === 'EN1992-1-1' ? (
            <KV k={cap.Tcr} v={fmt(result.Tcr, 'moment')}
              tip="Torsional cracking resistance T_Rd,c. Torsion reinforcement is required once T_Ed exceeds it." />
          ) : (<>
            <KV k="φTcr" v={fmt(0.75 * result.Tcr, 'moment')}
              tip="Cracking torsion φTcr (ACI §22.7.5.1), including the axial modifier √(1 + Nu/(4·Ag·λ√f'c)) — compression raises it, tension lowers it." />
            <KV k="φTth" v={fmt(result.Tu_threshold, 'moment')}
              tip="Threshold torsion (ACI Table 22.7.4.1(a)) = φTcr/4. Torsion may be NEGLECTED below this; above it the section must be designed for torsion." />
          </>)}
          <KV k={cap.Tn} v={fmt(result.phi_Tn, 'moment')}
            tip="Design torsional resistance from closed stirrups. Checked against Tu." />
          <KV k="  DCR" v={govResult.DCR_torsion.toFixed(3)} dcr={govResult.DCR_torsion} overridden={isOverridden(overrides, 'DCR_torsion')}
            tip={code === 'EN1992-1-1'
              ? 'Torsion DCR = T_Ed / T_Rd,c when below cracking threshold; T_Ed / T_Rd,i when above.'
              : 'Torsion DCR = Tu / φTn.'} />
          {/* Cross-section limit for shear + torsion together — the one failure
              mode extra links cannot fix. */}
          {code !== 'EN1992-1-1' && govResult.DCR_crushing !== undefined && (<>
            <KV k="φTn,max" v={fmt(govResult.phi_Tn_max ?? 0, 'moment')}
              tip="Torsion that would exhaust the §22.7.7.1 cross-section limit alongside the concurrent Vu — the torsional headroom the shear demand leaves." />
            <KV k="  DCR sect" v={govResult.DCR_crushing.toFixed(3)} dcr={govResult.DCR_crushing}
              tip="ACI §22.7.7.1 cross-section check: shear and torsion both put diagonal compression into the web, and past this limit the concrete crushes however many stirrups are added. Over 1.0 means ENLARGE THE SECTION."
              formula="√[(Vu/bw·d)² + (Tu·ph/1.7Aoh²)²] ≤ φ(Vc/bw·d + 8λ√f'c)" />
          </>)}
          </CheckSection>
          )}

          {code === 'EN1992-1-1' && anyTorsion && !ignoreTorsion && (govResult.VT_util ?? 0) > 0 && (
            <CheckSection title="Shear + Torsion Links" icon="shear" dcr={govResult.VT_util} onJumpToGoverning={jumpToGov} defaultOpen={isGov('Shear + Torsion Links')}>
              <KV k="  DCR" v={(govResult.VT_util ?? 0).toFixed(3)} dcr={govResult.VT_util}
                tip="Combined shear + torsion transverse-steel utilisation (§6.3.1/§6.3.2). The outer stirrup legs carry the shear demand AND the torsion demand, which add — this is what S-CONCRETE reports as “V & T Util”. Governs the links even when Shear and Torsion each read < 1.0. Reduce by tightening link spacing, adding legs, or using a steeper strut angle cot θ."
                formula="V&T util = V_Ed/(n·z·f_ywd·cotθ)/(A_sw,leg/s) + T_Ed/(2·A_k·f_ywd·cotθ)/(A_sw,leg/s)" />
            </CheckSection>
          )}

          {code === 'EN1992-1-1' && (
            <CheckSection title="Crack Width §7.3.4" icon="crackWidth" dcr={crackDcr} onJumpToGoverning={jumpToGov} defaultOpen={isGov('Crack Width §7.3.4')}>
              <KV k="wk bot" v={`${(govResult.wk_bot ?? 0).toFixed(3)} mm`}
                dcr={(govResult.wk_bot ?? 0) / (member.crackParams?.wLimitBot ?? 0.3)} overridden={isOverridden(overrides, 'DCR_crack')}
                tip="Characteristic crack width at bottom face under quasi-permanent load combination."
                formula="wk = sr,max · (εsm − εcm)" />
              <KV k="wk top" v={`${(govResult.wk_top ?? 0).toFixed(3)} mm`}
                dcr={(govResult.wk_top ?? 0) / (member.crackParams?.wLimitTop ?? 0.3)} overridden={isOverridden(overrides, 'DCR_crack')}
                tip="Characteristic crack width at top face under quasi-permanent combination." />
              {govResult.wk_face !== undefined && (
                <KV k="wk face" v={`${govResult.wk_face.toFixed(3)} mm`}
                  dcr={govResult.wk_face / (member.crackParams?.wLimitFace ?? 0.3)} overridden={isOverridden(overrides, 'DCR_crack')}
                  tip="Side-face crack width (EC2 §7.3.3). Relevant when h > 1000 mm." />
              )}
              <KV k="w limit" v={`${(member.crackParams?.wLimitBot ?? 0.3).toFixed(2)} mm`}
                tip="Crack width limit from EC2 Table 7.1N. Typically 0.30 mm (XC2–XC4) or 0.40 mm (XC1)." />
              {code === 'EN1992-1-1' && (govResult.wk_bot !== undefined || govResult.wk_top !== undefined) && (() => {
                const cp = member.crackParams ?? DEFAULT_CRACK_PARAMS;
                const slsFails = (govResult.wk_bot ?? 0) > cp.wLimitBot || (govResult.wk_top ?? 0) > cp.wLimitTop || (govResult.wk_face !== undefined && govResult.wk_face > cp.wLimitFace);
                const comboLabel = slsCombo ? `SLS combo "${slsCombo}"` : 'ψ·M_Ed (ratio)';
                return (
                  <div style={{ marginTop: 4 }}>
                    <span style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 4, fontWeight: 600,
                      background: slsFails ? STATUS.failBg : STATUS.okBg,
                      color: slsFails ? STATUS.fail : STATUS.ok,
                      border: `1px solid ${slsFails ? '#fca5a5' : '#86efac'}`,
                    }}>
                      {slsFails ? `⚠ Crack width exceeds limit — M_qp from ${comboLabel}` : `✓ Crack width OK — M_qp from ${comboLabel}`}
                    </span>
                  </div>
                );
              })()}
            </CheckSection>
          )}
            </>
        </div>
      </div>

      {/* C2: All-load-cases comparison table */}
      {member.loads.length > 1 && (
        <div style={{ marginTop: 14, borderTop: `1px solid ${BORDER.default}`, paddingTop: 12 }}>
          <button
            onClick={() => setShowAllLC(v => !v)}
            style={{ ...LABEL_STYLE, fontSize: TYPE.label, color: INK.base, background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <span style={{ fontSize: 10 }}>{showAllLC ? '▼' : '▶'}</span>
            All Load Cases ({member.loads.length})
          </button>
          {showAllLC && (
            <div style={{ marginTop: 8, overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: SURFACE.subtle }}>
                    {(['Load Case', 'Flex+ DCR', 'Flex− DCR', 'Shear DCR', 'Torsion DCR', 'Status']
                    ).map(h => (
                      <th key={h} style={{ ...LABEL_STYLE, padding: '6px 10px', textAlign: 'left', borderBottom: `1px solid ${BORDER.default}`, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {allResults.map(({ id, label, r }) => (
                    <tr
                      key={id}
                      style={{ background: id === load.id ? ACCENT.softBg : 'white', cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}
                      onClick={() => setActiveLoad(id)}
                    >
                      <td style={{ padding: '5px 10px', fontWeight: id === load.id ? 700 : 400, color: INK.base }}>
                        {govSet.has(id) && <span style={{ color: STATUS.warn, marginRight: 4 }}>★</span>}
                        {label}
                      </td>
                      <>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_flex_pos)}>{r.DCR_flex_pos.toFixed(3)}</span></td>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_flex_neg)}>{r.DCR_flex_neg.toFixed(3)}</span></td>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_shear)}>{r.DCR_shear.toFixed(3)}</span></td>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_torsion)}>{r.DCR_torsion.toFixed(3)}</span></td>
                        </>
                      <td style={{ padding: '5px 10px', fontWeight: 700, color: r.status === 'OK' ? STATUS.ok : r.status === 'NG' ? STATUS.fail : STATUS.warn, fontSize: 10 }}>
                        {r.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Warnings + engineer review */}
      {(result.warnings.length > 0 || overrideEntries(overrides).length > 0) && (
        <div style={{ marginTop: 16, borderTop: `1px solid ${BORDER.default}`, paddingTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={LABEL_STYLE}>Code Checks / Warnings</div>
            {onRebarChange && reviewable.length > 0 && !showReviewForm && (
              <button
                onClick={() => setShowReviewForm(true)}
                style={{ fontSize: 10, fontWeight: 700, color: DCR.pass, background: DCR.passBg, border: `1px solid ${DCR.pass}40`, borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}
              >
                ✓ Mark as Reviewed
              </button>
            )}
          </div>

          {/* Inline review form */}
          {showReviewForm && (
            <ReviewForm
              onCancel={() => setShowReviewForm(false)}
              onConfirm={applyOverride}
            />
          )}

          {/* Existing engineer reviews (green chips) */}
          {overrideEntries(overrides).map(([key, ov]) => (
            <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px', borderRadius: 6, background: DCR.passBg, border: `1px solid ${DCR.pass}40`, marginBottom: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: DCR.pass, flexShrink: 0, marginTop: 1 }}>✓ Reviewed</span>
              <span style={{ fontSize: 11, color: INK.base, flex: 1 }}>
                {ov.note || 'No note.'}
              </span>
              {onRebarChange && (
                <button onClick={() => clearOverride(key)} title="Remove override"
                  style={{ fontSize: 12, color: INK.muted, background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0, lineHeight: 1 }}>×</button>
              )}
            </div>
          ))}

          {/* Remaining (non-overridden) warnings */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {shownWarnings.map((w, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '4px 8px', borderRadius: 6, background: w.severity === 'error' ? STATUS.failBg : STATUS.warnBg }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: w.severity === 'error' ? STATUS.fail : STATUS.warn, flexShrink: 0, marginTop: 1 }}>{w.code}</span>
                <span style={{ fontSize: 11, color: INK.base }}>{w.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Inline form for stamping the whole member as engineer-reviewed. */
function ReviewForm({ onCancel, onConfirm }: {
  onCancel: () => void;
  onConfirm: (ov: MemberOverride) => void;
}) {
  const [note, setNote] = useState('');
  const inputStyle: React.CSSProperties = { fontSize: 11, padding: '4px 6px', border: `1px solid ${BORDER.strong}`, borderRadius: 6, color: INK.strong, background: 'white' };
  return (
    <div style={{ background: SURFACE.subtle, border: `1px solid ${BORDER.default}`, borderRadius: 8, padding: 10, marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10, color: INK.secondary, fontWeight: 700 }}>
        NOTE (optional)
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
          placeholder="e.g. wk = 0.31 mm vs 0.30 mm limit — acceptable given conservative SLS combo."
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
      </label>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{ fontSize: 11, fontWeight: 600, color: INK.secondary, background: 'white', border: `1px solid ${BORDER.strong}`, borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }}>Cancel</button>
        <button onClick={() => onConfirm({ note: note.trim() || undefined })}
          style={{ fontSize: 11, fontWeight: 700, color: 'white', background: DCR.pass, border: 'none', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }}>
          Confirm Review
        </button>
      </div>
    </div>
  );
}
