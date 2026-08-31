import React, { useEffect, useRef, useState } from "react";
import ChartPanel from "./ChartPanel.jsx";
import NotesPanel from "./NotesPanel.jsx";
import { openChannel, PANELS } from "./popoutBus.js";

// One panel, in its own OS window.
//
// It renders the SAME component the docked panel does, so the two can never drift.
// The props arrive from the main window over the bus — that window still owns all the
// state and does all the computing — and every callback is proxied straight back to
// it, so an edit made here is applied by the same handler as an edit made there.
const COMPONENTS = { chart: ChartPanel, notes: NotesPanel };

export default function Popout({ kind }) {
  const [props, setProps] = useState(null);
  const [menu, setMenu] = useState(null);      // this window's own context menu
  const chRef = useRef(null);
  const waiting = useRef(new Map());           // request id -> resolve
  const nextId = useRef(0);

  useEffect(() => {
    const ch = openChannel();
    chRef.current = ch;
    if (!ch) return undefined;
    ch.onmessage = (e) => {
      const m = e && e.data;
      if (!m || m.kind !== kind) return;
      if (m.t === "props") setProps(m.props || {});
      else if (m.t === "res") {
        const settle = waiting.current.get(m.id);
        if (settle) { waiting.current.delete(m.id); settle(m.items || []); }
      }
      // the main window closed the panel from its own toolbar
      else if (m.t === "close") window.close();
    };
    // A window opened just now has missed every update so far; ask for the current
    // props rather than sitting blank until something happens to change them.
    ch.postMessage({ t: "hello", kind });
    // Tell the main window to untick the panel when this window is closed by the OS,
    // or its toolbar button would still read as open.
    const bye = () => { try { ch.postMessage({ t: "closed", kind }); } catch (err) {} };
    window.addEventListener("pagehide", bye);
    return () => { window.removeEventListener("pagehide", bye); ch.close(); };
  }, [kind]);

  const Comp = COMPONENTS[kind];
  if (!Comp) return <div className="sdash-root sdash-popout"><div className="sdash-popout-wait">Unknown panel “{kind}”.</div></div>;
  if (!props) return <div className="sdash-root sdash-popout"><div className="sdash-popout-wait">Loading…</div></div>;

  // Callbacks run in the MAIN window — it owns the project, the selection and the
  // undo history. Closing is the one exception: shut this window immediately rather
  // than waiting for the round trip, so it feels like a window and not a web page.
  // Anything a panel needs that is a FUNCTION has to be rebuilt on this side —
  // structured clone rejects functions, so formatters, unit systems and the like
  // cannot be sent. Send the plain description (a name, a code) and remake it here
  // from the same factory the main window uses, so both hosts agree.

  const fns = {};
  for (const name of (PANELS[kind] || {}).fns || []) {
    fns[name] = (...args) => {
      const ch = chRef.current;
      if (ch) { try { ch.postMessage({ t: "call", kind, fn: name, args }); } catch (e) {} }
      if (name === "onClose") window.close();
    };
  }

  // Ask the main window something and wait for the answer. It resolves empty rather
  // than hanging if the channel is gone or the reply never comes: a right-click that
  // opens nothing is a poor menu, but a right-click that freezes the window is a bug.
  const request = (fn, args) => new Promise((resolve) => {
    const ch = chRef.current;
    if (!ch) return resolve([]);
    const id = ++nextId.current;
    waiting.current.set(id, resolve);
    try { ch.postMessage({ t: "req", kind, fn, args, id }); }
    catch (e) { waiting.current.delete(id); return resolve([]); }
    setTimeout(() => {
      if (waiting.current.has(id)) { waiting.current.delete(id); resolve([]); }
    }, 4000);
  });

  // The items arrive as labels only. Give each one back an `on` that names its index —
  // the closure it stands for stays in the main window and runs there.
  for (const name of (PANELS[kind] || {}).reqs || []) {
    fns[name] = (...args) => request(name, args).then((items) =>
      items.map((it, i) => ({ ...it, on: () => {
        const ch = chRef.current;
        if (ch) { try { ch.postMessage({ t: "invoke", kind, index: i }); } catch (e) {} }
      } })));
  }
  // Panels ask their host to open the menu; here, the host is this window.
  fns.openMenu = (x, y, items) => setMenu({ x, y, items: items || [] });
  // Same markup and classes as the main window's menu, so a popped-out panel's menu
  // looks and behaves like a docked one.
  return (
    <div className="sdash-root sdash-popout">
      <Comp {...props} {...fns} open />
      {menu && (
        <>
          <div className="sdash-menu-backdrop" onMouseDown={() => setMenu(null)}
               onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="sdash-menu" style={{ left: menu.x, top: menu.y }}
               onMouseDown={(e) => e.stopPropagation()}>
            {menu.items.map((it, i) => (
              it.sep
                ? <div key={i} className="sdash-menu-sep" />
                : <div key={i} className={"sdash-menu-item" + (it.disabled ? " disabled" : "")}
                       onClick={() => { if (!it.disabled) { it.on(); setMenu(null); } }}>{it.label}</div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
