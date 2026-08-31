/**
 * Type surface for the workspace's Export menu — only what typed code (its test)
 * touches. Same rule as `design.d.ts` and `popoutBus.d.ts`: a declaration file that
 * mirrors the whole module is a second copy to keep in step.
 */

import type { Project } from '../types';

/**
 * One row of a workspace menu — the shape `Menu.jsx` renders and the popout bus
 * carries.
 *
 * `on` is typed as ALWAYS PRESENT even though a separator has none. Every command row
 * the module builds carries one (disabled rows included — `disabled` greys the row, it
 * does not remove the handler), and every consumer drops separators before touching a
 * handler: `items.filter(i => !i.sep)`, or a `find` on `label`, which a separator has
 * none of either. Typing it optional would make each of those call sites carry a `!`
 * for a case they have already excluded, which is noise rather than safety.
 */
export interface MenuItem {
  /** True for a divider. A separator carries nothing else. */
  sep?: boolean;
  label?: string;
  /** Why the row is greyed, or what it does when it is not. */
  title?: string;
  /** Greyed, but still built and still carrying its handler. */
  disabled?: boolean;
  on: () => void | Promise<void>;
}

/**
 * Build the Export menu for the model currently on screen.
 *
 * `onOpenReport` opens the PDF Report dialog; `onNote` receives progress and failure
 * messages (and `null` to clear) — PDFs take a moment and can fail, and a menu item
 * that silently does nothing is indistinguishable from one that is broken.
 */
export declare function exportMenuItems(
  project: Project | null | undefined,
  handlers?: { onOpenReport?: () => void; onNote?: (message: string | null) => void },
): MenuItem[];
