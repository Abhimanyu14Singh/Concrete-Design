/**
 * Project-wide design standards — defaults, code-derived elastic constants, and
 * the propagation that pushes the standards onto every member.
 *
 * The engines read their inputs from each MEMBER (material, section cover,
 * crack params), not from the project. So "change it once, see it everywhere"
 * works by writing the settings down onto every member whenever they are saved
 * — applyProjectSettings() below. That keeps the engines, the .SCO writers and
 * all exports on one code path with no project-vs-member precedence rules to
 * get wrong.
 *
 * Everything here is in the app's internal imperial base units (in, psi). The
 * dialog converts at the input boundary, exactly like MemberEditor does.
 */

import type { DesignCode, Member, Project, ProjectSettings } from '../types';
import { DEFAULT_CRACK_PARAMS } from '../types';

/** psi ↔ MPa, the one conversion the code formulas need. */
const PSI_PER_MPA = 145.0377;

/** Poisson's ratio for concrete — EN 1992-1-1 §3.1.3(4) and ACI practice. */
export const POISSON_CONCRETE = 0.2;

/**
 * Steel modulus Es for the active code: ACI §20.2.2.2 gives 29,000,000 psi;
 * EN 1992-1-1 §3.2.7(4) gives 200 GPa (≈ 29,008,000 psi). The EC2 value is
 * returned in psi so it stays in the app's base units.
 */
export function autoEs(code: DesignCode): number {
  return code === 'EN1992-1-1' ? 200_000 * PSI_PER_MPA : 29_000_000;
}

/**
 * Concrete modulus from f'c under the active code:
 *   • ACI 318-19 §19.2.2.1(b): Ec = 57000·√f'c  (psi, normalweight)
 *   • EN 1992-1-1 §3.1.3 Table 3.1: Ecm = 22000·((fck+8)/10)^0.3  (MPa)
 * fcPsi is the cylinder strength in psi in both cases.
 */
export function autoEc(fcPsi: number, code: DesignCode): number {
  if (!(fcPsi > 0)) return 0;
  if (code === 'EN1992-1-1') {
    const fck = fcPsi / PSI_PER_MPA;                        // MPa
    return 22000 * Math.pow((fck + 8) / 10, 0.3) * PSI_PER_MPA;
  }
  return 57000 * Math.sqrt(fcPsi);
}

/** Elastic shear modulus Gc = Ec / (2(1+ν)) — with ν = 0.2 this is Ec/2.4. */
export function autoGc(ecPsi: number): number {
  return ecPsi / (2 * (1 + POISSON_CONCRETE));
}

/** The three elastic constants derived together from f'c and the code. */
export function derivedModuli(fcPsi: number, code: DesignCode): { Es: number; Ec: number; Gc: number } {
  const Ec = autoEc(fcPsi, code);
  return { Es: autoEs(code), Ec, Gc: autoGc(Ec) };
}

/**
 * Standards a brand-new project starts from, in the units the chosen code is
 * normally written in: ACI → 4 ksi / Grade 60 / 1.5" cover; EC2 → C30/37 /
 * B500 / 30 mm cover with a 0.3 mm crack limit.
 */
export function defaultSettings(code: DesignCode = 'ACI318-19'): ProjectSettings {
  const ec2 = code === 'EN1992-1-1';
  const fc  = ec2 ? 30 * PSI_PER_MPA : 4000;
  const fy  = ec2 ? 500 * PSI_PER_MPA : 60000;
  const cov = ec2 ? 30 / 25.4 : 1.5;
  return {
    units: ec2 ? 'si' : 'imperial',
    fc, fy, fyt: fy,
    lambdaConcrete: 1.0,
    autoModuli: true,
    ...derivedModuli(fc, code),
    coverTop: cov, coverBottom: cov, coverSide: cov,
    crackWidthLimit: DEFAULT_CRACK_PARAMS.wLimitBot,   // 0.3 mm
    cotTheta: 2.5,
    displayScale: 1.0,
    ignoreTorsion: false,
  };
}

/**
 * Re-derive Es/Ec/Gc when the settings are in "auto" mode. Called after any
 * f'c or code change so the displayed moduli stay honest; a no-op once the
 * engineer has taken manual control of them.
 */
export function withDerivedModuli(s: ProjectSettings, code: DesignCode): ProjectSettings {
  return s.autoModuli ? { ...s, ...derivedModuli(s.fc, code) } : s;
}

/**
 * Settings inferred from an existing project — used to seed the dialog for
 * projects saved before it existed, and by migrateProject(). The first member
 * carries the materials and cover those projects were designed with, so it is
 * a truer starting point than the generic defaults.
 */
