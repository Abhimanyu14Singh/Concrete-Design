/**
 * Type surface for the multi-window docking model — the state shape a panel's location
 * is expressed in, and the pure operations that move panels between windows.
 */

import type { DockLayout, DropTarget } from './dockLayout';

/** Where a panel lives. `null` = closed. */
export type HostKind = 'dock' | 'float' | 'window' | null;

/** A window id (`w1`, `w2`, …), or `dock` for the main workspace. */
export type WinId = string;

/**
 * Everything that says where the panels are.
 *
 * `winOf` is only meaningful for a kind whose `hosts` entry is `'window'`; `prune`
 * enforces that, so the two can never disagree about whether a panel is detached.
 */
export interface DockState {
  hosts: Record<string, HostKind>;
  winOf: Record<string, WinId>;
  winDock: Record<WinId, DockLayout>;
  dock: DockLayout | null;
  [extra: string]: unknown;
}

/** Screen-space rectangle of one dockable window, as reported by the shell. */
export interface WinBounds { id: WinId; x: number; y: number; w: number; h: number }

/** The main workspace, addressed as if it were a window. */
export declare const DOCK: 'dock';

export declare function windowIds(hosts: Record<string, HostKind>, winOf: Record<string, WinId>): WinId[];
export declare function panelsInWindow(hosts: Record<string, HostKind>, winOf: Record<string, WinId>, winId: WinId): string[];
export declare function newWinId(hosts: Record<string, HostKind>, winOf: Record<string, WinId>): WinId;
export declare function windowLabel(winId: WinId): string;
export declare function movePanelToWindow(state: DockState, kind: string, winId: WinId, target?: DropTarget | null): DockState;
export declare function detachToNewWindow(state: DockState, kind: string, winId?: WinId): { state: DockState; winId: WinId };
/** Move every panel from window `from` into `to` (which may be DOCK), emptying `from`. */
export declare function mergeWindows(state: DockState, from: WinId, to: WinId): DockState;
/** Close a window and every panel in it — panels end up closed, not re-homed. */
export declare function closeWindowPanels(state: DockState, winId: WinId): DockState;
export declare function prune(state: DockState): DockState;
export declare function hitTestWindows(list: WinBounds[] | null | undefined, screenX: number, screenY: number, selfId: WinId | null): WinId | null;
export declare function isWinOf(v: unknown): boolean;
