import { useEffect, useState } from "react";
import { isPopoutWindow } from "./popoutBus.js";

// Who decides how big a panel is.
//
// In the page a panel floats: it carries its own position and size, you drag its header
// to move it and its corner to resize it, and it opens at whatever default it was
// written with (280x250 for Plan, 460x320 for Log, …). Popped out, all of that is the
// OS window's job — and those defaults become wrong the moment the user resizes, which
// is what made the panels look pinned to a small box in the corner of their own window.
//
// Every panel drives its CONTENT from `size` — an SVG's width/height, a list's scroll
// box — so it is not enough to let CSS stretch the frame; the size state itself has to
// follow the window or the frame grows and the drawing inside it does not. A popped-out
// window holds exactly one panel, so the viewport IS the panel: track it and feed it in.
//
// There is no loop between the two, because when filling, winStyle() stops setting
// width/height from `size` and leaves it to CSS.
export function useFillWindow(setSize) {
  const [fill] = useState(isPopoutWindow);
  useEffect(() => {
    if (!fill) return undefined;
    const apply = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [fill, setSize]);
  return fill;
}

// The root element's style under either host. Filled, position and size come from the
// stylesheet (.sdash-popout .sdash-planwin) so the panel covers its window; floating,
// they come from the panel's own drag/resize state exactly as before.
export function winStyle(fill, pos, size, open) {
  const shown = { display: open ? undefined : "none" };
  return fill ? shown
              : { ...shown, transform: `translate(${pos.x}px, ${pos.y}px)`,
                  width: size.w, height: size.h };
}