export function settingsFromProject(p: Project): ProjectSettings {
  const base = defaultSettings(p.code);
  const m = p.members?.[0];
  const crack = m?.crackParams;
  const s: ProjectSettings = {
    ...base,
    ...(m ? {
      fc: m.material.fc,
      fy: m.material.fy,
      fyt: m.material.fyt,
      lambdaConcrete: m.material.lambdaConcrete,
      Es: m.material.Es,
      coverTop: m.section.coverTop ?? m.section.coverClear,
      coverBottom: m.section.coverBottom ?? m.section.coverClear,
      coverSide: m.section.coverSide ?? m.section.coverClear,
    } : {}),
    ...(crack ? { crackWidthLimit: crack.wLimitBot } : {}),
    cotTheta: p.cotTheta ?? base.cotTheta,
    ignoreTorsion: p.ignoreTorsion ?? base.ignoreTorsion,
  };
  // An explicit member Ec/Gc means the engineer had already overridden them.
  if (m?.material.Ec) {
    return { ...s, autoModuli: false, Ec: m.material.Ec, Gc: m.material.Gc ?? autoGc(m.material.Ec) };
  }
  return withDerivedModuli(s, p.code);
}

/** Material block a member gets from the project standards. */
export function materialFromSettings(s: ProjectSettings): Member['material'] {
  return {
    fc: s.fc, fy: s.fy, fyt: s.fyt,
    Es: s.Es, lambdaConcrete: s.lambdaConcrete,
    Ec: s.Ec, Gc: s.Gc,
  };
}

/**
 * The cover fields a member's section gets from the project standards.
 *
 * `coverClear` is kept in step as the LARGEST of the three. It is the fallback
 * for anything not face-aware — column geometry, section drawings, the .SCO
 * writers — and in every one of those the larger cover is the conservative
 * choice: it gives the smaller effective depth, the smaller torsion Aoh and the
 * smaller clear width for bar fit.
 */
export function coversFromSettings(s: ProjectSettings) {
  return {
    coverTop: s.coverTop,
    coverBottom: s.coverBottom,
    coverSide: s.coverSide,
    coverClear: Math.max(s.coverTop, s.coverBottom, s.coverSide),
  };
}

/**
 * Write the standards onto the project and every member in it — the operation
 * behind "these changes are reflected everywhere". Materials, per-face cover
 * and (under EC2) the crack-width limit are overwritten on all members; each
 * member's own geometry, rebar, loads and any other crack parameters they have
 * tuned are left untouched.
 */
export function applyProjectSettings(project: Project, settings: ProjectSettings): Project {
  const s = withDerivedModuli(settings, project.code);
  const material = materialFromSettings(s);
  const covers = coversFromSettings(s);
  const w = s.crackWidthLimit;

  const members = project.members.map(m => ({
    ...m,
    material: { ...m.material, ...material },
    section: { ...m.section, ...covers },
    crackParams: {
      ...(m.crackParams ?? DEFAULT_CRACK_PARAMS),
      wLimitTop: w, wLimitBot: w, wLimitFace: w,
    },
  }));

  return {
    ...project,
    settings: s,
    members,
    cotTheta: s.cotTheta,
    ignoreTorsion: s.ignoreTorsion,
  };
}

// ── Remembered standards (across sessions) ───────────────────────────────────

/** localStorage key holding the last standards the engineer confirmed. Its
 *  ABSENCE is what makes the setup dialog appear on first launch. */
export const STANDARDS_STORAGE_KEY = 'sc-project-standards';

export interface StoredStandards { code: DesignCode; settings: ProjectSettings }

/**
 * The standards from the last setup/settings save, or null on a first run.
 * Anything malformed (hand-edited storage, a schema change) reads as null so a
 * broken value re-runs setup rather than poisoning a project.
 */
export function loadStandards(): StoredStandards | null {
  try {
    const raw = localStorage.getItem(STANDARDS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredStandards>;
    if (!parsed?.settings || typeof parsed.settings.fc !== 'number' || !parsed.code) return null;
    // Merge over the code's defaults so standards saved by an older build gain
    // any field added since instead of arriving undefined.
    return { code: parsed.code, settings: { ...defaultSettings(parsed.code), ...parsed.settings } };
  } catch {
    return null;
  }
}

export function saveStandards(code: DesignCode, settings: ProjectSettings): void {
  try {
    localStorage.setItem(STANDARDS_STORAGE_KEY, JSON.stringify({ code, settings }));
  } catch { /* private mode / quota — the project still carries its own settings */ }
}

/** True until the engineer has completed setup once on this machine. */
export function needsSetup(): boolean {
  return loadStandards() === null;
}
