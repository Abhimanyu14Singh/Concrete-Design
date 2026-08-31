/**
 * ETABS Import Wizard — 4-step popup:
 *   1. Connect   — active ETABS instance (COM) / tables file (.xlsx) / demo model
 *   2. Filter    — story, beam sections, materials preview, ETABS groups, combos
 *   3. Rebar     — typical top/bottom steel % and three stirrup spacings
 *   4. Plan map  — beams colored by DCR; group editing; click-through to app
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Member, DesignGroup, DesignCode, ModelMap, MapFrame } from '../../types';
import type { EtabsConnection, EtabsConnectInfo, EtabsSectionInfo, EtabsMaterialInfo, UnitInfo } from '../../adapters/etabs/connection';
import { FORCE_UNITS, LENGTH_UNITS, STRESS_UNITS } from '../../adapters/etabs/tableConnection';
import { MockConnection } from '../../adapters/etabs/mock';
import { ComConnection } from '../../adapters/etabs/comClient';
import { buildMembers, autoGroup, stationLoadCases } from '../../adapters/etabs';
import type { SeedOptions } from '../../adapters/etabs/rebarSeed';
import { runDesign } from '../../engines';
import { barSizeOptions, defaultBarSizes, formatBarLabel } from '../../utils/rebar';
import { useUnits } from '../../contexts/UnitsContext';
import { track } from '../../utils/usage';
import PlanMap from './PlanMap';
import ImportDiagnostics from './ImportDiagnostics';
import { flagOn } from '../../utils/flags';
import { dcrToColor } from './dcrColors';
import Dropdown from '../common/Dropdown';
import { ACCENT, BORDER, INK, LABEL_STYLE, MONO_NUM, STATUS, SURFACE, Z } from '../../theme';

interface Props {
  code: DesignCode;
  /**
   * A source the CALLER already chose, so the wizard connects on open and lands on
   * Filter instead of asking again.
   *
   * The launch gate's "Import from the running ETABS model" IS the source question —
   * asking it a second time on step 1 made the same decision twice. Opened from the
   * File menu there is no prior choice, so the prop is omitted and step 1 shows.
   *
   * A failed auto-connect falls BACK to step 1 with the error, never a dead end:
   * ETABS not being open is the ordinary case, and the picker is where you recover
   * (retry, or take the demo model instead).
   */
  autoSource?: SourceKind;
  onClose: () => void;
  /** Commit imported members + groups into the project; pickId opens that member. */
  onImport: (
    members: Member[],
    groups: DesignGroup[],
    pickId?: string,
    modelMap?: ModelMap,
    slsCombo?: string,
    applyCode?: DesignCode,
    applyUnits?: 'imperial' | 'si',
  ) => void;
}

type SourceKind = 'com' | 'mock';

const STEPS = ['Connect', 'Filter', 'Rebar Defaults', 'Review & Import'];

/** "All" / "None" quick-select buttons for a multi-select category header. */
/**
 * Which ETABS force table the import reads — fixed, not a choice.
 *
 * 'element' is the raw per-combo Element (analysis) forces, i.e. exactly what ETABS
 * itself draws under Display → Forces → Frames. The alternative was the concrete
 * Design Forces table, which reports at design stations / face of support and so
 * disagrees with the numbers an engineer reads off the model — which made "why don't
 * my moments match ETABS?" the single most common question about the import. There is
 * one right answer here, so the wizard no longer asks the question.
 */
const FORCE_SOURCE = 'element' as const;

/**
 * A multi-select the size of a dropdown.
 *
 * The three model filters — storeys, beam sections, ETABS groups — were walls of
 * toggle chips. On a real model that is dozens of chips each, three times over: the
 * step scrolled, and the controls that matter (units, combos) were pushed off screen
 * behind a list nobody reads chip by chip. Same semantics as the chips (nothing
 * selected = everything imported), one line of height.
 *
 * PORTALLED to <body>. The wizard is inside App.tsx's zoom `transform: scale`, which
 * becomes the containing block for `position: fixed` descendants — a list rendered in
 * place lands in the wrong spot at any Display Scale but 100%, and is clipped by the
 * step's own scroll container besides. `Z.popover` clears the wizard's own backdrop.
 */
function MultiSelect({ label, options, selected, onChange, emptyText, disabled }: {
  label: string;
  options: { value: string; label: string }[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Shown in place of the list when the model has none of these. */
  emptyText: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      if ((e.target as Element)?.closest?.('[data-etabs-multiselect]')) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const toggle = (v: string) => {
    const n = new Set(selected);
    if (n.has(v)) n.delete(v); else n.add(v);
    onChange(n);
  };

  // "All" is the honest word for an empty set here — it is what the filter DOES, and
  // "0 selected" reads as "nothing will be imported", which is the opposite.
  const summary = !options.length ? emptyText
    : selected.size === 0 ? `All (${options.length})`
      : selected.size === 1 ? (options.find(o => selected.has(o.value))?.label ?? '1 selected')
        : `${selected.size} of ${options.length}`;

  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
      <span style={{ ...LABEL_STYLE, marginBottom: 0 }}>{label}</span>
      <button
        ref={ref}
        type="button"
        disabled={disabled || !options.length}
        onClick={() => {
          const r = ref.current?.getBoundingClientRect();
          if (r) setPos({ left: r.left, top: r.bottom + 4, width: r.width });
          setOpen(o => !o);
        }}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
          padding: '6px 10px', border: `1px solid ${BORDER.strong}`, borderRadius: 6,
          background: options.length ? 'white' : SURFACE.subtle, fontSize: 12,
          color: options.length ? INK.base : INK.muted,
          cursor: options.length ? 'pointer' : 'not-allowed', width: '100%', textAlign: 'left',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
        <span style={{ fontSize: 9, color: INK.muted, flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && pos && createPortal(
        <div
          data-etabs-multiselect
          style={{
            position: 'fixed', left: pos.left, top: pos.top, minWidth: pos.width,
            maxWidth: Math.max(pos.width, 320), maxHeight: 280, overflowY: 'auto',
            background: 'white', border: `1px solid ${BORDER.strong}`, borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,0.14)', zIndex: Z.popover, padding: 4,
          }}
        >
          <div style={{ display: 'flex', gap: 8, padding: '2px 6px 6px', borderBottom: `1px solid ${BORDER.subtle}`, marginBottom: 4 }}>
            <AllNone onAll={() => onChange(new Set(options.map(o => o.value)))} onNone={() => onChange(new Set())} />
          </div>
          {options.map(o => (
            <label key={o.value} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 4,
              fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
              background: selected.has(o.value) ? ACCENT.softBg : 'transparent',
            }}>
              <input type="checkbox" checked={selected.has(o.value)} onChange={() => toggle(o.value)} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
            </label>
          ))}
        </div>,
        document.body,
      )}
    </label>
  );
}

function AllNone({ onAll, onNone }: { onAll: () => void; onNone: () => void }) {
  const s: React.CSSProperties = {
    fontSize: 11, color: ACCENT.primary, background: 'none', border: 'none',
    cursor: 'pointer', fontWeight: 600, padding: '0 4px',
  };
  return (
    <>
      <button type="button" onClick={onAll} style={s}>All</button>
      <button type="button" onClick={onNone} style={s}>None</button>
    </>
  );
}

function worstDCR(m: Member, code: DesignCode): number {
  // Govern across every load row (beams now carry one row per station/combo).
  let worst = 0;
  for (const l of m.loads) {
    const r = runDesign(m.section, m.material, m.rebar, l, m.span, code);
    worst = Math.max(worst, r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear, r.DCR_torsion, r.VT_util ?? 0);
  }
  return worst;
}

