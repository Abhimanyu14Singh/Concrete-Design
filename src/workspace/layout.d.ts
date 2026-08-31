/**
 * Type surface for the workspace layout store. Only the test imports this from TS —
 * every real consumer is `.jsx` — so it stays deliberately loose about the shape of a
 * layout and precise about the handful of fields typed code actually asserts on.
 */

/** The persisted per-machine workspace preferences. Open: fields are added often, and
 *  an unknown one must survive load → save rather than be typed away. */
export interface Layout {
  /** Which colour scheme the Model view is on. 'none' until one is chosen. */
  planColorMode: string;
  [key: string]: unknown;
}

/** Read the layout out of localStorage, sanitising and migrating as it goes. Never
 *  throws — corrupt or unavailable storage falls back to the defaults. */
export declare function loadLayout(): Layout;

export declare function saveLayout(state: Layout | Record<string, unknown>): void;

export declare function clearLayout(): void;

export declare const DEFAULT_LAYOUT: Layout;
