/**
 * Project Setup / Settings — the one place the project-wide design standards
 * are entered.
 *
 * Shown automatically the first time the app is opened ("setup" mode) and
 * re-openable any time from the gear beside Export ("settings" mode). Saving
 * runs applyProjectSettings(), which writes the standards onto every member, so
 * the values chosen here drive the design engines, the screens and every export.
 *
 * Unit handling: the dialog owns its OWN unit selection, because changing units
 * is one of the things it does. Every number is stored imperial and converted at
 * the input boundary only — the same convention MemberEditor uses.
 */
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { DesignCode, ProjectSettings } from '../../types';
import type { Quantity, UnitSystem } from '../../utils/units';
import { toDisplay, fromDisplay, unitLabel } from '../../utils/units';
import { defaultSettings, derivedModuli, withDerivedModuli } from '../../utils/projectSettings';
import { ACCENT, BORDER, FONT, ICON, INK, LABEL_STYLE, SURFACE, TYPE, WEIGHT } from '../../theme';
import { Icon } from '../common/Icon';
import type { IconName } from '../common/Icon';

const CODES: { value: DesignCode; label: string; sub: string }[] = [
  { value: 'ACI318-19', label: 'ACI 318-19', sub: 'US · current' },
  { value: 'ACI318-14', label: 'ACI 318-14', sub: 'US · legacy' },
  { value: 'EN1992-1-1', label: 'Eurocode 2', sub: 'EN 1992-1-1' },
];

const UNIT_OPTIONS: { value: UnitSystem; label: string; sub: string }[] = [
  { value: 'imperial', label: 'US customary', sub: 'in · psi · kips' },
  { value: 'si', label: 'SI / metric', sub: 'mm · MPa · kN' },
];

const SCALES = [0.75, 0.9, 1.0, 1.1, 1.25, 1.5];

const COT_THETA: [number, string][] = [
  [2.5, '2.5 · θ = 21.8° (EC2 max)'],
  [2.0, '2.0 · θ = 26.6°'],
  [1.5, '1.5 · θ = 33.7°'],
  [1.25, '1.25 · θ = 38.7° (S-CONCRETE)'],
  [1.0, '1.0 · θ = 45°'],
];

/** Decimal places a quantity reads well at in each unit system. */
function digitsFor(q: Quantity, u: UnitSystem): number {
  if (q === 'length') return u === 'si' ? 0 : 2;
  return u === 'si' ? 1 : 0;   // stresses: 34.5 MPa vs 5000 psi
}

function fmtNum(v: number, dp: number): string {
  if (!Number.isFinite(v)) return '';
  return String(+v.toFixed(dp));
}

// ── Field primitives ──────────────────────────────────────────────────────────

const inputStyle: CSSProperties = {
  width: '100%', padding: '6px 9px', border: `1px solid ${BORDER.strong}`, borderRadius: 6,
  fontSize: TYPE.body, color: INK.strong, background: 'white', outline: 'none',
  fontFamily: FONT.mono, minWidth: 0,
};

interface NumFieldProps {
  label: string;
  /** Stored (imperial) value. */
  value: number;
  onChange: (imperial: number) => void;
  /** Converts at the boundary. Omit for unitless values (λ, cot θ, mm limits). */
  quantity?: Quantity;
  units: UnitSystem;
  /** Shown instead of the quantity's unit label (e.g. "mm" for crack width). */
  unit?: string;
  dp?: number;
  step?: number;
  min?: number;
  hint?: string;
  disabled?: boolean;
  /** Called when a disabled field is clicked — used to unlock the auto moduli. */
  onUnlock?: () => void;
}

