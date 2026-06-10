/**
 * Engine barrel — imports all engines, registers them, and re-exports
 * the public registry API.
 *
 * To add a new engine:
 *   import { ColumnDesignEngine } from './column';
 *   registerEngine(new ColumnDesignEngine());
 */

export { registerEngine, getEngine, listEngines } from './registry';
export type { DesignEngine } from './types';

import { registerEngine } from './registry';
import { BeamDesignEngine } from './beam';
import { designMember } from '../utils/concreteDesign';
import { designMemberEC2 } from './ec2/ec2Beam';
import type {
  MaterialProps, SectionDimensions, RebarLayout, LoadCase, DesignResults, DesignCode,
} from '../types';

// Register all available engines at module load time
registerEngine(new BeamDesignEngine());
// registerEngine(new ColumnDesignEngine());  // uncomment when implemented
// registerEngine(new WallDesignEngine());    // uncomment when implemented

/**
 * Code-aware design dispatcher. Routes to the EC2 engine for EN 1992-1-1,
 * otherwise the ACI engine. Defaults to ACI when code is missing so projects
 * saved before this feature keep producing identical results.
 */
export function runDesign(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
  span = 20,
  code?: DesignCode | string,
): DesignResults {
  if (code === 'EN1992-1-1') {
    return designMemberEC2(section, material, rebar, load, span);
  }
  return designMember(section, material, rebar, load, span);
}
