/**
 * Engine barrel — imports all engines, registers them, and re-exports
 * the public registry API.
 *
 * To add a new engine: import it and call registerEngine(new XDesignEngine()).
 */

export { registerEngine, getEngine, listEngines } from './registry';
export type { DesignEngine } from './types';

import { registerEngine } from './registry';
import { BeamDesignEngine } from './beam';
import { designMember } from '../utils/concreteDesign';
import { designMemberEC2 } from './ec2/ec2Beam';
import type {
  MaterialProps, SectionDimensions, RebarLayout, LoadCase, DesignResults, DesignCode,
  CrackControlParams,
} from '../types';

// Register all available engines at module load time
registerEngine(new BeamDesignEngine());

/**
 * The load row as the engine will ACTUALLY see it under the project's preferences.
 *
 * "Neglect torsion" zeroes Tu before the beam engines see it, so every torsion /
 * shear+torsion check (DCR_torsion, VT_util combined links, §6.3.1/§6.3.2(3)
 * longitudinal steel, §9.2.3(2) closed-link spacing) collapses to a no-op — no engine
 * branch needed. The user's Tu data is preserved on the load itself and is never lost.
 *
 * Exported because ANYTHING THAT DISPLAYS A DEMAND has to apply the same rule. The Excel
 * and PDF reports print "Torsion — Neglected (Tu = 0)" in their standards block; a
 * demands table beside it still showing Tu = 40 kip-ft contradicts the sheet it is on.
 * The Calc Sheet generators are called directly rather than through `runDesign`, so they
 * need it too.
 */
export function effectiveLoad(load: LoadCase, ignoreTorsion?: boolean): LoadCase {
  return ignoreTorsion && load.Tu ? { ...load, Tu: 0 } : load;
}

/**
 * Code-aware design dispatcher — the single entry point the whole app designs through.
 * Defaults to ACI when code is missing so projects saved before the code selector
 * existed keep producing identical results.
 *
 * Note this calls the beam engines DIRECTLY rather than going through the registry.
 * The registry exists for the generic member-type contract; `runDesign` is the concrete
 * beam path, and it carries the extra project-level arguments (span, crack params,
 * cot θ, torsion and biaxial settings) that the generic `design()` signature has no
 * place for. Both remain valid — the registry is what a second member type would use.
 */
export function runDesign(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
  span = 20,
  code?: DesignCode | string,
  crack?: CrackControlParams,
  cotTheta?: number,   // EC2 §6.2.3 strut angle (default 2.5); ignored for ACI
  ignoreTorsion?: boolean, // project "neglect torsion" setting — Tu is dropped to 0
  biaxialAlpha?: number,   // Bresler contour exponent; 1.0 = linear/conservative
): DesignResults {
  const beamLoad = effectiveLoad(load, ignoreTorsion);
  if (code === 'EN1992-1-1') {
    return designMemberEC2(section, material, rebar, beamLoad, span, crack, cotTheta ?? 2.5);
  }
  return designMember(section, material, rebar, beamLoad, span, biaxialAlpha);
}
