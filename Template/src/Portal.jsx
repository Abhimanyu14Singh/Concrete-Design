import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Renders children into a node appended to <body>.
//
// The floating windows are position:fixed with a high z-index, but that only wins inside
// the nearest ancestor STACKING CONTEXT — any ancestor with a transform, filter or
// z-index of its own (the schedule stage is transformed, the toolbars are layered) traps
// them and they end up painted behind the chrome. Living directly under <body> puts them
// in the root stacking context, so "on top of everything" actually holds.
export default function Portal({ children }) {
  const [el] = useState(() =>
    (typeof document === "undefined" ? null : document.createElement("div")));
  useEffect(() => {
    if (!el) return;
    el.className = "sdash-portal";
    document.body.appendChild(el);
    return () => { if (el.parentNode) el.parentNode.removeChild(el); };
  }, [el]);
  if (!el) return null;
  return createPortal(children, el);
}
