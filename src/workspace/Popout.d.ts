/**
 * Type surface for the detached-panel root.
 *
 * Same reason as WorkspaceView.d.ts: the workspace came across from the demo as plain
 * JS and `allowJs` is off, so tsc sees nothing of `Popout.jsx`. This declaration is the
 * contract `main.tsx` is held to — one prop, the panel it was asked to show.
 *
 * `winId` is a WINDOW id (`w1`, `w2`, …), not a panel kind — a detached window is a
 * container that may hold several panels and asks the bus which ones. It arrives off a
 * URL and so is typed as the string it actually is; an id the main window does not
 * recognise resolves to a waiting notice rather than throwing, which is the right
 * behaviour for a value a user can type into the address bar.
 */
declare const Popout: (props: { winId: string | null }) => JSX.Element;
export default Popout;

/**
 * Panel kind → the component a detached window mounts. Declared so
 * `popoutComponents.test.ts` can hold it against PANEL_ORDER: a kind that is
 * detachable but missing here opens a window reading "Unknown panel".
 */
export declare const COMPONENTS: Record<string, unknown>;
