import React, { useRef, useState } from "react";
import { IconClose } from "./icons.jsx";
import { useFillWindow, winStyle } from "./useFillWindow.js";

// The minimal panel: state in, callbacks out, nothing else. Copy this one when the
// panel has no drawing to size — the frame stretches on its own and `size` is only
// there so the in-page version can be resized.
export default function NotesPanel({ text = "", open = true, onClose, onChange }) {
  const drag = useRef(null);
  const [pos, setPos] = useState({ x: 60, y: 60 });
  const [size, setSize] = useState({ w: 340, h: 240 });
  const fill = useFillWindow(setSize);

  return (
    <div className="sdash-planwin" style={winStyle(fill, pos, size, open)}
         onMouseMove={(e) => {
           if (!drag.current) return;
           const d = drag.current;
           setPos({ x: d.px + (e.clientX - d.sx), y: d.py + (e.clientY - d.sy) });
         }}
         onMouseUp={() => { drag.current = null; }}
         onMouseDown={(e) => e.stopPropagation()}>
      <div className="sdash-planwin-head"
           onMouseDown={(e) => {
             if (e.button === 0 && !fill) {
               drag.current = { sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y };
             }
           }}>
        <span style={{ flex: 1, fontWeight: 600 }}>Notes</span>
        <span className="sdash-planwin-x" title="Close"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onClose && onClose()}><IconClose size={13} /></span>
      </div>
      <div className="sdash-planwin-body" style={{ padding: 8 }}>
        <textarea
          value={text}
          onChange={(e) => onChange && onChange(e.target.value)}
          placeholder="Type here. The text lives in the main window — this panel only
displays it and reports edits, so it reads the same docked or popped out."
          style={{ width: "100%", height: "100%", resize: "none", boxSizing: "border-box",
                   background: "transparent", color: "inherit", font: "inherit",
                   border: "1px solid #24303f", borderRadius: 4, padding: 8 }} />
      </div>
    </div>
  );
}
