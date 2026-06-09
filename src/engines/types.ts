/**
 * DesignEngine interface — the contract every member-type engine must satisfy.
 *
 * Adding a new engine (e.g. column):
 *  1. Create src/engines/column/index.ts
 *  2. Implement DesignEngine<ColumnSection, ColumnRebar, ColumnLoadCase, ColumnResults>
 *  3. Call engineRegistry.register(new ColumnDesignEngine()) in src/engines/index.ts
 */

import type { MaterialProps, BaseLoadCase, BaseDesignResults } from '../types/common';

export interface DesignEngine<
  TSection,
  TRebar,
  TLoad extends BaseLoadCase,
  TResults extends BaseDesignResults,
> {
  /** Matches Member.memberType — used by the registry for lookup. */
  readonly memberType: string;

  /** ACI (or other) code editions this engine supports. */
  readonly supportedCodes: string[];

  /**
   * Run all ACI checks for a single load case.
   * Called once per load case; the registry loops over all load cases.
   */
  design(
    section: TSection,
    material: MaterialProps,
    rebar: TRebar,
    load: TLoad,
    code?: string,
  ): TResults;

  /** Returns true if this engine handles the given section type string. */
  canHandle(sectionType: string): boolean;
}
