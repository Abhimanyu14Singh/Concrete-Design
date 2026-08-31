/**
 * Type surface for the popout bus — only the parts the TypeScript shell touches.
 *
 * `main.tsx` needs to know which role a window is in before it mounts anything, and that
 * question is answered by the URL. Most of the bus (the BroadcastChannel, cloneable) is
 * consumed by `.jsx` inside the workspace and does not need to cross into typed code, so
 * it is deliberately not declared here — a declaration file that lists everything is a
 * second copy of the module to keep in sync.
 *
 * The panel REGISTRY is declared, though: `popoutComponents.test.ts` reads it to check
 * that every detachable panel can actually mount in a window, which is a check worth
 * having in typed code (S-Concrete shipped detachable-but-unmountable without it).
 */

/** The WINDOW id in `?popout=<winId>`, or null when this is not a detached window.
 *  A detached window is a container — it asks the bus which panels it holds. */
export declare function popoutWinId(): string | null;

/** @deprecated The URL parameter names a window now — use `popoutWinId`. */
export declare function popoutKind(): string | null;

/** Whether this window was opened as a detached panel. `popoutKind() !== null`. */
export declare function isPopoutWindow(): boolean;

/** What each detachable panel is called, and which callbacks may cross the bus. */
export declare const PANELS: Record<string, { title: string; fns?: string[]; reqs?: string[] }>;

/** Panel kinds in rail order. Every one needs a `Popout.COMPONENTS` entry. */
export declare const PANEL_ORDER: string[];
