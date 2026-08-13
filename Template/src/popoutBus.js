// Bus between the main window and its popped-out panels.
//
// On the DESKTOP a panel is a real OS window, so it can be dragged onto another
// monitor; in a browser it stays the in-app floating panel, because a tab cannot own
// a window. Same components either way — only where they are mounted changes.
//
// The main window still computes everything exactly as before (diagram, section,
// axial, log …). It simply stops rendering the panel locally and posts its PROPS
// instead; the popout renders them. Callbacks travel the other way as {t:"call"} and
// are run by the main window, so edits, requests and closes all keep happening in the
// one place that owns the state. Nothing is duplicated and nothing goes through the
// Electron main process.
//
// BroadcastChannel structured-clones, so Maps, Sets and nested objects survive as-is —
// but FUNCTIONS do not. Props must therefore be plain data; anything callable is
// declared as a handler name and proxied.
export const CHANNEL = "sdash";

export function openChannel() {
  try { return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL); }
  catch (e) { return null; }
}

// The panels that can own a window, and the callbacks each one needs proxied back.
// Titles are what the OS window is called.
export const PANELS = {
  // Every panel that may own a window, and what has to travel back to the main window
  // for it to work there.
  //
  //   fns  — fire and forget. Posted to the main window and run there; nothing returns.
  //   reqs — must ANSWER. The call goes over a request/reply pair because the caller
  //          needs the return value (a context menu's items, say).
  //
  // Anything a panel calls that is not listed here arrives undefined, so guard optional
  // handlers at the call site rather than assuming they are present.
  chart: { title: "Chart", fns: ["onClose", "onPick"], reqs: ["menuItemsFor"] },
  notes: { title: "Notes", fns: ["onClose", "onChange"] },
};

export const isPopoutWindow = () => {
  try { return !!new URLSearchParams(window.location.search).get("popout"); }
  catch (e) { return false; }
};

export const popoutKind = () => {
  try { return new URLSearchParams(window.location.search).get("popout"); }
  catch (e) { return null; }
};

// Only the desktop shell can give a panel its own window.
export const isDesktop = () =>
  typeof window !== "undefined" && !!(window.desktop && window.desktop.isDesktop);

// Strip anything structured-clone would choke on, so one unserialisable prop cannot
// silently kill the whole message.
//
// This has to go all the way down. The shallow version it replaces only dropped
// functions sitting directly on the props object, and the prop that actually broke
// every panel was `u` — an OBJECT whose values are formatters. Shallow, it looked
// perfectly cloneable; postMessage disagreed and threw, and the panels it killed
// showed "Loading…" with nothing logged.
//
// Maps, Sets, Dates and typed arrays clone natively and are passed through whole —
// walking into them would rebuild them as plain objects and change what panels get.
export function cloneable(v, seen) {
  if (v === null || typeof v !== "object") {
    return (typeof v === "function" || typeof v === "symbol") ? undefined : v;
  }
  if (v instanceof Map || v instanceof Set || v instanceof Date || ArrayBuffer.isView(v)) return v;
  seen = seen || new WeakSet();
  if (seen.has(v)) return undefined;             // cycles cannot be posted either
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => cloneable(x, seen));
  const out = {};
  for (const k of Object.keys(v)) {
    const c = cloneable(v[k], seen);
    if (c !== undefined) out[k] = c;
  }
  return out;
}
