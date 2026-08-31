import React, { useState, useRef, useEffect } from "react";

// Small shared controls. Lifted from the app they came out of and stripped of its
// domain: no units, no engineering value kinds. What is left is the behaviour worth
// keeping.

// An icon-sized on/off pill. The whole control is the button — no label, no checkbox.
export function Toggle({ on, onChange, title, disabled }) {
  return (
    <button type="button" title={title} disabled={disabled}
            onClick={() => !disabled && onChange(!on)}
            className={"sdash-toggle" + (on ? " on" : "") + (disabled ? " disabled" : "")} />
  );
}

// A pill that reads as pressed when active. Use a row of them for a segmented control.
export function Pill({ icon, label, active, title, onClick, disabled }) {
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick}
            className={"sdash-pill" + (active ? " on" : "") + (disabled ? " disabled" : "")}>
      {icon}{label ? <span>{label}</span> : null}
    </button>
  );
}

// A row of mutually exclusive pills.
export function PillRow({ value, onChange, opts }) {
  return (
    <div className="sdash-pillrow">
      {opts.map(([k, icon, title]) => (
        <Pill key={k} icon={icon} active={value === k} title={title} onClick={() => onChange(k)} />
      ))}
    </div>
  );
}

// Two-thumb range slider, built from two native <input type="range"> stacked in one
// track. There is no such thing in React and the library versions sit in the same place
// in the render path, so they inherit the same cost this one was written to avoid.
//
// DRAG LOCALLY, PUSH ONCE PER FRAME. Sending every tick straight to the parent made one
// pixel of drag re-render everything downstream, and a high-polling mouse fires far
// faster than the screen refreshes, so the work queued up behind the pointer. Here the
// thumb and fill come from local state — they stay under the pointer even if a frame is
// dropped — while the parent is updated on an animation frame, coalesced, so several
// pointer events inside one frame cost a single re-render. Live feedback, capped at the
// refresh rate rather than the mouse's.
export function Range({ icon, title, lo, hi, min, max, step = 1, fmt, disabled, onLo, onHi }) {
  hi = Math.min(hi, max);
  const gap = step;              // keep at least one step between the thumbs, both ends

  const [drag, setDrag] = useState(null);    // {lo, hi} while dragging, else null
  const vLo = drag ? drag.lo : lo, vHi = drag ? drag.hi : hi;
  // a ref so a queued frame compares against the CURRENT committed values, not the ones
  // captured when it was scheduled
  const curRef = useRef({ lo, hi });
  curRef.current = { lo, hi };
  const rafRef = useRef(0);
  const pendRef = useRef(null);

  const flush = () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    const p = pendRef.current;
    pendRef.current = null;
    if (!p) return;
    if (p.lo !== curRef.current.lo) onLo(p.lo);
    if (p.hi !== curRef.current.hi) onHi(p.hi);
  };
  const push = (d) => {
    setDrag(d);
    pendRef.current = d;
    if (rafRef.current) return;              // a frame is queued; it will take the latest
    rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; flush(); });
  };
  const commit = () => { if (!drag && !pendRef.current) return; flush(); setDrag(null); };

  const span = (max - min) || 1;
  const loP = ((vLo - min) / span) * 100, hiP = ((vHi - min) / span) * 100;
  // Decimals follow the STEP: a 0.1 step reads "0.5", a 500 step reads "1500". Printing
  // the raw value spills float noise (0.30000000000000004) into the row and drags the
  // slider narrower with every move.
  const decs = step >= 1 ? 0 : Math.max(0, Math.min(3, Math.ceil(-Math.log10(step || 1))));
  const num = (v) => (fmt ? fmt(v) : (+v).toFixed(decs));

  // pointerup can land anywhere — the pointer leaves the thumb readily at speed — so the
  // commit listens on the window, not the input.
  const endRef = useRef(commit);
  endRef.current = commit;
  useEffect(() => {
    if (!drag) return undefined;
    const end = () => endRef.current();
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [drag]);
  // never leave a queued frame behind on unmount
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  return (
    <div className={"sdash-sliderrow" + (disabled ? " disabled" : "")} title={title}>
      {icon != null && <span className="sdash-slabel">{icon}</span>}
      <div className="sdash-range">
        <div className="sdash-range-fill"
             style={{ left: `${loP}%`, width: `${Math.max(0, hiP - loP)}%` }} />
        <input type="range" min={min} max={max} step={step} value={vLo} disabled={disabled}
               onChange={(e) => push({ lo: Math.min(+e.target.value, vHi - gap), hi: vHi })}
               onKeyUp={commit} onBlur={commit} />
        <input type="range" min={min} max={max} step={step} value={vHi} disabled={disabled}
               onChange={(e) => push({ lo: vLo, hi: Math.max(+e.target.value, vLo + gap) })}
               onKeyUp={commit} onBlur={commit} />
      </div>
      <span className="sdash-sval">{num(vLo)}–{num(vHi)}</span>
    </div>
  );
}

// Three-way confirm. The backdrop cancels, so there is always a way out that is not a
// decision.
export function ConfirmDialog({ message, onSave, onDiscard, onCancel,
                                saveLabel = "Save", discardLabel = "Don't Save",
                                cancelLabel = "Cancel" }) {
  return (
    <div className="sdash-confirm-backdrop"
         onMouseDown={(e) => { e.stopPropagation(); onCancel(); }}>
      <div className="sdash-confirm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sdash-confirm-msg">{message}</div>
        <div className="sdash-confirm-actions">
          <button className="sdash-run-btn sdash-confirm-save" onClick={onSave}>{saveLabel}</button>
          <button className="sdash-confirm-btn" onClick={onDiscard}>{discardLabel}</button>
          <button className="sdash-confirm-btn ghost" onClick={onCancel}>{cancelLabel}</button>
        </div>
      </div>
    </div>
  );
}