function NumField({
  label, value, onChange, quantity, units, unit, dp, step, min, hint, disabled, onUnlock,
}: NumFieldProps) {
  const decimals = dp ?? (quantity ? digitsFor(quantity, units) : 2);
  const display = quantity ? toDisplay(value, quantity, units) : value;
  const [text, setText] = useState(() => fmtNum(display, decimals));

  // Re-seed the box only when the value changed from OUTSIDE (unit switch, an
  // auto-recomputed modulus). While the user types, `text` already parses to
  // `display`, so their half-typed input is never yanked out from under them.
  // Adjusting state during render — not in an effect — is React's documented
  // pattern for "reset some state when a prop changes".
  const [lastDisplay, setLastDisplay] = useState(display);
  if (Math.abs(display - lastDisplay) > 1e-9) {
    setLastDisplay(display);
    const cur = parseFloat(text);
    if (!Number.isFinite(cur) || Math.abs(cur - display) > 0.5 * Math.pow(10, -decimals)) {
      setText(fmtNum(display, decimals));
    }
  }

  const suffix = unit ?? (quantity ? unitLabel(quantity, units) : '');

  return (
    <label style={{ display: 'block', minWidth: 0 }}>
      <span style={{ display: 'block', fontSize: TYPE.label, color: INK.secondary, marginBottom: 3 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="number" value={text} step={step} min={min} disabled={disabled}
          onChange={e => {
            setText(e.target.value);
            const n = parseFloat(e.target.value);
            if (!Number.isFinite(n)) return;
            const imperial = quantity ? fromDisplay(n, quantity, units) : n;
            setLastDisplay(quantity ? toDisplay(imperial, quantity, units) : imperial);
            onChange(imperial);
          }}
          onFocus={disabled ? onUnlock : undefined}
          onMouseDown={disabled ? onUnlock : undefined}
          style={{
            ...inputStyle,
            background: disabled ? SURFACE.subtle : 'white',
            color: disabled ? INK.secondary : INK.strong,
            cursor: disabled ? 'pointer' : 'text',
          }}
        />
        {suffix && (
          <span style={{ fontSize: TYPE.label, color: INK.muted, flexShrink: 0, width: 34 }}>{suffix}</span>
        )}
      </div>
      {hint && <span style={{ display: 'block', fontSize: TYPE.micro, color: INK.muted, marginTop: 3 }}>{hint}</span>}
    </label>
  );
}

interface SegmentedProps<T extends string | number> {
  value: T;
  options: { value: T; label: string; sub?: string }[];
  onChange: (v: T) => void;
  /** Fixed-width columns; `auto` lets short options (scale %) sit side by side. */
  columns?: string;
}

function Segmented<T extends string | number>({ value, options, onChange, columns }: SegmentedProps<T>) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: columns ?? `repeat(${options.length}, minmax(0, 1fr))`,
      gap: 6,
    }}>
      {options.map(o => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)} type="button" onClick={() => onChange(o.value)}
            style={{
              padding: o.sub ? '8px 10px' : '7px 8px', borderRadius: 8, cursor: 'pointer',
              textAlign: 'left', lineHeight: 1.3,
              border: `1px solid ${on ? ACCENT.primary : BORDER.strong}`,
              background: on ? ACCENT.softBg : 'white',
              color: on ? ACCENT.primary : INK.base,
              fontWeight: on ? WEIGHT.bold : WEIGHT.semibold,
              fontSize: TYPE.body,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              {on && <span style={{ fontSize: TYPE.micro }}>✓</span>}
              <span>{o.label}</span>
            </div>
            {o.sub && (
              <div style={{ fontSize: TYPE.micro, color: on ? ACCENT.primary : INK.muted, fontWeight: WEIGHT.normal }}>
                {o.sub}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Section({ icon, title, note, children }: {
  icon: IconName; title: string; note?: string; children: ReactNode;
}) {
  return (
    <section style={{
      background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 10,
      padding: '13px 15px', marginBottom: 10,
    }}>
      <div style={{ ...LABEL_STYLE, display: 'flex', alignItems: 'center', gap: 6, marginBottom: note ? 4 : 10 }}>
        <Icon name={icon} size={ICON.sm} />{title}
      </div>
      {note && <p style={{ fontSize: TYPE.micro, color: INK.muted, margin: '0 0 10px' }}>{note}</p>}
      {children}
    </section>
  );
}

/** Two/three-up responsive field row. */
const grid = (min: number): CSSProperties => ({
  display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 10,
});

// ── Dialog ────────────────────────────────────────────────────────────────────

export interface ProjectSettingsDialogProps {
  mode: 'setup' | 'settings';
  /** Current project name; the setup dialog seeds its field from this. */
  projectName: string;
  code: DesignCode;
  settings: ProjectSettings;
  onCancel?: () => void;
  onSave: (next: { name: string; code: DesignCode; settings: ProjectSettings }) => void;
}

export default function ProjectSettingsDialog({
  mode, projectName, code: codeIn, settings: settingsIn, onCancel, onSave,
}: ProjectSettingsDialogProps) {
  const isSetup = mode === 'setup';
  // On first run the placeholder is the point — start empty so the user sees it.
  const [name, setName] = useState(isSetup ? '' : projectName);
  const [code, setCode] = useState<DesignCode>(codeIn);
  const [s, setS] = useState<ProjectSettings>(settingsIn);

  const set = (patch: Partial<ProjectSettings>) =>
    setS(prev => withDerivedModuli({ ...prev, ...patch }, code));

  /**
   * Switching code re-bases everything the code owns: the unit system it is
   * written in, and — on first setup, where nothing has been typed yet — that
   * code's standard material grades and cover. In settings mode the engineer's
   * numbers are kept; only the derived moduli follow the new code's formula.
   */
  function changeCode(next: DesignCode) {
    setCode(next);
    setS(prev => {
      if (isSetup) return { ...defaultSettings(next), displayScale: prev.displayScale };
      const wasEc2 = code === 'EN1992-1-1';
      const isEc2 = next === 'EN1992-1-1';
      const units = wasEc2 === isEc2 ? prev.units : (isEc2 ? 'si' : 'imperial');
      return withDerivedModuli({ ...prev, units }, next);
    });
  }

  const isEC2 = code === 'EN1992-1-1';
  const u = s.units;
  const codeModuli = useMemo(() => derivedModuli(s.fc, code), [s.fc, code]);
  const moduliDiffer = !s.autoModuli && (
    Math.abs(s.Es - codeModuli.Es) > 1 ||
    Math.abs(s.Ec - codeModuli.Ec) > 1 ||
    Math.abs(s.Gc - codeModuli.Gc) > 1
  );

  const placeholder = 'e.g. Riverside Tower — Podium Frame';
  const trimmed = name.trim();

  function save() {
    onSave({
      name: trimmed || (isSetup ? 'Untitled Project' : projectName),
      code,
      settings: withDerivedModuli(s, code),
    });
  }

  // Esc closes the settings dialog. First-run setup has no cancel — the project
  // needs standards before anything can be designed.
  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
      onMouseDown={e => { if (onCancel && e.target === e.currentTarget) onCancel(); }}
    >
      <div
        role="dialog" aria-modal="true" aria-label={isSetup ? 'Project setup' : 'Project settings'}
        style={{
          background: SURFACE.app, borderRadius: 14, width: 'min(760px, 100%)',
          maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(15,23,42,0.35)', fontFamily: FONT.ui,
        }}
      >
        {/* Header */}
        <div style={{
          background: 'white', borderBottom: `1px solid ${BORDER.default}`,
          padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
        }}>
          <div style={{
            width: 34, height: 34, borderRadius: 9, background: ACCENT.primary, color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <Icon name="settings" size={ICON.lg} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: TYPE.heading, fontWeight: WEIGHT.bold, color: INK.strong, lineHeight: 1.2 }}>
              {isSetup ? 'Set up your project' : 'Project settings'}
            </div>
            <div style={{ fontSize: TYPE.label, color: INK.secondary }}>
              {isSetup
                ? 'These standards apply to every member, calculation and export. You can change them later from the gear beside Export.'
                : 'Saving re-applies these standards to every member — calculations, screens and exports all follow.'}
            </div>
          </div>
          {onCancel && (
            <button
              type="button" onClick={onCancel} aria-label="Close"
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: INK.muted, fontSize: 18, lineHeight: 1, padding: 4 }}
            >✕</button>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
          {/* Project name */}
          <Section icon="dashboard" title="Project">
            <label style={{ display: 'block' }}>
              <span style={{ display: 'block', fontSize: TYPE.label, color: INK.secondary, marginBottom: 3 }}>
                Project name
              </span>
              <input
                autoFocus={isSetup}
                value={name} placeholder={placeholder}
                onChange={e => setName(e.target.value)}
                style={{ ...inputStyle, fontFamily: FONT.ui }}
              />
            </label>
          </Section>

          {/* Code + units */}
          <Section icon="docs" title="Design code" note="Sets the checks that run, the clause references and the unit system the code is written in.">
            <Segmented value={code} options={CODES} onChange={changeCode} />
            <div style={{ ...LABEL_STYLE, margin: '14px 0 6px' }}>Units</div>
            <Segmented value={u} options={UNIT_OPTIONS} onChange={v => set({ units: v })} />
            <p style={{ fontSize: TYPE.micro, color: INK.muted, margin: '6px 0 0' }}>
              Display only — everything below is entered and shown in these units.
            </p>
          </Section>

          {/* Materials */}
          <Section icon="materials" title="Material properties">
            <div style={{ ...LABEL_STYLE, marginBottom: 6 }}>Concrete</div>
            <div style={grid(150)}>
              <NumField
                label={isEC2 ? "Cylinder strength f_ck" : "Compressive strength f'c"}
                value={s.fc} quantity="stress" units={u} min={0}
                step={u === 'si' ? 1 : 500}
                onChange={v => set({ fc: v })}
              />
              <NumField
                label="Lightweight factor λ" value={s.lambdaConcrete} units={u}
                step={0.05} min={0} dp={2}
                hint="1.00 normalweight · 0.75 all-lightweight"
                onChange={v => set({ lambdaConcrete: v })}
              />
            </div>
            <div style={{ ...LABEL_STYLE, margin: '14px 0 6px' }}>Reinforcing steel</div>
            <div style={grid(150)}>
              <NumField
                label={isEC2 ? 'Yield f_yk (longitudinal)' : 'Yield fy (longitudinal)'}
                value={s.fy} quantity="stress" units={u} min={0}
                step={u === 'si' ? 10 : 5000}
                onChange={v => set({ fy: v })}
              />
              <NumField
                label={isEC2 ? 'Yield f_ywk (links)' : 'Yield fyt (stirrups / ties)'}
                value={s.fyt} quantity="stress" units={u} min={0}
                step={u === 'si' ? 10 : 5000}
                onChange={v => set({ fyt: v })}
              />
            </div>
          </Section>

          {/* Elastic constants */}
          <Section
            icon="steelLimits" title="Elastic constants"
            note={
              s.autoModuli
                ? `Calculated from f'c and ${isEC2 ? 'EN 1992-1-1 §3.1.3' : 'ACI 318-19 §19.2.2.1'}. Click any value to enter your own.`
                : 'Custom values — these are used in place of the code formulas everywhere.'
            }
          >
            <div style={grid(140)}>
              <NumField
                label="Steel modulus Es" value={s.Es} quantity="stress" units={u} min={0}
                disabled={s.autoModuli} onUnlock={() => set({ autoModuli: false })}
                onChange={v => set({ Es: v })}
              />
              <NumField
                label={isEC2 ? 'Concrete modulus E_cm' : 'Concrete modulus Ec'}
                value={s.Ec} quantity="stress" units={u} min={0}
                disabled={s.autoModuli} onUnlock={() => set({ autoModuli: false })}
                onChange={v => set({ Ec: v, Gc: v / 2.4 })}
              />
              <NumField
                label="Shear modulus Gc" value={s.Gc} quantity="stress" units={u} min={0}
                disabled={s.autoModuli} onUnlock={() => set({ autoModuli: false })}
                onChange={v => set({ Gc: v })}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: TYPE.label, color: INK.base, cursor: 'pointer' }}>
                <input
                  type="checkbox" checked={s.autoModuli}
                  onChange={e => setS(prev => e.target.checked
                    ? { ...prev, autoModuli: true, ...derivedModuli(prev.fc, code) }
                    : { ...prev, autoModuli: false })}
                />
                Keep in step with f&apos;c (recommended)
              </label>
              {moduliDiffer && (
                <button
                  type="button"
                  onClick={() => setS(prev => ({ ...prev, ...derivedModuli(prev.fc, code) }))}
                  style={{ border: 'none', background: 'none', color: ACCENT.primary, fontSize: TYPE.label, fontWeight: WEIGHT.semibold, cursor: 'pointer', padding: 0 }}
                >
                  Reset to code values
                </button>
              )}
              <span style={{ fontSize: TYPE.micro, color: INK.muted }}>
                Gc = Ec / 2.4 (ν = 0.2)
              </span>
            </div>
          </Section>

          {/* Cover */}
          <Section
            icon="sectionDims" title="Clear cover to links"
            note="Measured to the outside of the stirrup / tie. Columns and circular sections use the largest of the three."
          >
            <div style={grid(130)}>
              <NumField label="Top" value={s.coverTop} quantity="length" units={u} min={0}
                step={u === 'si' ? 5 : 0.25} onChange={v => set({ coverTop: v })} />
              <NumField label="Bottom" value={s.coverBottom} quantity="length" units={u} min={0}
                step={u === 'si' ? 5 : 0.25} onChange={v => set({ coverBottom: v })} />
              <NumField label="Side" value={s.coverSide} quantity="length" units={u} min={0}
                step={u === 'si' ? 5 : 0.25} onChange={v => set({ coverSide: v })} />
            </div>
          </Section>

          {/* EC2-only */}
          {isEC2 && (
            <Section
              icon="crackWidth" title="Eurocode 2 serviceability"
              note="Crack widths are always in mm (EN 1992-1-1 §7.3.1), whichever display units are selected."
            >
              <div style={grid(150)}>
                <NumField
                  label="Crack width limit w_max" value={s.crackWidthLimit} units={u} unit="mm"
                  step={0.05} min={0} dp={2}
                  hint="Applied to the top, bottom and side faces"
                  onChange={v => set({ crackWidthLimit: v })}
                />
              </div>
              <div style={{ ...LABEL_STYLE, margin: '14px 0 6px' }}>Shear strut angle (cot θ) — §6.2.3</div>
              <Segmented
                value={s.cotTheta} columns="repeat(auto-fit, minmax(150px, 1fr))"
                options={COT_THETA.map(([v, label]) => ({ value: v, label }))}
                onChange={v => set({ cotTheta: v })}
              />
              <p style={{ fontSize: TYPE.micro, color: INK.muted, margin: '6px 0 0' }}>
                Lower cot θ = steeper strut = more conservative shear and torsion capacity.
              </p>
            </Section>
          )}

          {/* Preferences */}
          <Section icon="settings" title="Preferences">
            <div style={{ ...LABEL_STYLE, marginBottom: 6 }}>Display scale</div>
            <Segmented
              value={s.displayScale} columns="repeat(auto-fit, minmax(84px, 1fr))"
              options={SCALES.map(z => ({ value: z, label: z === 1 ? '100%' : `${Math.round(z * 100)}%` }))}
              onChange={v => set({ displayScale: v })}
            />
            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 14, cursor: 'pointer',
              padding: '10px 12px', border: `1px solid ${s.ignoreTorsion ? ACCENT.softBorder : BORDER.default}`,
              borderRadius: 8, background: s.ignoreTorsion ? ACCENT.softBg : SURFACE.subtle,
            }}>
              <input
                type="checkbox" checked={s.ignoreTorsion} style={{ marginTop: 2 }}
                onChange={e => set({ ignoreTorsion: e.target.checked })}
              />
              <span>
                <span style={{ display: 'block', fontSize: TYPE.body, fontWeight: WEIGHT.semibold, color: INK.strong }}>
                  Neglect torsion (Tu = 0)
                </span>
                <span style={{ display: 'block', fontSize: TYPE.micro, color: INK.secondary, marginTop: 2 }}>
                  Skips every torsion check and writes no torsion into the S-Concrete export. Use where
                  torsion is compatibility-only and can be redistributed.
                </span>
              </span>
            </label>
          </Section>
        </div>

        {/* Footer */}
        <div style={{
          background: 'white', borderTop: `1px solid ${BORDER.default}`, padding: '12px 18px',
          display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        }}>
          <span style={{ flex: 1, fontSize: TYPE.micro, color: INK.muted, minWidth: 0 }}>
            {isSetup
              ? 'Every member starts from these values; individual members can still be tuned afterwards.'
              : 'Per-member material and cover edits will be overwritten by these values.'}
          </span>
          {onCancel && (
            <button
              type="button" onClick={onCancel}
              style={{
                padding: '8px 16px', borderRadius: 8, border: `1px solid ${BORDER.strong}`,
                background: 'white', color: INK.base, fontSize: TYPE.body, fontWeight: WEIGHT.semibold, cursor: 'pointer',
              }}
            >Cancel</button>
          )}
          <button
            type="button" onClick={save}
            style={{
              padding: '8px 18px', borderRadius: 8, border: 'none',
              background: ACCENT.primary, color: 'white', fontSize: TYPE.body, fontWeight: WEIGHT.bold, cursor: 'pointer',
            }}
          >{isSetup ? 'Start designing' : 'Save & apply'}</button>
        </div>
      </div>
    </div>
  );
}
