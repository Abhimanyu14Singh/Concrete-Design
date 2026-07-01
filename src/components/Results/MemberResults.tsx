import { useState } from 'react';
import type { Member, DesignResults, RebarLayout, DesignCode, OverrideKey, MemberOverride, SconcreteResult } from '../../types';
import { memberScoSummary, scoAgreesWithApp } from '../../utils/sconcreteMemberResult';
import { DEFAULT_CRACK_PARAMS } from '../../types';
import {
  OVERRIDE_KEY_LABEL, failingKeys, isOverridden, effectiveStatus,
  visibleWarnings, overrideEntries,
} from '../../utils/overrides';
import { runDesign } from '../../engines';
import { resolveCrack } from '../../utils/resolveCrack';
import { zonedShearCheck, zoneShearDemands } from '../../utils/concreteDesign';
import { zonedShearCheckEC2 } from '../../engines/ec2/ec2Beam';
import { capacityLabels } from '../../utils/units';
import { formatBarLabel } from '../../utils/rebar';
import { useUnits } from '../../contexts/UnitsContext';
import SectionView from '../Detailing/SectionView';
import ElevationView from '../Detailing/ElevationView';
import ForceDiagram from '../Detailing/ForceDiagram';
import InteractionDiagram from '../Detailing/InteractionDiagram';
import CalcBreakdownModal from './CalcBreakdownModal';
import CodeBadge from '../common/CodeBadge';
import InfoTooltip from '../common/InfoTooltip';
import Dropdown from '../common/Dropdown';
import { codeAccent, dcrColor as themeDcrColor, dcrBg as themeDcrBg, MEMBER_COLOR, DCR } from '../../theme';
import { flexSteelRatioPct } from '../../utils/autoGroup';

interface Props {
  member: Member;
  code?: DesignCode;
  /** Project-level EC2 SLS quasi-permanent combo name (auto-applied to crack checks). */
  slsCombo?: string;
  /** Project engineer name — pre-fills the "Reviewed by" field on overrides. */
  engineer?: string;
  /** Persisted S-Concrete batch results (for the verification card). */
  sconcreteResults?: SconcreteResult[];
  /** ISO timestamp of the last S-Concrete batch run. */
  sconcreteRanAt?: string;
  onRebarChange?: (updated: Member) => void;
}

function KV({ k, v, dcr, tip, formula, overridden }: { k: string; v: string; dcr?: number; tip?: string; formula?: string; overridden?: boolean }) {
  // An engineer-overridden check renders green regardless of its true DCR.
  const dcrColor = overridden ? DCR.pass : dcr !== undefined ? themeDcrColor(dcr) : undefined;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid #f3f4f6', gap: 8, minWidth: 0 }}>
      <span style={{ fontSize: 11, color: '#6b7280', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        {k}{tip && <InfoTooltip text={tip} formula={formula} />}
      </span>
      <span style={{ fontSize: 11, color: dcrColor ?? '#111827', fontFamily: 'monospace', fontWeight: dcr !== undefined ? 700 : 400 }}>
        {v}{overridden && <span title="Reviewed by engineer" style={{ marginLeft: 4 }}>✓</span>}
      </span>
    </div>
  );
}

function SectionLabel({ title }: { title: string }) {
  return <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, margin: '10px 0 4px' }}>{title}</div>;
}

/** A collapsible results check. The governing check (highest DCR) opens by
 *  default; the rest collapse to a header + DCR chip so the column isn't a wall
 *  of 15-20 numbers. */
function CheckSection({ title, dcr, defaultOpen, children }: { title: string; dcr?: number; defaultOpen: boolean; children: React.ReactNode }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? defaultOpen;
  return (
    <div>
      <button
        onClick={() => setOverride(!open)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '10px 0 4px', margin: 0 }}
      >
        <span style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1 }}>
          <span style={{ display: 'inline-block', width: 10, color: '#9ca3af' }}>{open ? '▾' : '▸'}</span>{title}
        </span>
        {dcr !== undefined && <span style={dcrStyle(dcr)}>{dcr.toFixed(2)}</span>}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

function dcrStyle(dcr: number): React.CSSProperties {
  return { background: themeDcrBg(dcr), color: themeDcrColor(dcr), fontWeight: 700, fontFamily: 'monospace', padding: '1px 5px', borderRadius: 4, fontSize: 11 };
}

