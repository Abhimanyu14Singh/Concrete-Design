/**
 * Dropdown — behavior-identical replacement for native <select> that works
 * reliably in Electron regardless of window-focus state.
 *
 * Native <select> popups are managed by the OS and require the WebContents to
 * have received a real focus gesture first; in Electron windows shown via
 * show:false → ready-to-show → win.show() the first click is "eaten" focusing
 * the page, so selects appear frozen until a second click. This component
 * renders the option list as a React <div>, bypassing native popups entirely.
 *
 * API is a strict superset of the controlled <select> interface:
 *   value     — currently selected value (string | number)
 *   options   — [{ value, label, disabled? }]
 *   onChange  — called with String(value), exactly like e.target.value
 * So existing call sites only need to change the JSX tag.
 */
import { useState, useEffect, useRef, useId, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ACCENT, BORDER, INK, SURFACE } from '../../theme';

export interface DropdownOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

interface Props {
  value: string | number;
  options: DropdownOption[];
  onChange: (v: string) => void;
  style?: React.CSSProperties;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  /** When true, option list opens upward (useful near bottom of viewport). */
  openUp?: boolean;
}

/** Rect of the trigger button, updated on open. */
interface ListPos { top: number; bottom: number; left: number; width: number; viewH: number; viewW: number }

export default function Dropdown({
  value, options, onChange, style, disabled, title, ariaLabel, openUp,
}: Props) {
  const [open, setOpen] = useState(false);
  const [listPos, setListPos] = useState<ListPos | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();

  // Measure trigger position whenever the list opens so the portal can
  // position itself correctly regardless of scroll / overflow ancestors.
  const measureAndOpen = useCallback(() => {
    if (disabled) return;
    const rect = ref.current?.getBoundingClientRect();
    if (rect) {
      setListPos({ top: rect.bottom, bottom: rect.top, left: rect.left, width: rect.width, viewH: window.innerHeight, viewW: window.innerWidth });
    }
    setOpen(o => !o);
  }, [disabled]);

  // Re-measure on scroll / resize so the portal tracks the trigger.
  useEffect(() => {
    if (!open) return;
    function reposition() {
      const rect = ref.current?.getBoundingClientRect();
      if (rect) setListPos({ top: rect.bottom, bottom: rect.top, left: rect.left, width: rect.width, viewH: window.innerHeight, viewW: window.innerWidth });
    }
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => { window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition); };
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Keyboard navigation
  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    const enabledOpts = options.filter(o => !o.disabled);
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault(); setOpen(true);
      }
      return;
    }
    const cur = enabledOpts.findIndex(o => String(o.value) === String(value));
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = enabledOpts[(cur + 1) % enabledOpts.length];
      if (next) onChange(String(next.value));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = enabledOpts[(cur - 1 + enabledOpts.length) % enabledOpts.length];
      if (prev) onChange(String(prev.value));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); setOpen(false);
    }
  }

  const current = options.find(o => String(o.value) === String(value));
  const label = current?.label ?? String(value);

  const TRIGGER: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4,
    width: '100%', textAlign: 'left',
    background: disabled ? SURFACE.subtle : 'white',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    ...style,
  };

  // Portal list position: open downward if space allows, upward otherwise.
  const goUp = listPos
    ? (openUp || (listPos.viewH - listPos.top < 200 && listPos.bottom > 200))
    : !!openUp;
  // Flip horizontally (right-align to the trigger) when the trigger sits too
  // close to the right edge for the menu to open rightward without clipping —
  // the list is content-width (nowrap) and can be wider than the trigger.
  const goLeft = listPos ? (listPos.viewW - listPos.left < 220) : false;
  const LIST: React.CSSProperties = listPos ? {
    position: 'fixed',
    top: goUp ? undefined : listPos.top + 2,
    bottom: goUp ? (listPos.viewH - listPos.bottom + 2) : undefined,
    left: goLeft ? undefined : listPos.left,
    right: goLeft ? Math.max(8, listPos.viewW - (listPos.left + listPos.width)) : undefined,
    minWidth: listPos.width,
    maxWidth: listPos.viewW - 16,
    maxHeight: 220,
    overflowY: 'auto',
    background: 'white',
    border: `1px solid ${BORDER.strong}`,
    borderRadius: 6,
    boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
    zIndex: 9999,
  } : {};

  return (
    <div ref={ref} data-dropdown={id}
      style={{ display: 'inline-block', width: style?.width ?? 'auto' }}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        disabled={disabled}
        title={title}
        aria-label={ariaLabel ?? label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={measureAndOpen}
        style={TRIGGER}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ fontSize: 8, color: INK.muted, flexShrink: 0, marginLeft: 2 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && listPos && createPortal(
        <div role="listbox" style={LIST}>
          {options.map(opt => {
            const selected = String(opt.value) === String(value);
            return (
              <div
                key={opt.value}
                role="option"
                aria-selected={selected}
                aria-disabled={opt.disabled}
                onMouseDown={e => {
                  e.preventDefault(); // keep focus on trigger
                  if (!opt.disabled) { onChange(String(opt.value)); setOpen(false); }
                }}
                style={{
                  padding: '5px 10px',
                  cursor: opt.disabled ? 'not-allowed' : 'pointer',
                  background: selected ? ACCENT.softBg : 'white',
                  color: opt.disabled ? INK.muted : selected ? ACCENT.primary : INK.strong,
                  fontWeight: selected ? 600 : 400,
                  fontSize: 'inherit',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={e => { if (!opt.disabled) (e.currentTarget as HTMLDivElement).style.background = selected ? ACCENT.softBg : SURFACE.subtle; }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = selected ? ACCENT.softBg : 'white'; }}
              >
                {opt.label}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
