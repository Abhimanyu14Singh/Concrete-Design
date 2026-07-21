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
import { ColumnDesignEngine } from './column';
import { designMember } from '../utils/concreteDesign';
import { designMemberEC2 } from './ec2/ec2Beam';
import { designColumnACI } from './aci/aciColumn';
import { designColumnEC2 } from './ec2/ec2Column';
import type {
  MaterialProps, SectionDimensions, RebarLayout, LoadCase, DesignResults, DesignCode,
  CrackControlParams,
} from '../types';

// Register all available engines at module load time
registerEngine(new BeamDesignEngine());
registerEngine(new ColumnDesignEngine());

/**
 * Code-aware design dispatcher. Column section types route to the column
 * engines; everything else to the beam engines. Defaults to ACI when code is
 * missing so projects saved before this feature keep producing identical
 * results.
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
): DesignResults {
  const isColumn = section.type === 'rectangular_column' || section.type === 'circular_column';
  if (isColumn) {
    return code === 'EN1992-1-1'
      ? designColumnEC2(section, material, rebar, load)
      : designColumnACI(section, material, rebar, load, span);
  }
  // "Neglect torsion": zero Tu before the beam engines see it, so every torsion /
  // shear+torsion check (DCR_torsion, VT_util combined links, §6.3.1/§6.3.2(3)
  // longitudinal steel, §9.2.3(2) closed-link spacing) collapses to a no-op —
  // no engine branch needed. The user's Tu data is preserved on the load itself.
  const beamLoad = ignoreTorsion && load.Tu ? { ...load, Tu: 0 } : load;
  if (code === 'EN1992-1-1') {
    return designMemberEC2(section, material, rebar, beamLoad, span, crack, cotTheta ?? 2.5);
  }
  return designMember(section, material, rebar, beamLoad, span);
}
