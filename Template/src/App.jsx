import React, { useState } from "react";
import ChartPanel from "./ChartPanel.jsx";
import NotesPanel from "./NotesPanel.jsx";
import Portal from "./Portal.jsx";
import usePopoutHost from "./usePopoutHost.js";
import { Toggle, Range, ConfirmDialog } from "./primitives.jsx";
import { IconInteraction, IconLog } from "./icons.jsx";

const SERIES = [
  { label: "A", v: 42 }, { label: "B", v: 71 }, { label: "C", v: 28 },
  { label: "D", v: 95 }, { label: "E", v: 55 }, { label: "F", v: 12 },
];

// The main window. It owns ALL the state; panels are given props and hand back events.
// That is what lets the same component render inside the page or in its own OS window
// without knowing which — and it is worth keeping to even if you never pop anything out,
// because it is also what makes the panels testable.
export default function App() {
  const [chartOpen, setChartOpen] = useState(true);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [picked, setPicked] = useState(null);
  const [dense, setDense] = useState(false);
  const [lo, setLo] = useState(10);
  const [hi, setHi] = useState(90);
  const [confirm, setConfirm] = useState(false);
  const [menu, setMenu] = useState(null);       // {x, y, items}

  const openMenu = (x, y, items) => setMenu({ x, y, items });

  // Items are built HERE, with closures over this window's state. Popped out, only the
  // labels travel and the index comes back — see usePopoutHost. So a menu item does the
  // same thing wherever it was clicked, because it is the same item.
  const menuItemsFor = (target) => ([
    { label: target ? `Select ${target}` : "Select All",
      on: () => setPicked(target || "all") },
    { label: "Clear Selection", disabled: !picked, on: () => setPicked(null) },
    { sep: true },
    { label: "Close Chart", on: () => setChartOpen(false) },
  ]);

  const visible = SERIES.filter((d) => d.v >= lo && d.v <= hi);

  // Decides where each panel mounts: its own OS window on the desktop, in-page in a
  // browser. Returns true only when the caller should still render it here.
  const popHost = usePopoutHost();
  const showChart = popHost.publish("chart", chartOpen,
    { series: visible, title: `Chart — ${visible.length} of ${SERIES.length}` },
    { onClose: () => setChartOpen(false), onPick: setPicked, menuItemsFor });
  const showNotes = popHost.publish("notes", notesOpen,
    { text: notes },
    { onClose: () => setNotesOpen(false), onChange: setNotes });

  return (
    <div className="sdash-root" onMouseDown={() => setMenu(null)}>
      <div className="sdash-toolbar">
        <span className="sdash-brand">STARTER</span>
        <button className={"sdash-tb-btn" + (chartOpen ? " on" : "")} title="Chart"
                onClick={() => setChartOpen((v) => !v)}><IconInteraction size={14} /></button>
        <button className={"sdash-tb-btn" + (notesOpen ? " on" : "")} title="Notes"
                onClick={() => setNotesOpen((v) => !v)}><IconLog size={14} /></button>
        <span className="sdash-tb-sep" />
        <Toggle on={dense} onChange={setDense} title="Dense Rows" />
        <div style={{ width: 220 }}>
          <Range lo={lo} hi={hi} min={0} max={100} step={1}
                 onLo={setLo} onHi={setHi} title="Value Range" />
        </div>
        <span style={{ flex: 1 }} />
        <span className="sdash-tb-note">{picked ? `Picked ${picked}` : "Nothing picked"}</span>
        <button className="sdash-run-btn" onClick={() => setConfirm(true)}>Reset</button>
      </div>

      <div className={"sdash-body" + (dense ? " dense" : "")}>
        <table className="sdash-table">
          <thead><tr><th>Label</th><th>Value</th></tr></thead>
          <tbody>
            {visible.map((d) => (
              <tr key={d.label} className={picked === d.label ? "sel" : undefined}
                  onClick={() => setPicked(d.label)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openMenu(e.clientX, e.clientY, menuItemsFor(d.label));
                  }}>
                <td>{d.label}</td><td>{d.v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Portalled to <body> so no transformed or layered ancestor can bury a panel */}
      {showChart && (
        <Portal>
          <ChartPanel series={visible} title={`Chart — ${visible.length} of ${SERIES.length}`}
                      open onClose={() => setChartOpen(false)} onPick={setPicked}
                      menuItemsFor={menuItemsFor} openMenu={openMenu} />
        </Portal>
      )}
      {showNotes && (
        <Portal>
          <NotesPanel text={notes} open onClose={() => setNotesOpen(false)} onChange={setNotes} />
        </Portal>
      )}

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

      {confirm && (
        <ConfirmDialog message="Reset the range and selection?"
                       saveLabel="Reset" discardLabel="Range Only"
                       onSave={() => { setLo(0); setHi(100); setPicked(null); setConfirm(false); }}
                       onDiscard={() => { setLo(0); setHi(100); setConfirm(false); }}
                       onCancel={() => setConfirm(false)} />
      )}
    </div>
  );
}
