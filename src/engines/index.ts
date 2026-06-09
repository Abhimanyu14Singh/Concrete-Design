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

// Register all available engines at module load time
registerEngine(new BeamDesignEngine());
// registerEngine(new ColumnDesignEngine());  // uncomment when implemented
// registerEngine(new WallDesignEngine());    // uncomment when implemented