const fmtUtil = (v: number | null): string => (v == null ? '—' : v.toFixed(2));
const utilColor = (v: number | null): string => (v == null ? '#9ca3af' : themeDcrColor(v));

export default function MemberResults({ member, code = 'ACI318-19', slsCombo, engineer, sconcreteResults, sconcreteRanAt, onRebarChange }: Props) {
  const [activeLoad, setActiveLoad] = useState(member.loads[0]?.id ?? '');
  const [showCalc, setShowCalc] = useState(false);
  const [showAllLC, setShowAllLC] = useState(false);
  const [elevZoom, setElevZoom] = useState(1);
  const [showReviewForm, setShowReviewForm] = useState(false);
  const { fmt } = useUnits();
  const cap = capacityLabels(code);

  const load = member.loads.find(l => l.id === activeLoad) ?? member.loads[0];
  const result: DesignResults = runDesign(member.section, member.material, member.rebar, load, member.span, code, resolveCrack(member, code, slsCombo));

  const isColumn = member.section.type === 'rectangular_column' || member.section.type === 'circular_column';

  // S-Concrete verification: the persisted .SCRS result for THIS member, next to
  // the app's own governing DCR (worst across all its load cases) so the engineer
  // can see whether the two tools agree.
  const scoSummary = memberScoSummary(sconcreteResults, member.id);
  const appGovDCR = (() => {
    let worst = 0;
    for (const l of member.loads) {
      const r = runDesign(member.section, member.material, member.rebar, l, member.span, code, resolveCrack(member, code, slsCombo));
      const g = isColumn
        ? Math.max(r.DCR_PM ?? 0, r.DCR_axial ?? 0, r.DCR_shear ?? 0, r.DCR_torsion ?? 0)
        : Math.max(r.DCR_flex_pos ?? 0, r.DCR_flex_neg ?? 0, r.DCR_shear ?? 0, r.DCR_torsion ?? 0, r.DCR_crack ?? 0);
      if (g > worst) worst = g;
    }
    return worst;
  })();
  const scoAgree = scoAgreesWithApp(scoSummary?.status ?? null, appGovDCR);
  const scoEligible = member.memberType === 'beam' || member.section.type === 'rectangular_column';

  // R6: per-section governing DCRs so the results column can collapse to the
  // governing check (the highest-DCR section stays open; the rest fold to a chip).
  const crackDcr = code === 'EN1992-1-1'
    ? (result.DCR_crack ?? Math.max(
        (result.wk_bot ?? 0) / (member.crackParams?.wLimitBot ?? 0.3),
        (result.wk_top ?? 0) / (member.crackParams?.wLimitTop ?? 0.3),
        result.wk_face !== undefined ? result.wk_face / (member.crackParams?.wLimitFace ?? 0.3) : 0,
      ))
    : 0;
  const secDcr: Record<string, number> = isColumn
    ? { Axial: result.DCR_axial ?? 0, 'P-M Interaction': result.DCR_PM ?? 0, Shear: result.DCR_shear }
    : {
        Flexure: Math.max(result.DCR_flex_pos, result.DCR_flex_neg),
        Shear: result.DCR_shear,
        Torsion: result.DCR_torsion,
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
    r: runDesign(member.section, member.material, member.rebar, l, member.span, code, resolveCrack(member, code, slsCombo)),
  }));
  const govFlexPos  = allResults.reduce((a, b) => b.r.DCR_flex_pos  > a.r.DCR_flex_pos  ? b : a).id;
  const govFlexNeg  = allResults.reduce((a, b) => b.r.DCR_flex_neg  > a.r.DCR_flex_neg  ? b : a).id;
  const govShear    = allResults.reduce((a, b) => b.r.DCR_shear     > a.r.DCR_shear     ? b : a).id;
  const govTorsion  = allResults.reduce((a, b) => b.r.DCR_torsion   > a.r.DCR_torsion   ? b : a).id;
  const govPM       = allResults.reduce((a, b) => (b.r.DCR_PM ?? 0) > (a.r.DCR_PM ?? 0) ? b : a).id;
  const govSet      = isColumn
    ? new Set([govPM, govShear])
    : new Set([govFlexPos, govFlexNeg, govShear, govTorsion]);

  function handleRebarChange(rebar: RebarLayout) {
    onRebarChange?.({ ...member, rebar });
  }

  // C5: rebar optimizer
  function handleOptimize() {
    let best = { ...member.rebar };
    const worstDCR = (r: RebarLayout) => {
      const allR = member.loads.map(l => runDesign(member.section, member.material, { ...member.rebar, ...r }, l, member.span, code, resolveCrack(member, code, slsCombo)));
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
  const dispStatus = effectiveStatus(result, overrides);
  const isReviewed = dispStatus === 'OK' && result.status !== 'OK';
  const statusColor = dispStatus === 'OK' ? DCR.pass : dispStatus === 'NG' ? DCR.fail : DCR.warn;
  const statusBg    = dispStatus === 'OK' ? DCR.passBg : dispStatus === 'NG' ? DCR.failBg : DCR.warnBg;
  const shownWarnings = visibleWarnings(result.warnings, overrides);
  const reviewable = failingKeys(result);

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
          loadId={activeLoad || member.loads[0]?.id}
          code={code}
          slsCombo={slsCombo}
          onClose={() => setShowCalc(false)}
        />
      )}

      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {/* Load case dropdown — C1: mark governing LC */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1 }}>Load Case</span>
          <Dropdown
            value={activeLoad}
            options={member.loads.map(l => ({ value: l.id, label: `${govSet.has(l.id) ? '★ ' : ''}${l.label}` }))}
            onChange={setActiveLoad}
            style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, color: '#111827', background: 'white', cursor: 'pointer' }}
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
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
          color: MEMBER_COLOR[member.memberType] ?? '#6b7280',
          background: `${MEMBER_COLOR[member.memberType] ?? '#6b7280'}14`,
          border: `1px solid ${MEMBER_COLOR[member.memberType] ?? '#6b7280'}40`,
          borderRadius: 12, padding: '2px 8px',
        }}>
          {isColumn ? 'Column' : member.memberType}
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {onRebarChange && !isColumn && (
            <button
              onClick={handleOptimize}
              style={{ padding: '5px 10px', border: '1px solid #d97706', borderRadius: 6, background: '#fffbeb', fontSize: 11, cursor: 'pointer', color: '#d97706', fontWeight: 600 }}
              title="Reduce bar count until max DCR ≈ 0.90"
            >
              Optimize
            </button>
          )}
          <button
            onClick={() => setShowCalc(true)}
            style={{ padding: '5px 12px', border: '1px solid #e5e7eb', borderRadius: 6, background: 'white', fontSize: 11, cursor: 'pointer', color: '#374151', fontWeight: 600 }}
          >
            ∑ Calc Sheet
          </button>
        </div>
      </div>

      {/* S-Concrete verification card — the external .SCRS result for this member
          alongside the app's own governing DCR (closes the design ↔ verify loop). */}
      {(scoSummary || scoEligible) && (
        <div style={{ marginBottom: 10, border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px',
          background: scoSummary ? (scoSummary.status === 'OK' ? '#f0fdf4' : '#fef2f2') : '#f9fafb' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5, color: '#6b7280' }}>S-Concrete verification</span>
            {scoSummary ? (
              <>
                <span style={{ fontSize: 11, fontWeight: 700, color: scoSummary.status === 'OK' ? '#16a34a' : '#dc2626' }}>
                  {scoSummary.status === 'OK' ? '✓ OK' : '✗ Overstressed'}
                </span>
                {scoSummary.groupLabel && <span style={{ fontSize: 10, color: '#6b7280' }}>group “{scoSummary.groupLabel}”</span>}
                {sconcreteRanAt && <span style={{ marginLeft: 'auto', fontSize: 10, color: '#9ca3af' }}>ran {new Date(sconcreteRanAt).toLocaleString()}</span>}
              </>
            ) : (
              <span style={{ fontSize: 11, color: '#9ca3af' }}>not run for this member — run the S-Concrete batch in Map → Verify</span>
            )}
          </div>
          {scoSummary && (
            <div style={{ display: 'flex', gap: 16, marginTop: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, color: '#374151' }}>
              <span>N-M <b style={{ fontFamily: 'monospace', color: utilColor(scoSummary.nmUtil) }}>{fmtUtil(scoSummary.nmUtil)}</b></span>
              <span>V&amp;T <b style={{ fontFamily: 'monospace', color: utilColor(scoSummary.vtUtil) }}>{fmtUtil(scoSummary.vtUtil)}</b></span>
              {scoSummary.crackStatus && (
                <span>crack <b style={{ color: scoSummary.crackStatus === 'OK' ? '#16a34a' : '#dc2626' }}>{scoSummary.crackStatus}</b></span>
              )}
              <span style={{ marginLeft: 'auto', color: '#6b7280' }}>
                app DCR <b style={{ fontFamily: 'monospace', color: themeDcrColor(appGovDCR) }}>{appGovDCR.toFixed(2)}</b>
                {scoAgree != null && (
                  <span style={{ marginLeft: 6, fontWeight: 700, color: scoAgree ? '#16a34a' : '#d97706' }}>
                    {scoAgree ? '· agree' : '· differ ⚠'}
                  </span>
                )}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 3-column layout: properties | section SVG | results */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* Left: member properties + applied loads */}
        <div style={{ width: 168, flexShrink: 0, fontSize: 11 }}>
          <SectionLabel title="Member" />
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
          <KV k="Cover" v={fmt(s.coverClear, 'length')} tip="Clear cover to the face of the stirrup. Effective depth = h − cover − stirrupDia − barDia/2." />
          {t && <KV k="Stirrups" v={`${formatBarLabel(t.barSize)}@${fmt(t.spacing, 'length')}`} tip="Transverse reinforcement: bar size @ spacing. Vs = Av·fy·d/s per stirrup legs." />}
          {member.span && <KV k="Span" v={fmt(member.span, 'spanLength')} tip="Clear span used for minimum steel and deflection checks." />}

          <SectionLabel title="Applied Loads" />
          {isColumn ? (
            <>
              <KV k="Pu" v={fmt(load.Pu, 'force')} tip="Factored axial demand (positive = compression). Checked against φPn on the P-M interaction surface." />
              <KV k="Mux" v={fmt(load.Mux ?? 0, 'moment')} tip="Factored moment about X-axis (strong axis). Combined with Pu on interaction diagram." />
              <KV k="Muy" v={fmt(load.Muy ?? 0, 'moment')} tip="Factored moment about Y-axis (weak axis). Combined with Pu on interaction diagram." />
              <KV k="Vu" v={fmt(load.Vu, 'force')} tip="Factored shear demand." />
            </>
          ) : (
            <>
              {load.Mu_pos > 0 && <KV k="Mu+" v={fmt(load.Mu_pos, 'moment')} tip="Factored sagging (positive) moment at the governing section." />}
              {load.Mu_neg > 0 && <KV k="Mu−" v={fmt(load.Mu_neg, 'moment')} tip="Factored hogging (negative) moment at the governing section." />}
              <KV k="Vu" v={fmt(load.Vu, 'force')} tip="Factored shear demand. Checked against φVn = φ(Vc + Vs)." />
              {load.Tu > 0 && <KV k="Tu" v={fmt(load.Tu, 'moment')} tip="Factored torsional demand. Torsion design required when Tu > φTcr." />}
              {load.Pu !== 0 && <KV k="Pu" v={fmt(load.Pu, 'force')} tip="Axial force on beam (positive = compression). Modifies Vc via σcp term." />}
            </>
          )}
        </div>

        {/* Center: Section diagram */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, minWidth: 0 }}>
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
                    style={{ border: '1px solid #e5e7eb', background: 'white', color: '#6b7280', borderRadius: 5, fontSize: 10, padding: '1px 7px', cursor: 'pointer' }}>
                    {lbl}
                  </button>
                ))}
              </div>
              <div style={{ overflowX: elevZoom > 1 ? 'auto' : 'visible' }}>
                <ElevationView member={member} width={520} height={member.rebar.tieZones ? 200 : 170} zoom={elevZoom} />
              </div>
            </div>
          )}
          {member.memberType === 'beam' && (member.stationForces?.length ?? 0) > 0 && (
            <ForceDiagram member={member} result={result} code={code} height={130} />
          )}
          {onRebarChange && (
            <p style={{ fontSize: 10, color: '#9ca3af', margin: 0, textAlign: 'center' }}>
              Click bar labels to change count • Left = +1, Right-click = −1
            </p>
          )}
        </div>

        {/* Right: design results */}
        <div style={{ width: 168, flexShrink: 0, fontSize: 11 }}>
          {isColumn ? (
            <>
              <CheckSection title="Axial" dcr={result.DCR_axial ?? 0} defaultOpen={isGov('Axial')}>
                <KV k={code === 'EN1992-1-1' ? 'N_Rd,max' : 'φPn,max'} v={fmt(result.phi_Pn_max ?? 0, 'force')} />
                <KV k="  DCR" v={(result.DCR_axial ?? 0).toFixed(3)} dcr={result.DCR_axial ?? 0} overridden={isOverridden(overrides, 'DCR_axial')} />
              </CheckSection>

              <CheckSection title="P-M Interaction" dcr={result.DCR_PM ?? 0} defaultOpen={isGov('P-M Interaction')}>
                <KV k={code === 'EN1992-1-1' ? 'M_Rd,x @NEd' : 'φMnx @Pu'} v={fmt(result.phi_Mnx ?? 0, 'moment')} />
                <KV k={code === 'EN1992-1-1' ? 'M_Rd,y @NEd' : 'φMny @Pu'} v={fmt(result.phi_Mny ?? 0, 'moment')} />
                <KV k="  DCR" v={(result.DCR_PM ?? 0).toFixed(3)} dcr={result.DCR_PM ?? 0} overridden={isOverridden(overrides, 'DCR_PM')} />
              </CheckSection>

              <CheckSection title="Shear" dcr={result.DCR_shear} defaultOpen={isGov('Shear')}>
                <KV k={cap.Vc} v={fmt(result.Vc, 'force')} />
                <KV k={cap.Vs} v={fmt(result.Vs, 'force')} />
                <KV k={cap.Vn} v={fmt(result.phi_Vn, 'force')} />
                <KV k="  DCR" v={result.DCR_shear.toFixed(3)} dcr={result.DCR_shear} overridden={isOverridden(overrides, 'DCR_shear')} />
              </CheckSection>

              <CheckSection title="Steel Limits" defaultOpen={false}>
                <KV k="As min" v={fmt(result.As_min, 'area')} />
                <KV k="As max" v={fmt(result.As_max, 'area')} />
              </CheckSection>
            </>
          ) : (
            <>
          <CheckSection title="Flexure" dcr={Math.max(result.DCR_flex_pos, result.DCR_flex_neg)} defaultOpen={isGov('Flexure')}>
          <KV k={`${cap.Mn}+`} v={fmt(result.phi_Mn_pos, 'moment')}
            tip="Sagging (positive) flexural capacity after applying φ=0.9 (ACI) or 1/γ (EC2). Must exceed Mu+."
            formula={code === 'EN1992-1-1' ? 'M_Rd = As·fyd·z·(1 − λ·x/(2d))' : 'φMn = φ·As·fy·(d − a/2)'} />
          <KV k="  DCR" v={result.DCR_flex_pos.toFixed(3)} dcr={result.DCR_flex_pos} overridden={isOverridden(overrides, 'DCR_flex_pos')}
            tip="Demand-to-Capacity Ratio = Mu+ / φMn+. Must be ≤ 1.0. Values ≥ 0.9 are flagged in amber." />
          <KV k={`${cap.Mn}−`} v={fmt(result.phi_Mn_neg, 'moment')}
            tip="Hogging (negative) flexural capacity. Computed using top steel area." />
          <KV k="  DCR" v={result.DCR_flex_neg.toFixed(3)} dcr={result.DCR_flex_neg} overridden={isOverridden(overrides, 'DCR_flex_neg')}
            tip="Demand-to-Capacity Ratio = Mu− / φMn−. Must be ≤ 1.0." />
          <KV k="As req+" v={fmt(result.As_req_pos, 'area')}
            tip="Minimum bottom steel area to carry Mu+. The engine uses this to flag under-reinforced sections." />
          <KV k="As req−" v={fmt(result.As_req_neg, 'area')}
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

          <CheckSection title="Shear" dcr={result.DCR_shear} defaultOpen={isGov('Shear')}>
          <KV k={cap.Vc} v={fmt(result.Vc, 'force')}
            tip={code === 'EN1992-1-1' ? 'Concrete shear resistance without links V_Rd,c (§6.2.2). Depends on ρl and fck.' : 'ACI concrete contribution Vc. Includes axial modification.'}
            formula={code === 'EN1992-1-1' ? 'V_Rd,c = [CRd,c·k·(100ρl·fck)^⅓]·bw·d' : undefined} />
          <KV k={cap.Vs} v={fmt(result.Vs, 'force')}
            tip="Steel contribution to shear resistance from stirrups."
            formula={code === 'EN1992-1-1' ? 'V_Rd,s = Asw/s · z · fywd · cotθ' : 'Vs = Av·fy·d/s'} />
          <KV k={cap.Vn} v={fmt(result.phi_Vn, 'force')}
            tip="Total design shear resistance = φ(Vc + Vs). Must exceed Vu." />
          <KV k="  DCR" v={result.DCR_shear.toFixed(3)} dcr={result.DCR_shear} overridden={isOverridden(overrides, 'DCR_shear')}
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

          <CheckSection title="Torsion" dcr={result.DCR_torsion} defaultOpen={isGov('Torsion')}>
          <KV k={cap.Tcr} v={fmt(result.Tcr, 'moment')}
            tip="Cracking torsion threshold. Torsion design required when Tu > φTcr." />
          <KV k={cap.Tn} v={fmt(result.phi_Tn, 'moment')}
            tip="Design torsional resistance from closed stirrups. Checked against Tu." />
          <KV k="  DCR" v={result.DCR_torsion.toFixed(3)} dcr={result.DCR_torsion} overridden={isOverridden(overrides, 'DCR_torsion')}
            tip={code === 'EN1992-1-1'
              ? 'Torsion DCR = T_Ed / T_Rd,c when below cracking threshold; T_Ed / T_Rd,i when above.'
              : 'Torsion DCR = Tu / φTn.'} />
          </CheckSection>

          {code === 'EN1992-1-1' && (
            <CheckSection title="Crack Width §7.3.4" dcr={crackDcr} defaultOpen={isGov('Crack Width §7.3.4')}>
              <KV k="wk bot" v={`${(result.wk_bot ?? 0).toFixed(3)} mm`}
                dcr={(result.wk_bot ?? 0) / (member.crackParams?.wLimitBot ?? 0.3)} overridden={isOverridden(overrides, 'DCR_crack')}
                tip="Characteristic crack width at bottom face under quasi-permanent load combination."
                formula="wk = sr,max · (εsm − εcm)" />
              <KV k="wk top" v={`${(result.wk_top ?? 0).toFixed(3)} mm`}
                dcr={(result.wk_top ?? 0) / (member.crackParams?.wLimitTop ?? 0.3)} overridden={isOverridden(overrides, 'DCR_crack')}
                tip="Characteristic crack width at top face under quasi-permanent combination." />
              {result.wk_face !== undefined && (
                <KV k="wk face" v={`${result.wk_face.toFixed(3)} mm`}
                  dcr={result.wk_face / (member.crackParams?.wLimitFace ?? 0.3)} overridden={isOverridden(overrides, 'DCR_crack')}
                  tip="Side-face crack width (EC2 §7.3.3). Relevant when h > 1000 mm." />
              )}
              <KV k="w limit" v={`${(member.crackParams?.wLimitBot ?? 0.3).toFixed(2)} mm`}
                tip="Crack width limit from EC2 Table 7.1N. Typically 0.30 mm (XC2–XC4) or 0.40 mm (XC1)." />
              {code === 'EN1992-1-1' && (result.wk_bot !== undefined || result.wk_top !== undefined) && (() => {
                const cp = member.crackParams ?? DEFAULT_CRACK_PARAMS;
                const slsFails = (result.wk_bot ?? 0) > cp.wLimitBot || (result.wk_top ?? 0) > cp.wLimitTop || (result.wk_face !== undefined && result.wk_face > cp.wLimitFace);
                const comboLabel = slsCombo ? `SLS combo "${slsCombo}"` : 'ψ·M_Ed (ratio)';
                return (
                  <div style={{ marginTop: 4 }}>
                    <span style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 4, fontWeight: 600,
                      background: slsFails ? '#fee2e2' : '#dcfce7',
                      color: slsFails ? '#b91c1c' : '#15803d',
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
          )}
        </div>
      </div>

      {/* Column interaction diagram */}
      {isColumn && result.interaction && (
        <div style={{ marginTop: 14 }}>
          <InteractionDiagram
            points={result.interaction}
            loads={member.loads}
            code={code}
            activeLoadId={activeLoad}
          />
        </div>
      )}

      {/* C2: All-load-cases comparison table */}
      {member.loads.length > 1 && (
        <div style={{ marginTop: 14, borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
          <button
            onClick={() => setShowAllLC(v => !v)}
            style={{ fontSize: 11, fontWeight: 700, color: '#374151', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 6, textTransform: 'uppercase', letterSpacing: 1 }}
          >
            <span style={{ fontSize: 9 }}>{showAllLC ? '▼' : '▶'}</span>
            All Load Cases ({member.loads.length})
          </button>
          {showAllLC && (
            <div style={{ marginTop: 8, overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {(isColumn
                      ? ['Load Case', 'P-M DCR', 'Axial DCR', 'Shear DCR', 'Status']
                      : ['Load Case', 'Flex+ DCR', 'Flex− DCR', 'Shear DCR', 'Torsion DCR', 'Status']
                    ).map(h => (
                      <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#6b7280', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {allResults.map(({ id, label, r }) => (
                    <tr
                      key={id}
                      style={{ background: id === activeLoad ? '#eff6ff' : 'white', cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}
                      onClick={() => setActiveLoad(id)}
                    >
                      <td style={{ padding: '5px 10px', fontWeight: id === activeLoad ? 700 : 400, color: '#374151' }}>
                        {govSet.has(id) && <span style={{ color: '#d97706', marginRight: 4 }}>★</span>}
                        {label}
                      </td>
                      {isColumn ? (
                        <>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_PM ?? 0)}>{(r.DCR_PM ?? 0).toFixed(3)}</span></td>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_axial ?? 0)}>{(r.DCR_axial ?? 0).toFixed(3)}</span></td>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_shear)}>{r.DCR_shear.toFixed(3)}</span></td>
                        </>
                      ) : (
                        <>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_flex_pos)}>{r.DCR_flex_pos.toFixed(3)}</span></td>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_flex_neg)}>{r.DCR_flex_neg.toFixed(3)}</span></td>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_shear)}>{r.DCR_shear.toFixed(3)}</span></td>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_torsion)}>{r.DCR_torsion.toFixed(3)}</span></td>
                        </>
                      )}
                      <td style={{ padding: '5px 10px', fontWeight: 700, color: r.status === 'OK' ? '#16a34a' : r.status === 'NG' ? '#dc2626' : '#d97706', fontSize: 10 }}>
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
        <div style={{ marginTop: 16, borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1 }}>Code Checks / Warnings</div>
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
              <span style={{ fontSize: 11, color: '#374151', flex: 1 }}>
                {ov.note || 'No note.'}
              </span>
              {onRebarChange && (
                <button onClick={() => clearOverride(key)} title="Remove override"
                  style={{ fontSize: 12, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0, lineHeight: 1 }}>×</button>
              )}
            </div>
          ))}

          {/* Remaining (non-overridden) warnings */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {shownWarnings.map((w, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '4px 8px', borderRadius: 6, background: w.severity === 'error' ? '#fef2f2' : '#fffbeb' }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: w.severity === 'error' ? '#dc2626' : '#d97706', flexShrink: 0, marginTop: 1 }}>{w.code}</span>
                <span style={{ fontSize: 11, color: '#374151' }}>{w.message}</span>
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
  const inputStyle: React.CSSProperties = { fontSize: 11, padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 6, color: '#111827', background: 'white' };
  return (
    <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10, color: '#6b7280', fontWeight: 700 }}>
        NOTE (optional)
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
          placeholder="e.g. wk = 0.31 mm vs 0.30 mm limit — acceptable given conservative SLS combo."
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
      </label>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', background: 'white', border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }}>Cancel</button>
        <button onClick={() => onConfirm({ note: note.trim() || undefined })}
          style={{ fontSize: 11, fontWeight: 700, color: 'white', background: DCR.pass, border: 'none', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }}>
          Confirm Review
        </button>
      </div>
    </div>
  );
}
