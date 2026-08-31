import React, { useRef, useState } from "react";
import { IconClose, IconFit } from "./icons.jsx";
import { useFillWindow, winStyle } from "./useFillWindow.js";

// A panel that draws. This is the shape to copy for anything with an SVG or canvas,
// because it is the case where getting the sizing wrong actually shows: the frame
// stretches and the drawing inside it does not.
//
// The rules it follows:
//   · position and size live in state, so the panel floats and resizes in-page
//   · useFillWindow returns true in a popped-out window and drives `size` from the
//     viewport instead, so the drawing follows the OS window being resized
//   · winStyle decides which of the two is in charge; nothing else has to know
//   · every callback is a prop — the panel never reaches for app state, which is what
//     lets the same component render in-page and in its own window
export default function ChartPanel({
  series = [], title = "Chart", open = true, onClose, onPick, menuItemsFor, openMenu,
}) {
  const winRef = useRef(null);
  const drag = useRef(null);
  const resize = useRef(null);
  const [pos, setPos] = useState({ x: 24, y: 24 });
  const [size, setSize] = useState({ w: 420, h: 280 });
  const fill = useFillWindow(setSize);        // popped out, the OS window sizes us
  const [hover, setHover] = useState(null);

  // Drag the header to move, the corner to resize — in-page only; popped out the OS
  // window owns both and the grip is not rendered at all.
  const onMove = (e) => {
    if (drag.current) {
      const d = drag.current;
      setPos({ x: d.px + (e.clientX - d.sx), y: d.py + (e.clientY - d.sy) });
    } else if (resize.current) {
      const r = resize.current;
      setSize({ w: Math.max(240, r.w + (e.clientX - r.sx)),
                h: Math.max(160, r.h + (e.clientY - r.sy)) });
    }
  };
  const onUp = () => { drag.current = null; resize.current = null; };

  // Awaited because popped out this ASKS the main window for the items and waits for
  // the reply; in-page menuItemsFor just returns the array and await passes it through.
  // One path, both hosts. Coordinates are read before the await so the menu opens where
  // the click was.
  const menu = async (e, target) => {
    if (!openMenu || !menuItemsFor) return;
    const x = e.clientX, y = e.clientY;
    const items = await menuItemsFor(target);
    if (items && items.length) openMenu(x, y, items);
  };

  const w = Math.max(1, size.w - 16), h = Math.max(1, size.h - 46);
  const maxV = Math.max(1, ...series.map((d) => d.v));
  const bw = series.length ? w / series.length : w;

  return (
    <div ref={winRef} className="sdash-planwin" style={winStyle(fill, pos, size, open)}
         onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
         onMouseDown={(e) => e.stopPropagation()}>
      <div className="sdash-planwin-head"
           onMouseDown={(e) => {
             if (e.button === 0 && !fill) {
               drag.current = { sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y };
             }
           }}>
        <span style={{ flex: 1, fontWeight: 600 }}>{title}</span>
        <span className="sdash-planwin-fit" title="Fit"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setHover(null)}><IconFit size={13} /></span>
        <span className="sdash-planwin-x" title="Close"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onClose && onClose()}><IconClose size={13} /></span>
      </div>

      <div className="sdash-planwin-body">
        <svg width={w} height={h} style={{ display: "block" }}
             onContextMenu={(e) => { e.preventDefault(); menu(e, null); }}>
          {series.map((d, i) => {
            const bh = (d.v / maxV) * (h - 18);
            return (
              <g key={d.label}
                 onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                 onClick={() => onPick && onPick(d.label)}
                 onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); menu(e, d.label); }}
                 style={{ cursor: "pointer" }}>
                <rect x={i * bw + 2} y={h - 18 - bh} width={Math.max(1, bw - 4)} height={bh}
                      fill={hover === i ? "#38bdf8" : "#0ea5e9"} rx="2" />
                <text x={i * bw + bw / 2} y={h - 5} textAnchor="middle"
                      fontSize="10" fill="#94a3b8">{d.label}</text>
              </g>
            );
          })}
        </svg>
      </div>

      {!fill && (
        <div className="sdash-planwin-resize"
             onMouseDown={(e) => {
               e.stopPropagation();
               resize.current = { sx: e.clientX, sy: e.clientY, w: size.w, h: size.h };
             }} />
      )}
    </div>
  );
}
