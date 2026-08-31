/**
 * Type surface for the column layout — declared because typed code (the workspace tests,
 * and `windowDock`'s own surface) now reads it. Same rule as `popoutBus.d.ts`: only what
 * crosses into TypeScript is declared, so this does not become a second copy of the
 * module to keep in step.
 */

/** One panel's slot in a column: which panel, and its share of the column height. */
export interface DockItem { kind: string; h: number }
/** A column: its share of the workspace width, and the panels stacked in it. */
export interface DockCol { w: number; items: DockItem[] }
/** The whole arrangement — an ordered list of columns. */
export interface DockLayout { cols: DockCol[] }

/**
 * Where a dragged panel should land.
 *  `in`     — into column `ci`, at slot `ii`
 *  `newcol` — as a new column inserted at `ci`
 */
export type DropTarget =
  | { type: 'in'; ci: number; ii: number }
  | { type: 'newcol'; ci: number };

export declare function panelsOf(layout: DockLayout): string[];
export declare function findPanel(layout: DockLayout, kind: string): { ci: number; ii: number } | null;
export declare function removePanel(layout: DockLayout, kind: string): DockLayout;
export declare function placePanel(layout: DockLayout, kind: string, target: DropTarget | null): DockLayout;
export declare function resizeCols(layout: DockLayout, ci: number, frac: number): DockLayout;
export declare function resizeItems(layout: DockLayout, ci: number, ii: number, frac: number): DockLayout;
export declare function reconcile(layout: DockLayout, docked: string[]): DockLayout;
export declare function defaultLayout(docked: string[]): DockLayout;
export declare function isLayout(v: unknown): boolean;