export default function EtabsImportWizard({ code, autoSource, onClose, onImport }: Props) {
  const { units, barFamily } = useUnits();
  const IN_TO_MM = 25.4;
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wizard-local code + units — user can override without touching global settings
  const [wizardCode, setWizardCode] = useState<DesignCode>(code);
  const [wizardUnits, setWizardUnits] = useState<'imperial' | 'si'>(units);

  // step 1
  const [source, setSource] = useState<SourceKind>(
    autoSource ?? (window.electronAPI?.etabs ? 'com' : 'mock'),
  );
  const connRef = useRef<EtabsConnection | null>(null);
  const [connInfo, setConnInfo] = useState<EtabsConnectInfo | null>(null);
  // How raw ETABS values are being read (force/length/stress). Seeded from the
  // connection's auto-detection on connect; the user can correct it if ETABS
  // reported — or the app fell back to — the wrong unit system. This is the
  // fix for the silent kip-ft fallback that mis-scales a locked SI model.
  const [unitInfo, setUnitInfo] = useState<UnitInfo | null>(null);
  const [stressOverride, setStressOverride] = useState<string | null>(null); // null = derive from force/length

  // step 2 — model lists + selections
  const [stories, setStories] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [sections, setSections] = useState<EtabsSectionInfo[]>([]);
  const [materials, setMaterials] = useState<EtabsMaterialInfo[]>([]);
  const [combos, setCombos] = useState<string[]>([]);
  const [selStories, setSelStories] = useState<Set<string>>(new Set()); // empty = all
  const [selSections, setSelSections] = useState<Set<string>>(new Set());
  const [selGroups, setSelGroups] = useState<Set<string>>(new Set()); // empty = all
  // Frame-property MATERIALS to keep. Empty = all, so the default import is unchanged;
  // this exists so a mixed steel/concrete model can leave its steel behind.
  const [selMaterials, setSelMaterials] = useState<Set<string>>(new Set());
  // ETABS groups to mirror as design-group names (empty = group by story·section)
  const [selCombos, setSelCombos] = useState<Set<string>>(new Set());
  const [slsComboId, setSlsComboId] = useState<string>('');
  const [matchCount, setMatchCount] = useState<number | null>(null);

  // step 3 — stirrup size defaults to Ø10 in SI, #4 in imperial (display only;
  // spacings are stored in inches and converted for display when SI)
  const [seed, setSeed] = useState<SeedOptions>(() => ({
    rhoTopPct: 0.4, rhoBotPct: 0.6, stirrupSpacings: [4, 8, 4],
    stirrupBarSize: defaultBarSizes(barFamily).stirrup, stirrupLegs: 2,
    imposeSkinReinf: true, skinBarSize: defaultBarSizes(barFamily).skin,
  }));

  // 1 MPa = 145.0377 psi — the single stress conversion used across the wizard.
  const PSI_PER_MPA = 145.0377;

  // When the user switches the display units inside the wizard: reset bar-size
  // defaults AND convert any entered material-strength overrides so the numbers
  // keep their physical meaning (e.g. 5000 psi ⇄ 34.5 MPa), rather than being
  // silently relabelled (5000 psi → "5000 MPa").
  function handleWizardUnitsChange(u: 'imperial' | 'si') {
    if (u !== wizardUnits) {
      const conv = (s: string) => {
        const n = parseFloat(s);
        if (!Number.isFinite(n)) return s; // keep blanks/partial input as typed
        const v = u === 'si' ? n / PSI_PER_MPA : n * PSI_PER_MPA;
        return String(+v.toFixed(u === 'si' ? 1 : 0));
      };
      setMatOverride(m => ({ ...m, fck: conv(m.fck), fyLong: conv(m.fyLong), fyTie: conv(m.fyTie) }));
    }
    setWizardUnits(u);
    setSeed(s => ({
      ...s,
      stirrupBarSize: defaultBarSizes(barFamily).stirrup,
      skinBarSize: defaultBarSizes(barFamily).skin,
    }));
  }

  // Section dimensions in the wizard follow the WIZARD's units (which default to
  // the model's unit system on connect), so the sizes shown next to each section
  // read in the units the user selects here — independent of the app's global
  // toggle. Section widths/depths are stored in inches.
  const wLen = (inches: number) => wizardUnits === 'si' ? Math.round(inches * IN_TO_MM) : +inches.toFixed(1);
  const wLenUnit = wizardUnits === 'si' ? 'mm' : 'in';

  // Stress (f'c / fy) in the WIZARD's display units: MPa when SI, ksi when
  // imperial. Values are stored in psi. Keeps the materials preview consistent
  // with the Display toggle instead of the app's global unit system.
  const wStress = (psi: number) => wizardUnits === 'si'
    ? `${(psi / PSI_PER_MPA).toFixed(1)} MPa`
    : `${(psi / 1000).toFixed(1)} ksi`;

  // Sanity of the imported model under the CURRENT unit interpretation. If a beam
  // comes in a few tenths of an inch tall, or f'c reads ~20,000 ksi, the units are
  // wrong — the tables came back in a different system than we detected. Bounds are
  // deliberately generous (internal in / psi): 2–300 in, f'c 0.5–20 ksi, fy 20–120 ksi.
  const sampleSec = sections[0];
  const sampleConc = materials.find(m => m.fc != null);
  const badSection = (sec: { width: number; depth: number }) =>
    sec.width < 2 || sec.width > 300 || sec.depth < 2 || sec.depth > 300;
  const badMaterial = (m: { fc?: number | null; fy?: number | null }) =>
    (m.fc != null && (m.fc < 500 || m.fc > 20000)) ||
    (m.fy != null && (m.fy < 20000 || m.fy > 120000));
  /**
   * WHICH values look wrong, not merely whether any do.
   *
   * The old check was a single boolean and the message it drove said, flatly, "the model
   * units don't match the data ETABS returned". On a model where one stub section or one
   * steel material sits outside the bounds and everything else reads perfectly, that
   * accuses the units of a fault they do not have — and there was no way to tell from
   * the screen which value had tripped it. Naming the offenders, and saying how many of
   * how many, lets the reader see the difference between "my units are wrong" and "there
   * is one odd section in this model" without leaving the wizard.
   */
  const oddSections = sections.filter(badSection);
  const oddMaterials = materials.filter(badMaterial);
  const unitsImplausible = oddSections.length > 0 || oddMaterials.length > 0;
  // Everything off ⇒ a unit mismatch. A minority off ⇒ outliers in the model itself.
  const allOff = (!sections.length || oddSections.length === sections.length)
    && (!materials.length || oddMaterials.length === materials.length);

  const [applyToProject, setApplyToProject] = useState(true);

  // Material overrides — stored in display units (MPa for SI, psi for imperial).
  // null = no override (use per-section material from ETABS).
  const [matOverride, setMatOverride] = useState<{
    fck: string; fyLong: string; fyTie: string;
    enabled: boolean;
    collapsed: boolean;
  }>({ fck: '', fyLong: '', fyTie: '', enabled: false, collapsed: true });

  // step 4
  const [members, setMembers] = useState<Member[]>([]);
  const [designGroups, setDesignGroups] = useState<DesignGroup[]>([]);
  const [capturedModelMap, setCapturedModelMap] = useState<ModelMap | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [minDCR, setMinDCR] = useState(0);

  const dcrById = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of members) out[m.id] = worstDCR(m, wizardCode);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, wizardCode]);

  const beamCount = members.length;
  // Beams whose section named a concrete material we could not find in the
  // model's material tables: they silently inherit the 4000 psi default, which
  // is what makes an imported grade look inconsistent member-to-member. Surface
  // it at import instead of letting it slip through unnoticed.
  const unmatchedGrade = useMemo(() => {
    const known = new Set(materials.filter(m => (m.fc ?? 0) > 0).map(m => m.name.trim().toLowerCase()));
    if (!known.size) return [];
    const secByName = new Map(sections.map(sc => [sc.name, sc]));
    const bad = new Set<string>();
    for (const m of members) {
      const named = secByName.get(m.etabs?.sectionName ?? '')?.material?.trim().toLowerCase();
      if (named && !known.has(named)) bad.add(named);
    }
    return [...bad];
  }, [members, sections, materials]);

  /**
   * section name → material name, for the material scope.
   *
   * Built here because this is the side that holds both tables: ETABS gives a beam its
   * frame PROPERTY, and the material is a field on that property. Sent with the filter
   * so no connection has to learn the join — see `BeamFilter.sectionMaterials`.
   */
  const sectionMaterials = useMemo(() => {
    const out: Record<string, string> = {};
    for (const sec of sections) if (sec.material) out[sec.name] = sec.material;
    return out;
  }, [sections]);

  const filter = useMemo(() => ({
    stories: selStories.size ? [...selStories] : undefined,
    sections: selSections.size ? [...selSections] : undefined,
    groups: selGroups.size ? [...selGroups] : undefined,
    materials: selMaterials.size ? [...selMaterials] : undefined,
    sectionMaterials: selMaterials.size ? sectionMaterials : undefined,
  }), [selStories, selSections, selGroups, selMaterials, sectionMaterials]);

  /**
   * The materials the model's BEAM SECTIONS are actually made of, with what is known
   * about each.
   *
   * Only materials in use are offered: a picker listing every material defined in the
   * model would put deck, rebar and masonry beside the two that matter here.
   *
   * `concrete` is a heuristic, and it is labelled as one in the UI rather than acted on
   * silently: ETABS's material table gives this app f′c and fy and no type field, so a
   * material with a compressive strength is concrete and one with only a yield is not.
   * It drives the "Concrete only" shortcut and nothing else — the checkboxes stay the
   * authority, because a heuristic that quietly dropped a real concrete beam would be
   * far worse than one that pre-ticks the wrong box.
   */
  const beamMaterials = useMemo(() => {
    const counts = new Map<string, number>();
    for (const sec of sections) {
      const name = sec.material?.trim();
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const byName = new Map(materials.map(m => [m.name.trim().toLowerCase(), m]));
    return [...counts.entries()].map(([name, sectionCount]) => {
      const info = byName.get(name.toLowerCase());
      return { name, sectionCount, fc: info?.fc, fy: info?.fy, concrete: info?.fc != null && info.fc > 0 };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [sections, materials]);

  /**
   * Every asynchronous step in the wizard goes through here, which makes it the one
   * place that sees an import fail. `op` names which step it was — without it the log
   * says only that something threw somewhere in a four-step flow, and the difference
   * between "could not attach to ETABS" and "read the model but could not build the
   * beams" is most of the diagnosis.
   */
  async function run<T>(fn: () => Promise<T>, op = 'op'): Promise<T | undefined> {
    setBusy(true); setError(null);
    const t0 = Date.now();
    try {
      const out = await fn();
      track('wizard.op', { op, ok: true, ms: Date.now() - t0, source });
      return out;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      track('wizard.op', { op, ok: false, ms: Date.now() - t0, source, error: message }, 'error');
      return undefined;
    } finally { setBusy(false); }
  }

  async function connectWith(conn: EtabsConnection) {
    const ok = await run(async () => {
      const info = await conn.connect();
      connRef.current = conn;
      setConnInfo(info);
      // Surface the detected unit interpretation so the user can see/correct it.
      setUnitInfo(conn.getUnitInfo?.() ?? null);
      setStressOverride(null);
      // Adopt the model's unit SYSTEM so imported sizes read in the model's units
      // (SI model → mm, imperial model → in), matching what ETABS shows. The units
      // label is "force-length" (e.g. "kn-m", "kip-ft"); the length part decides.
      const lenPart = info.units.split('-')[1]?.trim().toLowerCase() ?? '';
      setWizardUnits(['mm', 'cm', 'm'].includes(lenPart) ? 'si' : 'imperial');
      const [st, gr, sec, mat, cmb] = await Promise.all([
        conn.getStories(), conn.getGroups(), conn.getFrameSections(),
        conn.getMaterials(), conn.getCombos(),
      ]);
      setStories(st); setGroups(gr); setSections(sec); setMaterials(mat); setCombos(cmb);
      setSelSections(new Set(sec.map(s => s.name)));
      setSelCombos(new Set(cmb));
      setSelStories(new Set());
      // The model NAME is the client's and stays out. What it was read AS is ours, and
      // it is the root of the app's most reported complaint — "the dimensions are
      // absurd" is almost always `assumed: true`, a unit system that had to be guessed.
      const ui = conn.getUnitInfo?.();
      track('wizard.connected', {
        source,
        units: info.units,
        unitsAssumed: ui?.assumed ?? null,
        stressUnit: ui?.stressUnit ?? null,
        stories: st.length, groups: gr.length, sections: sec.length,
        materials: mat.length, combos: cmb.length,
      });
      return true;
    }, 'connect');
    if (ok) setStep(1);
  }

  async function handleConnect() {
    if (source === 'mock') return connectWith(new MockConnection());
    return connectWith(new ComConnection());
  }

  /**
   * Connect straight away when the caller already picked the source.
   *
   * Ref-guarded rather than dependency-guarded: StrictMode runs effects twice in dev,
   * and a second run would open a second COM attachment to ETABS. Once per mount is
   * the correct number, and `autoSource` cannot change without a remount — the wizard
   * is keyed by its open/closed state.
   */
  /**
   * The import funnel, measured at the mount boundary.
   *
   * The wizard is unmounted whichever way it ends — imported, cancelled, or clicked
   * away from — so the cleanup is the single place that sees every ending, and the step
   * it unmounts on is exactly how far the user got. Recording it here rather than in an
   * `onClose` handler also catches the exits that never touch one.
   */
  const stepRef = useRef(0);
  stepRef.current = step;
  const importedRef = useRef(false);
  useEffect(() => {
    track('wizard.open', { source: autoSource ?? 'ask' });
    return () => {
      track('wizard.close', {
        step: stepRef.current,
        stepName: STEPS[stepRef.current] ?? String(stepRef.current),
        imported: importedRef.current,
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Each step reached, in order. The gap between two of these is the dwell time on the
  // step before — which is how a confusing screen shows up in the data at all.
  useEffect(() => {
    track('wizard.step', { step, name: STEPS[step] ?? String(step) });
  }, [step]);

  /**
   * How the filter is narrowed, as it happens.
   *
   * `wizard.match` records where the selection ENDED UP, which turned out not to be the
   * interesting half: a real import spent 16 of its 24 seconds on this step, and the only
   * clue why was that the combo count finished at 1 out of 196. This traces the selection
   * on its way down, so the difference between "typed a search and clicked one" and
   * "un-ticked a hundred and ninety-five boxes" is visible rather than inferred.
   *
   * Debounced: a click storm through a checkbox list is one decision, not forty. Sizes
   * only — which storeys and sections were chosen is the model's business, not ours.
   */
  useEffect(() => {
    if (step !== 1) return;
    const t = setTimeout(() => {
      track('wizard.filter', {
        stories: selStories.size, ofStories: stories.length,
        sections: selSections.size, ofSections: sections.length,
        groups: selGroups.size, ofGroups: groups.length,
        combos: selCombos.size, ofCombos: combos.length,
        hasSls: !!slsComboId,
      });
    }, 700);
    return () => clearTimeout(t);
  }, [step, selStories, selSections, selGroups, selCombos, slsComboId,
      stories.length, sections.length, groups.length, combos.length]);

  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoSource || autoRan.current) return;
    autoRan.current = true;
    // On failure `run()` has already set the error and step stays at 0, which is the
    // source picker — exactly where someone whose ETABS was not open needs to be.
    void (autoSource === 'mock'
      ? connectWith(new MockConnection())
      : connectWith(new ComConnection()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSource]);

  const canOverrideUnits = !!connRef.current?.setUnitSystem;

  /**
   * Re-interpret the model under an explicit force/length/stress unit system and
   * refresh the unit-dependent previews (section sizes, material strengths). The
   * corrected units then flow through to the forces imported in buildAndReview.
   */
  async function applyModelUnits(next: { forceKey?: string; lengthKey?: string; stress?: string | null }) {
    const conn = connRef.current;
    if (!conn || !unitInfo) return;
    await run(async () => {
      if ((next.forceKey !== undefined || next.lengthKey !== undefined) && conn.setUnitSystem) {
        conn.setUnitSystem(next.forceKey ?? unitInfo.forceKey, next.lengthKey ?? unitInfo.lengthKey);
      }
      if (next.stress !== undefined && conn.setStressUnit) {
        conn.setStressUnit(next.stress);
        setStressOverride(next.stress);
      }
      // Re-read only the unit-dependent lists; keep the user's section selection.
      const [sec, mat] = await Promise.all([conn.getFrameSections(), conn.getMaterials()]);
      setSections(sec);
      setMaterials(mat);
      setUnitInfo(conn.getUnitInfo?.() ?? unitInfo);
      setMatchCount(null);
      return true;
    });
  }

  async function refreshMatchCount() {
    const conn = connRef.current;
    if (!conn) return;
    const beams = await run(() => conn.getBeams(filter), 'match-count');
    // Zero matches is the wizard's classic dead end, and the filter WIDTHS are what
    // explain it — how many storeys, sections and groups were ticked, never which ones.
    track('wizard.match', {
      matched: beams?.length ?? null,
      selStories: selStories.size, selSections: selSections.size,
      selGroups: selGroups.size, selCombos: selCombos.size,
    });
    setMatchCount(beams?.length ?? null);
  }

  async function buildAndReview() {
    const conn = connRef.current;
    if (!conn) return;
    const ok = await run(async () => {
      // Import forces from the table the user chose (design vs raw analysis).
      conn.setForceSource?.(FORCE_SOURCE);
      // Get all beams (no filter) for the connectivity map snapshot — always
      // captured so the plan map shows the full model as context.
      const allBeams = await conn.getBeams({});
      const beams = await conn.getBeams(filter);
      if (!beams.length) throw new Error('No beams match the current filter.');
      const sourceGroup = selGroups.size === 1 ? [...selGroups][0] : undefined;
      // Always fetch the SLS combo's forces too, even if it wasn't selected for
      // ULS import, so per-beam crack-width resolution from stationForces works.
      const forceCombos = new Set(selCombos);
      if (slsComboId) forceCombos.add(slsComboId);
      const forces = beams.length
        ? await conn.getStationForces(beams.map(b => b.name), [...forceCombos], sourceGroup)
        : {};
      let built = buildMembers(beams, sections, materials, forces, seed, wizardCode);
      if (!built.length) throw new Error('No beams match the current filter.');
      // Apply global material overrides if the user enabled them.
      if (matOverride.enabled) {
        const toInternal = (v: string) => {
          const n = parseFloat(v);
          if (!Number.isFinite(n) || n <= 0) return null;
          return wizardUnits === 'si' ? n * PSI_PER_MPA : n;
        };
        const fcPsi = toInternal(matOverride.fck);
        const fyLongPsi = toInternal(matOverride.fyLong);
        const fyTiePsi = toInternal(matOverride.fyTie);
        if (fcPsi != null || fyLongPsi != null || fyTiePsi != null) {
          built = built.map(m => ({
            ...m,
            material: {
              ...m.material,
              ...(fcPsi != null ? { fc: fcPsi } : {}),
              ...(fyLongPsi != null ? { fy: fyLongPsi } : {}),
              ...(fyTiePsi != null ? { fyt: fyTiePsi } : {}),
            },
          }));
        }
      }
      const builtById = new Map(built.map(m => [m.etabs?.frameName, m.id]));

      // Optional geometry layers (walls / grids / openings). Sources without an
      // area/grid table simply omit the method; a source-side error degrades to an
      // empty layer so the import never breaks.
      // Vertical frames — geometry only, for the 3D view. Never become members.
      const cols     = conn.getColumns  ? await conn.getColumns({}).catch(() => [])  : [];
      const areas    = conn.getAreas    ? await conn.getAreas({}).catch(() => [])    : [];
      const grids    = conn.getGrids    ? await conn.getGrids().catch(() => [])      : [];
      const openings = conn.getOpenings ? await conn.getOpenings({}).catch(() => []) : [];

      // Build modelMap from beam geometry (+ area/grid/opening layers)
      const uniqueStories = [...new Set([
        ...allBeams.map(b => b.story), ...cols.map(c => c.story),
        ...areas.map(a => a.story), ...openings.map(o => o.story),
      ])].sort();
      const frames: MapFrame[] = allBeams.map(b => ({
        frameName: b.name, story: b.story, sectionName: b.section, pt1: b.pt1, pt2: b.pt2,
        memberId: builtById.get(b.name),
      }));
      const modelMap: ModelMap = {
        source,
        modelName: connInfo?.modelName ?? 'ETABS model',
        importedAt: new Date().toISOString(),
        stories: uniqueStories,
        frames,
        walls: areas.map(a => ({ id: a.name, story: a.story, points: a.points, kind: a.kind, sectionName: a.section || undefined })),
        grids: grids.map(g => ({ id: g.id, label: g.label, p1: g.p1, p2: g.p2 })),
        openings: openings.map(o => ({ id: o.name, story: o.story, points: o.points })),
        columns: cols.map(c => ({ id: c.name, story: c.story, sectionName: c.section || undefined, pt1: c.pt1, pt2: c.pt2 })),
      };
      setCapturedModelMap(modelMap);

      // Design groups are always derived: story · section. Mirroring ETABS group names
      // was a second, competing source of grouping that had to be reconciled with the
      // derived one, and the plan's own grouping tools do the job better once the model
      // is in.
      setDesignGroups(autoGroup(built));
      setMembers(built);
      setSelected(new Set());
      return true;
    }, 'build');
    if (ok) setStep(3);
  }

  function toggleSelect(id: string, additive: boolean) {
    setSelected(prev => {
      const next = additive ? new Set(prev) : new Set<string>();
      if (prev.has(id) && additive) next.delete(id); else next.add(id);
      return next;
    });
  }

  function mergeSelectedIntoGroup() {
    if (selected.size < 2) return;
    setDesignGroups(prev => {
      const id = `dg-${prev.length + 1}-m`;
      const g: DesignGroup = { id, label: `Custom group (${selected.size})`, memberIds: [...selected] };
      const cleaned = prev
        .map(p => ({ ...p, memberIds: p.memberIds.filter(mid => !selected.has(mid)) }))
        .filter(p => p.memberIds.length > 0);
      setMembers(ms => ms.map(m => selected.has(m.id) && m.etabs
        ? { ...m, etabs: { ...m.etabs, designGroupId: id } } : m));
      return [...cleaned, g];
    });
    setSelected(new Set());
  }

  function groupWorstDCR(g: DesignGroup): number {
    return Math.max(...g.memberIds.map(id => dcrById[id] ?? 0), 0);
  }

  function commit(pickId?: string) {
    // Expand each beam's station forces into one load row per station per combo so
    // every actual simultaneous {M, V, T, P} state is checked (not a single worst-
    // of-each envelope), and all rows flow through member design + the S-CONCRETE
    // .SCO. The SLS quasi-permanent combo is stored at PROJECT level (project.slsCombo)
    // and resolved per beam from stationForces at design time — no per-member id.
    const labeled = members.map(m => ({
      ...m, loads: stationLoadCases(m.stationForces ?? [], `ETABS env (${[...selCombos].join(', ')})`, m.span),
    }));
    // Read by the unmount handler, so `wizard.close` can separate an import that
    // finished from a wizard that was abandoned on its last screen.
    importedRef.current = true;
    onImport(
      labeled, designGroups, pickId, capturedModelMap ?? undefined,
      slsComboId || undefined,
      applyToProject ? wizardCode : undefined,
      applyToProject ? wizardUnits : undefined,
    );
  }

  // ── styles ──────────────────────────────────────────────────────────────────
  const card: React.CSSProperties = { background: SURFACE.subtle, border: `1px solid ${BORDER.default}`, borderRadius: 10, padding: '12px 14px' };
  const lbl: React.CSSProperties = { ...LABEL_STYLE, marginBottom: 6 };
  const unitField: React.CSSProperties = { fontSize: 11, color: INK.secondary, fontWeight: 600, display: 'flex', flexDirection: 'column', gap: 3 };
  const inp: React.CSSProperties = { padding: '5px 8px', border: `1px solid ${BORDER.strong}`, borderRadius: 6, fontSize: 12, color: INK.strong, background: 'white', outline: 'none', ...MONO_NUM };
  const btn = (primary = false): React.CSSProperties => ({
    padding: '7px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    background: primary ? ACCENT.primary : 'white', color: primary ? 'white' : INK.base,
    border: primary ? 'none' : `1px solid ${BORDER.strong}`,
  });
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'flex-start',
        justifyContent: 'center', padding: '24px 16px', overflowY: 'auto',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 16,
        width: '100%', maxWidth: 980, maxHeight: '92vh', display: 'flex',
        flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
      }}>
        {/* Header with step progress */}
        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${BORDER.default}`, background: SURFACE.subtle, borderRadius: '16px 16px 0 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: INK.strong }}>Import from ETABS</h2>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              {STEPS.map((s, i) => (
                <span key={s} style={{
                  fontSize: 10, padding: '2px 10px', borderRadius: 10, fontWeight: 600,
                  background: i === step ? ACCENT.primary : i < step ? '#dbeafe' : '#f3f4f6',
                  color: i === step ? 'white' : i < step ? ACCENT.primary : INK.muted,
                }}>
                  {i + 1}. {s}
                </span>
              ))}
            </div>
          </div>
          <button onClick={onClose} style={btn()}>✕ Close</button>
        </div>

        {error && (
          <div style={{ margin: '12px 20px 0', padding: '8px 12px', background: STATUS.failBg, border: `1px solid ${STATUS.failBorder}`, borderRadius: 8, fontSize: 12, color: STATUS.fail }}>
            {error}
          </div>
        )}

        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          {/* ── Step 1: Connect ──

              Skipped entirely when the caller already chose the source (see the
              `autoSource` prop): while that attach is in flight this shows what it is
              doing, and the picker below appears only if it FAILS. Rendering the picker
              during the attempt would put the very question the launch gate just asked
              back on screen, which is the redundancy this exists to remove. */}
          {step === 0 && autoSource && busy && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 560 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: INK.strong }}>
                {autoSource === 'mock'
                  ? 'Loading the sample model…'
                  : 'Attaching to the model open in ETABS…'}
              </div>
              <div style={{ fontSize: 11, color: INK.secondary }}>
                Reading stories, frame sections, materials and load combinations.
              </div>
            </div>
          )}
          {step === 0 && !(autoSource && busy) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
              {autoSource && (
                <div style={{ fontSize: 12, color: INK.secondary }}>
                  Could not attach automatically. Pick a source and try again, or take the
                  demo model to carry on without ETABS.
                </div>
              )}
              <div style={lbl}>Model source</div>
              {([
                ['com', 'ETABS Active Instance', 'One click — attaches to the model open in ETABS and reads geometry, sections, and forces (run the analysis first)', !window.electronAPI?.etabs],
                ['mock', 'Sample model (demo)', 'Built-in 2-story demo model — try the workflow without ETABS', false],
              ] as [SourceKind, string, string, boolean][]).map(([kind, title, desc, disabled]) => (
                <label key={kind} style={{
                  ...card, display: 'flex', gap: 10, cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.55 : 1,
                  border: `1px solid ${source === kind ? ACCENT.primary : BORDER.default}`,
                  background: source === kind ? ACCENT.softBg : SURFACE.subtle,
                }}>
                  <input type="radio" checked={source === kind} disabled={disabled}
                    onChange={() => setSource(kind)} style={{ marginTop: 2 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: INK.strong }}>{title}</div>
                    <div style={{ fontSize: 11, color: INK.secondary, marginTop: 2 }}>{desc}</div>
                    {disabled && <div style={{ fontSize: 10, color: STATUS.warn, marginTop: 2 }}>Requires the Windows desktop app with ETABS running</div>}
                  </div>
                </label>
              ))}
              <button style={btn(true)} disabled={busy} onClick={handleConnect}>
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          )}

          {/* ── Step 2: Filter ── */}
          {step === 1 && connInfo && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* The attached model, and the one view setting that applies to every size
                  shown below it. The Display toggle used to sit in a card of its own
                  alongside a read-only "Import: Beams" — a whole row spent saying the
                  app does what it says on the tin. This is a beam-design tool; there was
                  never a scope to choose. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 12, color: STATUS.ok, fontWeight: 600 }}>
                  ✓ Connected: {connInfo.modelName} <span style={{ color: INK.muted }}>({connInfo.units})</span>
                </div>
                <div style={{ flex: 1, minWidth: 12 }} />
                {/* How the section sizes below are DISPLAYED (mm vs in) — a view toggle
                    only, independent of the model-unit interpretation below. */}
                <div style={{ ...lbl, marginBottom: 0 }}>Display</div>
                {(['si', 'imperial'] as const).map(u => (
                  <button key={u} onClick={() => handleWizardUnitsChange(u)}
                    style={{ ...btn(wizardUnits === u), padding: '4px 10px', fontSize: 11 }}>
                    {u === 'si' ? 'SI · mm' : 'Imperial · in'}
                  </button>
                ))}
              </div>

              {/* Model units — how raw ETABS values are interpreted. Every imported
                  force, moment, size and material strength is scaled by these, so a
                  wrong detection mis-scales the whole model. Shown here (and made
                  editable) so the user can verify/correct it before importing. */}
              {unitInfo && (
                <div style={{
                  ...card,
                  display: 'flex', flexDirection: 'column', gap: 10,
                  borderColor: unitInfo.assumed ? STATUS.warnBorder : BORDER.default,
                  background: unitInfo.assumed ? STATUS.warnBg : SURFACE.subtle,
                }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ ...lbl, marginBottom: 0 }}>Model units — how ETABS values are read</div>
                    {unitInfo.assumed
                      ? <span style={{ fontSize: 10, fontWeight: 700, color: STATUS.warn }}>⚠ Not auto-detected — assuming {unitInfo.label}. Verify below.</span>
                      : <span style={{ fontSize: 10, color: STATUS.ok, fontWeight: 600 }}>✓ Detected {unitInfo.label}</span>}
                  </div>

                  {/* WHAT ETABS SAYS ITS UNITS ARE, in one line, per quantity.
                      Everything else in this card is the app's INTERPRETATION and its
                      consequences; none of it states the plain fact the reader wants
                      when they are looking at ETABS on the other monitor and trying to
                      decide whether the two agree. Force, length and stress separately,
                      because ETABS carries them as separate present-units fields and a
                      combined label like "kN-m" answers only two of the three. */}
                  <div style={{
                    display: 'flex', gap: 14, rowGap: 4, flexWrap: 'wrap', alignItems: 'baseline',
                    fontSize: 11, color: INK.secondary,
                    background: 'white', border: `1px solid ${BORDER.subtle}`, borderRadius: 6,
                    padding: '5px 10px',
                  }}>
                    <span style={{ fontWeight: 700, color: INK.base }}>ETABS model units:</span>
                    <span>Force <b style={{ color: INK.base, ...MONO_NUM }}>{unitInfo.forceKey}</b></span>
                    <span>Length <b style={{ color: INK.base, ...MONO_NUM }}>{unitInfo.lengthKey}</b></span>
                    <span>Material f′c / fy <b style={{ color: INK.base, ...MONO_NUM }}>{unitInfo.stressUnit}</b></span>
                    <span style={{ color: INK.muted }}>
                      {unitInfo.assumed
                        ? '— assumed; ETABS did not report its present units'
                        : '— as reported by ETABS (present units)'}
                    </span>
                  </div>
                  {canOverrideUnits ? (
                    <>
                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                        <label style={unitField}>
                          Force
                          <Dropdown style={{ ...inp, width: 92 }} value={unitInfo.forceKey}
                            options={FORCE_UNITS.map(u => ({ value: u.key, label: u.label }))}
                            onChange={v => applyModelUnits({ forceKey: v })} />
                        </label>
                        <label style={unitField}>
                          Length
                          <Dropdown style={{ ...inp, width: 92 }} value={unitInfo.lengthKey}
                            options={LENGTH_UNITS.map(u => ({ value: u.key, label: u.label }))}
                            onChange={v => applyModelUnits({ lengthKey: v })} />
                        </label>
                        <label style={unitField}>
                          Material f′c / fy
                          <Dropdown style={{ ...inp, width: 148 }} value={stressOverride ?? 'auto'}
                            options={[
                              { value: 'auto', label: `Auto (${unitInfo.forceKey}/${unitInfo.lengthKey}²)` },
                              ...STRESS_UNITS.map(u => ({ value: u.key, label: u.label })),
                            ]}
                            onChange={v => applyModelUnits({ stress: v === 'auto' ? null : v })} />
                        </label>
                      </div>
                      {/* Derived read-outs so the user sees exactly what each quantity comes in as. */}
                      <div style={{ display: 'flex', gap: 18, rowGap: 4, flexWrap: 'wrap', fontSize: 11, color: INK.secondary }}>
                        <span>Forces V·P → <b style={{ color: INK.base, ...MONO_NUM }}>{unitInfo.forceKey}</b></span>
                        <span>Moments M·T → <b style={{ color: INK.base, ...MONO_NUM }}>{unitInfo.forceKey}·{unitInfo.lengthKey}</b></span>
                        <span>Sizes b·h·L → <b style={{ color: INK.base, ...MONO_NUM }}>{unitInfo.lengthKey}</b></span>
                        <span>Strength f′c·fy → <b style={{ color: INK.base, ...MONO_NUM }}>{stressOverride ? (STRESS_UNITS.find(s => s.key === stressOverride)?.label ?? stressOverride) : `${unitInfo.forceKey}/${unitInfo.lengthKey}²`}</b></span>
                      </div>

                      {/* Live "as read" sample — the surest sanity check: does a real
                          section + material land at a sensible size/strength? */}
                      {(sampleSec || sampleConc) && (
                        <div style={{ display: 'flex', gap: 18, rowGap: 4, flexWrap: 'wrap', fontSize: 11, color: INK.secondary, paddingTop: 6, borderTop: `1px solid ${BORDER.subtle}` }}>
                          <span style={{ fontWeight: 700, color: INK.base }}>Reads as:</span>
                          {sampleSec && <span><span style={{ ...MONO_NUM, color: ACCENT.primary }}>{sampleSec.name}</span> → <b style={{ color: INK.base }}>{wLen(sampleSec.width)}×{wLen(sampleSec.depth)} {wLenUnit}</b></span>}
                          {sampleConc && <span><span style={{ ...MONO_NUM, color: ACCENT.primary }}>{sampleConc.name}</span> → <b style={{ color: INK.base }}>f′c {wStress(sampleConc.fc!)}</b></span>}
                        </div>
                      )}

                      {unitsImplausible ? (
                        <div style={{ fontSize: 11, color: allOff ? STATUS.fail : STATUS.warn, background: allOff ? STATUS.failBg : STATUS.warnBg, border: `1px solid ${allOff ? STATUS.failBorder : STATUS.warnBorder}`, borderRadius: 6, padding: '6px 10px' }}>
                          <div style={{ fontWeight: 600 }}>
                            {allOff
                              ? '⚠ Every section and material reads wrong — the model units above do not match the data ETABS returned. Adjust Force / Length until the sizes and f′c read sensibly.'
                              : `⚠ ${oddSections.length + oddMaterials.length} of ${sections.length + materials.length} sections/materials read oddly — the rest are fine, so the units above are probably right and these are stray entries in the model.`}
                          </div>
                          <div style={{ marginTop: 4, color: INK.secondary, fontWeight: 400 }}>
                            {[
                              ...oddSections.slice(0, 3).map(sec => `${sec.name} → ${wLen(sec.width)}×${wLen(sec.depth)} ${wLenUnit}`),
                              ...oddMaterials.slice(0, 3).map(m => `${m.name} → ${m.fc != null ? `f′c ${wStress(m.fc)}` : `fy ${wStress(m.fy!)}`}`),
                            ].join(' · ')}
                            {oddSections.length + oddMaterials.length > 6 && ` · +${oddSections.length + oddMaterials.length - 6} more`}
                          </div>
                        </div>
                      ) : (
                        <div style={{ fontSize: 10, color: INK.muted }}>
                          Every imported value is scaled by these into the app's internal units (kip, kip-ft, in, psi). Change them only if the “Reads as” sizes/strengths above look wrong.
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ fontSize: 11, color: INK.secondary }}>
                      Demo model — values are authored directly in kip, kip-ft, in, psi. Connect to a live ETABS model to adjust unit interpretation.
                    </div>
                  )}
                </div>
              )}

              {/* The three model filters, on one line. Each was a wall of toggle chips
                  — on a real model, dozens each — which pushed the units card and the
                  combo list off screen behind a list nobody reads chip by chip. Same
                  semantics: nothing selected means everything is imported, and sections
                  ∪ groups still UNION rather than intersect. */}
              <div style={card}>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <MultiSelect
                    label="Stories / floors"
                    emptyText="No stories in model"
                    options={stories.map(st => ({ value: st, label: st }))}
                    selected={selStories}
                    onChange={n => { setSelStories(n); setMatchCount(null); }}
                  />
                  <MultiSelect
                    label="Beam sections"
                    emptyText="No sections in model"
                    options={sections.map(sec => ({ value: sec.name, label: `${sec.name} (${wLen(sec.width)}×${wLen(sec.depth)} ${wLenUnit})` }))}
                    selected={selSections}
                    onChange={n => { setSelSections(n); setMatchCount(null); }}
                  />
                  <MultiSelect
                    label="ETABS groups"
                    emptyText="No groups in model"
                    options={groups.map(g => ({ value: g, label: g }))}
                    selected={selGroups}
                    onChange={n => { setSelGroups(n); setMatchCount(null); }}
                  />
                  {/* Material — a HARD scope, not a third additive selector. "Leave the
                      steel behind" cannot be expressed as an OR: a steel beam inside a
                      selected ETABS group would match on the group and come in anyway. */}
                  <MultiSelect
                    label="Material"
                    emptyText="No section materials"
                    options={beamMaterials.map(m => ({
                      value: m.name,
                      label: `${m.name} — ${m.concrete ? `f′c ${wStress(m.fc!)}` : m.fy != null ? `fy ${wStress(m.fy)}, no f′c` : 'strength unknown'} · ${m.sectionCount} section${m.sectionCount === 1 ? '' : 's'}`,
                    }))}
                    selected={selMaterials}
                    onChange={n => { setSelMaterials(n); setMatchCount(null); }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
                  {/* One click for the case this filter was added for. It only TICKS
                      boxes — the selection stays visible and editable, so a material
                      the f′c heuristic guessed wrong about can be put back by hand. */}
                  {beamMaterials.some(m => !m.concrete) && (
                    <button
                      onClick={() => {
                        setSelMaterials(new Set(beamMaterials.filter(m => m.concrete).map(m => m.name)));
                        setMatchCount(null);
                      }}
                      style={{ fontSize: 11, color: ACCENT.primary, background: 'none', border: `1px solid ${BORDER.strong}`, borderRadius: 6, cursor: 'pointer', fontWeight: 600, padding: '3px 10px' }}
                      title="Keep only the materials that report an f′c — the usual way to leave steel framing behind">
                      Concrete only
                    </button>
                  )}
                  {(selSections.size > 0 || selGroups.size > 0) && (
                    <span style={{ fontSize: 10, color: INK.secondary }}>
                      Sections ∪ groups — a member matching either is imported.
                    </span>
                  )}
                  {selMaterials.size > 0 && (
                    <span style={{ fontSize: 10, color: INK.secondary }}>
                      Material is an <b>additional</b> filter — a beam must match it whatever else it matched.
                      Sections whose material ETABS did not report are kept.
                    </span>
                  )}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14 }}>
                <div style={card}>
                  {/* Forces come from the Element (analysis) table — see FORCE_SOURCE. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <div style={lbl}>Load combinations to import</div>
                    <span style={{ fontSize: 10, color: INK.muted }}>
                      {selCombos.size} of {combos.length} selected
                    </span>
                    <div style={{ flex: 1 }} />
                    <button onClick={() => setSelCombos(new Set(combos))}
                      style={{ fontSize: 11, color: ACCENT.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: '0 4px' }}>
                      All
                    </button>
                    <button onClick={() => setSelCombos(new Set())}
                      style={{ fontSize: 11, color: ACCENT.primary, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: '0 4px' }}>
                      None
                    </button>
                  </div>
                  {/* Scrollable checkbox list */}
                  <div style={{ maxHeight: 180, overflowY: 'auto', border: `1px solid ${BORDER.default}`, borderRadius: 6, background: 'white' }}>
                    {combos.map((c, i) => (
                      <label key={c} style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '5px 10px', cursor: 'pointer', fontSize: 12,
                        background: selCombos.has(c) ? ACCENT.softBg : 'transparent',
                        borderBottom: i < combos.length - 1 ? '1px solid #f3f4f6' : 'none',
                      }}>
                        <input
                          type="checkbox"
                          checked={selCombos.has(c)}
                          onChange={() => setSelCombos(prev => {
                            const n = new Set(prev);
                            if (n.has(c)) n.delete(c); else n.add(c);
                            return n;
                          })}
                          style={{ accentColor: ACCENT.primary }}
                        />
                        <span style={{ color: selCombos.has(c) ? ACCENT.primaryHover : INK.base, ...MONO_NUM }}>{c}</span>
                      </label>
                    ))}
                  </div>
                  {selCombos.size === 0 && (
                    <div style={{ fontSize: 11, color: STATUS.fail, marginTop: 4 }}>
                      Select at least one combination to continue.
                    </div>
                  )}
                  {selCombos.size > 0 && (
                    <div style={{ fontSize: 10, color: INK.secondary, marginTop: 4 }}>
                      Only the selected combinations are requested from ETABS.
                    </div>
                  )}
                  <div style={{ marginTop: 10 }}>
                    <div style={lbl}>SLS quasi-permanent combo (for EC2 crack width)</div>
                    <Dropdown
                      style={{ ...inp, width: '100%' }}
                      value={slsComboId}
                      options={[{ value: '', label: '— none / use M_qp ratio —' }, ...combos.map(c => ({ value: c, label: c }))]}
                      onChange={setSlsComboId}
                    />
                    <div style={{ fontSize: 10, color: INK.muted, marginTop: 3 }}>
                      If selected, this combo's moments are used as M_qp for EC2 §7.3.4 crack width checks.
                    </div>
                  </div>
                </div>
              </div>
              {/* Why a layer is empty. HIDDEN — it answers a question most imports never
                  raise, on a step that is already dense, so it is behind a flag rather
                  than on screen. The panel itself is untouched and still compiles; see
                  `utils/flags.ts` for the one console line that brings it back on a
                  machine that needs it. */}
              {flagOn('importDiagnostics') && (
                <ImportDiagnostics
                  connected={!!connInfo}
                  getConn={() => connRef.current}
                  canListTables={source === 'com'}
                  btn={btn} />
              )}

              {/* Materials preview folded into Advanced to keep the filter step light. */}
              <details style={card}>
                <summary style={{ ...lbl, marginBottom: 0, cursor: 'pointer' }}>
                  Advanced — materials imported with sections ({materials.length})
                </summary>
                <table style={{ fontSize: 11, borderCollapse: 'collapse', marginTop: 8 }}>
                  <tbody>
                    {materials.map(m => (
                      <tr key={m.name}>
                        <td style={{ padding: '2px 16px 2px 0', ...MONO_NUM, color: ACCENT.primary }}>{m.name}</td>
                        <td style={{ padding: '2px 16px 2px 0', color: INK.secondary }}>{m.fc ? `f'c = ${wStress(m.fc)}` : ''}</td>
                        <td style={{ color: INK.secondary }}>{m.fy ? `fy = ${wStress(m.fy)}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button style={btn()} onClick={() => setStep(0)}>← Back</button>
                <button style={btn()} disabled={busy} onClick={refreshMatchCount}>Count matching beams</button>
                {matchCount != null && <span style={{ fontSize: 12, color: INK.base, fontWeight: 600 }}>{matchCount} beams match</span>}
                <div style={{ flex: 1 }} />
                <button style={btn(true)} disabled={busy || selCombos.size === 0} onClick={() => setStep(2)}>
                  Next: Rebar defaults →
                </button>
              </div>
            </div>
          )}

          {/* ── Step 3: Rebar defaults ── */}
          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 620 }}>
              {/* Code + units picker */}
              <div style={{ ...card, display: 'flex', gap: 24, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div>
                  <div style={lbl}>Design code</div>
                  <Dropdown
                    style={inp}
                    value={wizardCode}
                    options={[{ value: 'ACI318-19', label: 'ACI 318-19' }, { value: 'EN1992-1-1', label: 'EN 1992-1-1 (EC2)' }]}
                    onChange={v => setWizardCode(v as DesignCode)}
                  />
                </div>
                <div>
                  <div style={lbl}>Units (rebar display)</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      onClick={() => handleWizardUnitsChange('imperial')}
                      style={{ ...btn(wizardUnits === 'imperial'), padding: '5px 14px', fontSize: 12 }}>
                      Imperial (in)
                    </button>
                    <button
                      onClick={() => handleWizardUnitsChange('si')}
                      style={{ ...btn(wizardUnits === 'si'), padding: '5px 14px', fontSize: 12 }}>
                      SI (mm)
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={applyToProject}
                      onChange={e => setApplyToProject(e.target.checked)}
                    />
                    <span style={{ fontSize: 11, color: INK.secondary, fontWeight: 600 }}>Apply to project</span>
                  </label>
                  <div style={{ fontSize: 11, color: INK.muted, maxWidth: 240 }}>
                    Sets the project's design code and unit system to match these wizard selections on import.
                  </div>
                </div>
              </div>
              <div style={card}>
                <div style={lbl}>Typical longitudinal steel (% of b·d)</div>
                <div style={{ display: 'flex', gap: 18 }}>
                  {([['rhoTopPct', 'Top bars ρ'], ['rhoBotPct', 'Bottom bars ρ']] as const).map(([key, label]) => (
                    <label key={key} style={{ fontSize: 12, color: INK.secondary, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {label}
                      <input type="number" step={0.05} min={0.1} max={2.5} style={{ ...inp, width: 70 }}
                        value={seed[key]}
                        onChange={e => setSeed(s => ({ ...s, [key]: +e.target.value }))} /> %
                    </label>
                  ))}
                </div>
              </div>
              <div style={card}>
                <div style={lbl}>Stirrup spacing by zone — thirds of span ({wizardUnits === 'si' ? 'mm' : 'in'})</div>
                <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                  {['End (0–L/3)', 'Middle (L/3–2L/3)', 'End (2L/3–L)'].map((zl, i) => (
                    <label key={zl} style={{ fontSize: 12, color: INK.secondary, display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {zl}
                      <input type="number"
                        step={wizardUnits === 'si' ? 10 : 0.5} min={wizardUnits === 'si' ? 50 : 2}
                        style={{ ...inp, width: 80 }}
                        value={wizardUnits === 'si' ? Math.round(seed.stirrupSpacings[i] * IN_TO_MM) : seed.stirrupSpacings[i]}
                        onChange={e => setSeed(s => {
                          const sp = [...s.stirrupSpacings] as [number, number, number];
                          const v = +e.target.value;
                          sp[i] = wizardUnits === 'si' ? v / IN_TO_MM : v;
                          return { ...s, stirrupSpacings: sp };
                        })} />
                    </label>
                  ))}
                  <label style={{ fontSize: 12, color: INK.secondary, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    Stirrup size
                    <Dropdown style={inp} value={seed.stirrupBarSize ?? defaultBarSizes(barFamily).stirrup}
                      options={barSizeOptions(barFamily, seed.stirrupBarSize ?? defaultBarSizes(barFamily).stirrup)
                        .filter(b => b === (seed.stirrupBarSize ?? defaultBarSizes(barFamily).stirrup) || (b > 0 ? b <= 8 : -b <= 20))
                        .map(b => ({ value: b, label: formatBarLabel(b) }))}
                      onChange={v => setSeed(s => ({ ...s, stirrupBarSize: +v }))}
                    />
                  </label>
                </div>
                <p style={{ fontSize: 11, color: INK.muted, margin: '8px 0 0' }}>
                  Bar sizes/counts are auto-selected per section to meet the target steel area; you can edit any beam afterwards.
                </p>
              </div>
              <div style={card}>
                <div style={lbl}>Minimum face / skin reinforcement</div>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ fontSize: 12, color: INK.base, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!seed.imposeSkinReinf}
                      onChange={e => setSeed(s => ({ ...s, imposeSkinReinf: e.target.checked }))} />
                    Auto-impose per {wizardCode === 'EN1992-1-1' ? 'EC2' : 'ACI'}
                  </label>
                  <label style={{ fontSize: 12, color: INK.secondary, display: 'flex', flexDirection: 'column', gap: 3, opacity: seed.imposeSkinReinf ? 1 : 0.4 }}>
                    Skin bar size
                    <Dropdown style={inp} value={seed.skinBarSize ?? defaultBarSizes(barFamily).skin}
                      disabled={!seed.imposeSkinReinf}
                      options={barSizeOptions(barFamily, seed.skinBarSize ?? defaultBarSizes(barFamily).skin)
                        .filter(b => b === (seed.skinBarSize ?? defaultBarSizes(barFamily).skin) || (b > 0 ? b <= 8 : -b <= 20))
                        .map(b => ({ value: b, label: formatBarLabel(b) }))}
                      onChange={v => setSeed(s => ({ ...s, skinBarSize: +v }))}
                    />
                  </label>
                </div>
                <p style={{ fontSize: 11, color: INK.muted, margin: '8px 0 0' }}>
                  {wizardCode === 'EN1992-1-1'
                    ? 'EC2 §7.3.3: surface reinforcement on deep beams (h > 1000 mm), distributed over the tension half at ≤ 300 mm.'
                    : 'ACI 318 §9.7.2.3: skin reinforcement where h > 36 in, distributed over the lower h/2 at ≤ 12 in.'}
                  {' '}Shallower sections get no side bars. Edit per beam afterwards.
                </p>
              </div>
              {/* Cover override */}
              <div style={card}>
                <div style={lbl}>Clear cover to stirrup face ({wizardUnits === 'si' ? 'mm' : 'in'})</div>
                <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                  <label style={{ fontSize: 12, color: INK.secondary, display: 'flex', alignItems: 'center', gap: 6 }}>
                    Cover
                    <input
                      type="number"
                      step={wizardUnits === 'si' ? 5 : 0.25}
                      min={wizardUnits === 'si' ? 10 : 0.5}
                      max={wizardUnits === 'si' ? 100 : 4}
                      style={{ ...inp, width: 80 }}
                      value={wizardUnits === 'si'
                        ? Math.round((seed.coverClear ?? 1.5) * IN_TO_MM)
                        : (seed.coverClear ?? 1.5)}
                      onChange={e => {
                        const v = +e.target.value;
                        setSeed(s => ({ ...s, coverClear: wizardUnits === 'si' ? v / IN_TO_MM : v }));
                      }}
                    />
                  </label>
                  <span style={{ fontSize: 11, color: INK.muted }}>
                    Applies to all imported beams (default {wizardUnits === 'si' ? '38 mm' : '1.5 in'}).
                    Affects effective depth and bar placement.
                  </span>
                </div>
              </div>

              {/* Material overrides */}
              <div style={card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                  onClick={() => setMatOverride(s => ({ ...s, collapsed: !s.collapsed }))}>
                  <input
                    type="checkbox"
                    checked={matOverride.enabled}
                    onClick={e => e.stopPropagation()}
                    onChange={e => setMatOverride(s => ({ ...s, enabled: e.target.checked, collapsed: !e.target.checked ? s.collapsed : false }))}
                  />
                  <span style={{ fontSize: 12, fontWeight: 700, color: INK.base, flex: 1 }}>
                    Override material properties (global)
                  </span>
                  <span style={{ fontSize: 11, color: INK.muted }}>{matOverride.collapsed ? '▾' : '▴'}</span>
                </div>
                {!matOverride.collapsed && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11, color: INK.secondary, marginBottom: 8 }}>
                      Overrides apply to all imported beams. Leave blank to keep per-section values from ETABS.
                      Values in {wizardUnits === 'si' ? 'MPa' : 'psi'}.
                    </div>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                      {([
                        ['fck', wizardUnits === 'si' ? "f'ck (MPa)" : "f'c (psi)", 'Concrete compressive strength'],
                        ['fyLong', wizardUnits === 'si' ? 'fy long (MPa)' : 'fy long (psi)', 'Longitudinal steel yield strength'],
                        ['fyTie', wizardUnits === 'si' ? 'fy tie (MPa)' : 'fyt (psi)', 'Transverse steel yield strength'],
                      ] as const).map(([key, labelText, title]) => (
                        <label key={key} title={title} style={{ fontSize: 12, color: INK.secondary, display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {labelText}
                          <input
                            type="number"
                            min={1}
                            style={{ ...inp, width: 100, opacity: matOverride.enabled ? 1 : 0.5 }}
                            disabled={!matOverride.enabled}
                            value={matOverride[key]}
                            placeholder="—"
                            onChange={e => setMatOverride(s => ({ ...s, [key]: e.target.value }))}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button style={btn()} onClick={() => setStep(1)}>← Back</button>
                <div style={{ flex: 1 }} />
                <button style={btn(true)} disabled={busy} onClick={buildAndReview}>
                  {busy ? 'Importing forces…' : 'Run design check →'}
                </button>
              </div>
            </div>
          )}

          {/* ── Step 4: Plan map review ── */}
          {step === 3 && (
            <div style={{ display: 'flex', gap: 16 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: INK.strong }}>
                    {beamCount} beams · {selStories.size ? (selStories.size === 1 ? [...selStories][0] : `${selStories.size} stories`) : 'all stories'}
                  </span>
                  <div style={{ flex: 1 }} />
                  <label style={{ fontSize: 11, color: INK.secondary }}>
                    Show DCR ≥{' '}
                    <Dropdown style={inp} value={minDCR}
                      options={[{ value: 0, label: 'all' }, { value: 0.7, label: '0.70' }, { value: 0.9, label: '0.90' }, { value: 1.0, label: '1.00 (failing)' }]}
                      onChange={v => setMinDCR(+v)}
                    />
                  </label>
                </div>
                <PlanMap
                  members={members} dcrById={dcrById} selected={selected}
                  onToggleSelect={toggleSelect}
                  onPick={id => commit(id)}
                  minDCR={minDCR}
                />
              </div>

              {/* Group sidebar */}
              <div style={{ width: 290, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={card}>
                  <div style={lbl}>Design groups</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
                    {designGroups.map(g => {
                      const w = groupWorstDCR(g);
                      return (
                        <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 4, background: dcrToColor(w), flexShrink: 0 }} />
                          <span style={{ flex: 1, color: INK.base, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {g.label} <span style={{ color: INK.muted }}>({g.memberIds.length})</span>
                          </span>
                          <span style={{ ...MONO_NUM, fontWeight: 700, color: dcrToColor(w) }}>{w.toFixed(2)}</span>
                        </div>
                      );
                    })}
                  </div>
                  <button style={{ ...btn(), marginTop: 8, width: '100%' }}
                    disabled={selected.size < 2} onClick={mergeSelectedIntoGroup}>
                    Merge {selected.size || ''} selected into new group
                  </button>
                  <p style={{ fontSize: 10, color: INK.muted, margin: '6px 0 0' }}>
                    Shift-click beams on the map to multi-select. Auto-groups = story × section.
                  </p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {/* Next-steps summary — closes the wizard by naming the workflow. */}
                  <div style={{ background: ACCENT.softBg, border: `1px solid ${ACCENT.softBorder}`, borderRadius: 8, padding: '8px 10px', fontSize: 11, color: '#1e40af', lineHeight: 1.5 }}>
                    <b>Next:</b> group members → design rebar → run S-Concrete to verify.
                  </div>
                  {unmatchedGrade.length > 0 && (
                    <div style={{ background: STATUS.warnBg, border: `1px solid ${STATUS.warnBorder}`, borderRadius: 8, padding: '8px 10px', fontSize: 11, color: STATUS.warn, lineHeight: 1.5 }}>
                      <b>Concrete grade not matched</b> for {unmatchedGrade.length === 1 ? 'material' : 'materials'}{' '}
                      {unmatchedGrade.map(n => `"${n}"`).join(', ')} — those beams import at the default
                      f′c and will read as a different grade from the rest. Set f′c below, or in project settings after import.
                    </div>
                  )}
                  <button style={btn()} onClick={() => setStep(2)}>← Back to rebar</button>
                  <button style={btn(true)} onClick={() => commit()}>
                    Import {members.length} member{members.length === 1 ? '' : 's'} into project
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
