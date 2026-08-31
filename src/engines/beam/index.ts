/**
 * Beam design engine — wraps the ACI 318-19 beam calculation functions
 * from utils/concreteDesign.ts behind the DesignEngine interface.
 *
 * The raw calculation functions remain in concreteDesign.ts so they can be
 * unit-tested and called directly from calcBreakdown.ts.
 */

import type { DesignEngine } from '../types';
import type { BeamSection, BeamRebar, BeamLoadCase, BeamResults } from '../../types/beam';
import type { MaterialProps } from '../../types/common';
import { designMember } from '../../utils/concreteDesign';
import { designMemberEC2 } from '../ec2/ec2Beam';

/** The registry's `'beam'` engine: dispatches to the EC2 or ACI implementation by code. */
export class BeamDesignEngine
  implements DesignEngine<BeamSection, BeamRebar, BeamLoadCase, BeamResults>
{
  readonly memberType = 'beam' as const;
  readonly supportedCodes = ['ACI318-19', 'EN1992-1-1'];

  /** Design one load case. Anything that isn't EN1992-1-1 runs the ACI engine, so a
   *  project with no code set behaves exactly as it did before codes were selectable. */
  design(
    section: BeamSection,
    material: MaterialProps,
    rebar: BeamRebar,
    load: BeamLoadCase,
    code?: string,
  ): BeamResults {
    if (code === 'EN1992-1-1') {
      return designMemberEC2(section, material, rebar, load);
    }
    return designMember(section, material, rebar, load);
  }

  /** Section types this engine covers. Column sections are deliberately absent. */
  canHandle(sectionType: string): boolean {
    return ['rectangular_beam', 'T_beam', 'L_beam'].includes(sectionType);
  }
}
