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

export class BeamDesignEngine
  implements DesignEngine<BeamSection, BeamRebar, BeamLoadCase, BeamResults>
{
  readonly memberType = 'beam' as const;
  readonly supportedCodes = ['ACI318-19', 'ACI318-14'];

  design(
    section: BeamSection,
    material: MaterialProps,
    rebar: BeamRebar,
    load: BeamLoadCase,
  ): BeamResults {
    return designMember(section, material, rebar, load);
  }

  canHandle(sectionType: string): boolean {
    return ['rectangular_beam', 'T_beam', 'L_beam'].includes(sectionType);
  }
}
