/**
 * ModelAdapter interface — the contract every import source must satisfy.
 *
 * A ModelAdapter converts a foreign data format (ETABS XML, RAM JSON,
 * spreadsheet, etc.) into the application's Project structure.
 *
 * Adding a new adapter (e.g. RAM Structural System):
 *  1. Create src/adapters/ram/index.ts
 *  2. Implement ModelAdapter
 *  3. Register it in src/adapters/index.ts
 */

import type { Project } from '../types';

export interface ModelAdapter {
  /** Display name shown in the import dialog. */
  readonly name: string;

  /** Short description of what file formats are accepted. */
  readonly description: string;

  /**
   * Attempt to parse `data` (file contents as string or object) into a Project.
   * Throws with a user-readable message if the data is malformed.
   */
  importProject(data: unknown): Promise<Project>;

  /**
   * Quick heuristic check — returns true if this adapter is likely able to
   * handle the given data (used to auto-detect the right adapter).
   */
  canImport(data: unknown): boolean;
}
