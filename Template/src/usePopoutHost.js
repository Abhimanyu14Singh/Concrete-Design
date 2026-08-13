import { useEffect, useRef } from "react";
import { openChannel, PANELS, isDesktop, cloneable } from "./popoutBus.js";

// Post, and say so when it fails. postMessage throws DataCloneError on anything it
// cannot serialise, and both sites used to swallow that — so a panel whose props
// carried one function never received anything and sat on "Loading…" with an empty
// log. cloneable() should now prevent it; if it ever throws again, it says which
// panel and why rather than leaving a window to hang in silence.
function post(ch, kind, props) {
  try {
    ch.postMessage({ t: "props", kind, props: cloneable(props) });
  } catch (err) {
    // Never silent. A prop that will not clone leaves the panel with nothing and looks
    // exactly like a window that is still loading, so say which panel and why. Point
    // this at your own logging when you have some — in a packaged app the renderer's
    // console is not reachable, which is the case this exists for.
    console.error(`popout ${kind}: props would not post -`, err && err.message);
  }
}

// Same keys, same identities — enough to tell "nothing moved" from "repaint me".
function shallowSame(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

// The main window's half of the popout bus.
//
// For each panel it decides WHERE the panel mounts — its own OS window on the desktop,
// docked in the page in a browser — then keeps a hosted panel fed with props and runs
// the callbacks it sends back. The state never leaves this window; only a snapshot of
// the props goes out, and every handler still runs here.
//
// Usage from the component:
//     const popHost = usePopoutHost();
//     const showDocked = popHost.publish("plan", planOpen, props, fns) && ...
export default function usePopoutHost() {
  const desktop = isDesktop();
  const chRef = useRef(null);
  const live = useRef(new Map());     // kind -> { props, fns, open }
  const opened = useRef(new Set());   // kinds whose OS window we have asked for
  const sent = useRef(new Map());     // last props posted per kind
  const held = useRef(new Map());     // kind -> menu items a popout is choosing from

  useEffect(() => {
    if (!desktop) return undefined;
    const ch = openChannel();
    chRef.current = ch;
    if (!ch) return undefined;
    ch.onmessage = (e) => {
      const m = e && e.data;
      if (!m || !m.kind) return;
      const rec = live.current.get(m.kind);
      // a window that has just opened wants the props it missed
      if (m.t === "hello" && rec && rec.open) {
        sent.current.set(m.kind, rec.props);
        post(ch, m.kind, rec.props);
      } else if (m.t === "call" && rec) {
        const fn = rec.fns && rec.fns[m.fn];
        if (typeof fn === "function") fn(...(m.args || []));
      } else if (m.t === "req" && rec) {
        // A call that has to answer. Only the labels can travel: each menu item carries
        // an `on` closure over this window's state, which will not clone and would not
        // mean anything over there anyway. So the items are KEPT here and the popout is
        // sent their labels; it replies with the index it wants and "invoke" runs the
        // closure, still in this window, exactly as a docked click would.
        const fn = rec.fns && rec.fns[m.fn];
        let items = [];
        try { items = (typeof fn === "function" ? fn(...(m.args || [])) : null) || []; }
        catch (err) { items = []; }
        // One menu is open at a time, so the last request per panel is all to hold —
        // no ids to reap and nothing to grow.
        held.current.set(m.kind, items);
        try {
          ch.postMessage({ t: "res", kind: m.kind, id: m.id,
                           items: items.map((it) => ({ label: it.label,
                                                       disabled: !!it.disabled,
                                                       sep: !!it.sep })) });
        } catch (err) { /* the popout times its request out */ }
      } else if (m.t === "invoke") {
        const it = (held.current.get(m.kind) || [])[m.index];
        if (it && !it.disabled && typeof it.on === "function") it.on();
      } else if (m.t === "closed") {
        // the OS window went away — untick the panel so its toolbar button agrees
        opened.current.delete(m.kind);
        if (rec && rec.fns && typeof rec.fns.onClose === "function") rec.fns.onClose();
      }
    };
    return () => { ch.close(); chRef.current = null; };
  }, [desktop]);

  // close every panel window when the app page goes away
  useEffect(() => {
    if (!desktop) return undefined;
    const bye = () => {
      const ch = chRef.current; if (!ch) return;
      for (const kind of opened.current) { try { ch.postMessage({ t: "close", kind }); } catch (e) {} }
    };
    window.addEventListener("pagehide", bye);
    return () => window.removeEventListener("pagehide", bye);
  }, [desktop]);

  return {
    // Record a panel's current props/handlers and, on the desktop, keep its window in
    // step with `open`. Returns true when the caller should still render it in-page.
    publish(kind, open, props, fns) {
      if (!desktop) return !!open;
      live.current.set(kind, { props, fns, open: !!open });
      const ch = chRef.current;
      if (open) {
        if (!opened.current.has(kind)) {
          opened.current.add(kind);
          const title = (PANELS[kind] || {}).title || "S-DASH";
          if (window.desktop && window.desktop.popout) window.desktop.popout(kind, title);
          sent.current.delete(kind);      // a new window needs the first payload
        }
        // Only post when something actually changed. publish() runs on every render of
        // the main window — a keystroke would otherwise broadcast all eight panels,
        // and the Section payload is not small. Shallow compare is enough: these props
        // are rebuilt by useMemo, so an unchanged panel keeps its identities.
        if (ch && !shallowSame(sent.current.get(kind), props)) {
          sent.current.set(kind, props);
          post(ch, kind, props);
        }
      } else if (opened.current.has(kind)) {
        sent.current.delete(kind);
        opened.current.delete(kind);
        if (ch) { try { ch.postMessage({ t: "close", kind }); } catch (e) {} }
      }
      return false;                    // hosted out of process — never render in-page
    },
    docked(open) { return !desktop && !!open; },
  };
}
