/**
 * Column design engine — ACI 318-19 and EN 1992-1-1 short-column checks
 * behind the DesignEngine interface.
 */

import type { DesignEngine } from '../types';
import type { SectionDimensions, RebarLayout, LoadCase, DesignResults } from '../../types';
import type { MaterialProps } from '../../types/common';
import { designColumnACI } from '../aci/aciColumn';
import { designColumnEC2 } from '../ec2/ec2Column';

export class ColumnDesignEngine
  implements DesignEngine<SectionDimensions, RebarLayout, LoadCase, DesignResults>
{
  readonly memberType = 'column' as const;
  readonly supportedCodes = ['ACI318-19', 'ACI318-14', 'EN1992-1-1'];

  design(
    section: SectionDimensions,
    material: MaterialProps,
    rebar: RebarLayout,
    load: LoadCase,
    code?: string,
  ): DesignResults {
    if (code === 'EN1992-1-1') {
      return designColumnEC2(section, material, rebar, load);
    }
    return designColumnACI(section, material, rebar, load);
  }

  canHandle(sectionType: string): boolean {
    return sectionType.endsWith('_column');
  }
}
