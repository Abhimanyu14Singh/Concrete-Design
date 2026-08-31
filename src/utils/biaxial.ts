/**
 * Biaxial bending — the Bresler load-contour check (ACI 318-19 R22.4.2.1 / PCA).
 *
 *     (|Mux| / φMnx)^α + (|Muy| / φMny)^α  ≤  1.0
 *
 * φMnx and φMny are the UNIAXIAL design capacities about each axis, evaluated at
 * the applied Pu — so this reuses beamAxialFlexure/computeFlexure rather than
 * re-deriving anything. That matters: those are the routines already checked
 * against S-CONCRETE, so the biaxial answer inherits a verified φ-surface instead
 * of introducing a second, unverified one.
 *
 * ── What this method is, and is not ──────────────────────────────────────────
 * It is an INTERACTION CONTOUR, not a section analysis. The rigorous answer tilts
 * the neutral axis to the resultant-moment angle θ = atan2(Muy, Mux) and
 * re-integrates the section — which is what S-CONCRETE does, and why it reports
 * `Mres` and `Theta`. Bresler instead interpolates between the two uniaxial
 * capacities. Expect agreement to a few percent on ordinary sections and a
 * conservative answer at α = 1.0; do not expect it to reproduce S-CONCRETE's
 * `N vs M Util` digit for digit.
 *
 * α is the contour exponent:
 *   1.0        a straight line between the two axes — always conservative, and
 *              the right default for a tool that must not flatter a section.
 *   1.15–1.5   the PCA range for rectangular sections with symmetric steel; the
 *              contour bulges outward and the check gets less conservative as α
 *              rises. 1.5 is the usual upper bound.
 * It is a project setting rather than a constant because the safe value depends
 * on how much axial load is present and how the steel is distributed, which is
 * an engineer's call, not this file's.
 *
 * ── Minor-axis steel ─────────────────────────────────────────────────────────
 * A beam's bars are laid out for MAJOR-axis bending: rows near the top and bottom
 * faces. Bending about the minor axis compresses one SIDE face, so the relevant
 * steel is what sits near each side — which for a normal cage (bars spread across
 * the width in each row) is roughly half the total longitudinal steel on each
 * side. That is the assumption here, stated plainly because it is an assumption:
 * the exact minor-axis capacity depends on where each bar sits across the width,
 * which the BarGroup model does not record.
 *
 * The pairing is deliberate — an approximate contour fed by an approximate
 * minor-axis capacity. Both err the same way, and neither pretends to be the
 * inclined-neutral-axis solution.
 */
import type { SectionDimensions, MaterialProps, RebarLayout, LoadCase } from '../types';
import { computeFlexure, getBarArea } from './concreteDesign';
import { beamAxialFlexure } from './axialFlexure';

/** Default contour exponent. 1.0 = linear, the conservative floor. */
export const DEFAULT_BIAXIAL_ALPHA = 1.0;

/** Bresler load-contour check result, carrying both capacities and the exponent used, so
 *  the Calc Sheet can reproduce the utilisation rather than restate it. */
export interface BiaxialResult {
  /** Applied moments (kip-ft), as supplied. */
  Mux: number;
  Muy: number;
  /** Design capacity about each axis at the applied Pu (kip-ft). */
  phiMnx: number;
  phiMny: number;
  /** The contour exponent actually used. */
  alpha: number;
  /** (|Mux|/φMnx)^α + (|Muy|/φMny)^α — governs when > 1. */
  util: number;
  /** Resultant moment and its angle from the major axis (kip-ft, degrees).
   *  Reported for comparison with tools that work in Mres/θ; not used by the check. */
  Mres: number;
  theta: number;
  /** Total longitudinal steel assumed available, and the half taken per side face. */
  AsTotal: number;
  AsPerSide: number;
}

const areaOf = (groups?: { numBars: number; barSize: number }[]) =>
  (groups ?? []).reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);

/**
 * Run the biaxial contour check. Returns undefined when there is no minor-axis
 * moment — a uniaxially-loaded member must not pick up a second utilisation out
 * of nowhere, and every beam in a normal model is that case.
 */
export function biaxialCheck(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
  span = 20,
  alpha: number = DEFAULT_BIAXIAL_ALPHA,
): BiaxialResult | undefined {
  const Muy = load.Muy ?? 0;
  // Mux falls back to the major-axis moment the beam is already checked for, so a
  // member given only Muy still gets a meaningful contour rather than dividing by
  // a zero capacity.
  const Mux = load.Mux ?? Math.max(Math.abs(load.Mu_pos), Math.abs(load.Mu_neg));
  if (Math.abs(Muy) < 1e-9) return undefined;

  const b = section.b;
  const h = section.h ?? 12;
  const Pu = load.Pu ?? 0;

  // ── Major axis: exactly what the uniaxial check already computed ────────────
  const As_top = areaOf(rebar.topBars);
  const As_bot = areaOf(rebar.botBars);
  const flexX = computeFlexure(
    section, material, As_top, As_bot, span,
    rebar.topBars?.[0]?.barSize ?? 8, rebar.botBars?.[0]?.barSize ?? 8,
    rebar.topBars, rebar.botBars, rebar.layerClearSpacing ?? 1.0,
  );
  // Which sense the major-axis moment engages: sagging uses the bottom steel.
  const senseX: 'pos' | 'neg' = Mux >= 0 ? 'pos' : 'neg';
  const phiMn0x = senseX === 'pos' ? flexX.phi_Mn_pos : flexX.phi_Mn_neg;
  const phiMnx = Pu !== 0
    ? beamAxialFlexure(section, material, rebar, span, senseX, phiMn0x, Pu, Math.abs(Mux)).phiMnAtPu
    : phiMn0x;

  // ── Minor axis: the section on its side, steel split between the side faces ──
  const rotated: SectionDimensions = { ...section, type: 'rectangular_beam', b: h, h: b, bw: undefined, hf: undefined };
  const AsTotal = As_top + As_bot;
  const AsPerSide = AsTotal / 2;
  const sideBarSize = rebar.botBars?.[0]?.barSize ?? rebar.topBars?.[0]?.barSize ?? 8;
  const sideGroups = [{ numBars: Math.max(1, Math.round(AsPerSide / getBarArea(sideBarSize))), barSize: sideBarSize }];
  const flexY = computeFlexure(
    rotated, material, AsPerSide, AsPerSide, span,
    sideBarSize, sideBarSize, sideGroups, sideGroups, rebar.layerClearSpacing ?? 1.0,
  );
  const phiMn0y = flexY.phi_Mn_pos;
  const rotatedRebar: RebarLayout = { ...rebar, topBars: sideGroups, botBars: sideGroups };
  const phiMny = Pu !== 0
    ? beamAxialFlexure(rotated, material, rotatedRebar, span, 'pos', phiMn0y, Pu, Math.abs(Muy)).phiMnAtPu
    : phiMn0y;

  const a = Math.max(1, alpha);   // below 1.0 the contour turns concave — not a real design curve
  const rx = phiMnx > 0 ? Math.abs(Mux) / phiMnx : 0;
  const ry = phiMny > 0 ? Math.abs(Muy) / phiMny : 0;
  const util = Math.pow(rx, a) + Math.pow(ry, a);

  return {
    Mux, Muy, phiMnx, phiMny, alpha: a, util,
    Mres: Math.hypot(Mux, Muy),
    theta: (Math.atan2(Muy, Mux) * 180) / Math.PI,
    AsTotal, AsPerSide,
  };
}
