/**
 * MapFilterMenu — the plan's single "Filter" control. One dropdown consolidates
 * every show/hide facet (member type, floors, design groups, sections) that used
 * to be spread across the story dropdown and the "Floors:" chip row. Each facet is
 * a checklist with All / None; a badge on the button counts how many items are
 * currently hidden. Purely presentational — the host owns the hidden-sets.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon, type IconName } from '../common/Icon';
import { ACCENT, BORDER, INK, SURFACE } from '../../theme';

export interface FilterItem { key: string; label: string; color?: string }
export interface FilterSection {
  title: string;
  items: FilterItem[];
  /** Keys currently HIDDEN (unchecked). */
  hidden: Set<string>;
  onToggle: (key: string) => void;
  /** Show (true) or hide (false) every item in the section. */
  onAll: (show: boolean) => void;
}

const miniBtn: CSSProperties = { fontSize: 9, color: INK.muted, background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' };

export default function MapFilterMenu({ sections, hiddenCount, onClearAll, icon = 'filter', label = 'Filter', title = "Filter what's shown on the plan — member type, floors, groups, sections" }: {
  sections: FilterSection[];
  hiddenCount: number;
  onClearAll: () => void;
  /** Button glyph (defaults to the filter funnel). */
  icon?: IconName;
  /** Panel-header text and the button's accessible name (defaults to "Filter").
   *  The trigger itself is icon-only — this is not rendered on it. */
  label?: string;
  /** Button tooltip. */
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);

  const active = hiddenCount > 0;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {/* Icon-only trigger: `label` moves to aria-label (and the panel header), so
          the control keeps its name for assistive tech and the tooltip. */}
      <button onClick={() => setOpen(o => !o)} title={title} aria-label={label}
        style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 8px', border: `1px solid ${active ? ACCENT.primary : BORDER.strong}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', background: active ? ACCENT.softBg : 'white', color: active ? ACCENT.primary : INK.base, fontWeight: 600 }}>
        <Icon name={icon} />
        {active && <span style={{ background: ACCENT.primary, color: 'white', borderRadius: 8, fontSize: 9, padding: '0 5px', fontWeight: 700 }}>{hiddenCount}</span>}
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 50, background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 8, boxShadow: '0 6px 24px rgba(0,0,0,0.15)', minWidth: 232, maxHeight: 480, overflow: 'auto', padding: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '2px 8px 6px' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: INK.strong }}>{label}</span>
            {active && <button onClick={onClearAll} style={{ marginLeft: 'auto', fontSize: 10, color: ACCENT.primary, background: 'none', border: 'none', cursor: 'pointer' }}>Reset</button>}
          </div>
          {sections.filter(s => s.items.length > 0).map(sec => (
            <div key={sec.title} style={{ borderTop: `1px solid ${SURFACE.subtle}`, padding: '5px 2px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 6px' }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: INK.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>{sec.title}</span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  <button onClick={() => sec.onAll(true)} style={miniBtn}>All</button>
                  <span style={{ color: BORDER.strong, fontSize: 9 }}>·</span>
                  <button onClick={() => sec.onAll(false)} style={miniBtn}>None</button>
                </span>
              </div>
              {sec.items.map(it => {
                const shown = !sec.hidden.has(it.key);
                return (
                  <label key={it.key} title={it.label}
                    style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 6px', cursor: 'pointer', borderRadius: 4, fontSize: 12, color: shown ? INK.base : INK.muted }}
                    onMouseEnter={e => (e.currentTarget.style.background = SURFACE.subtle)}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <input type="checkbox" checked={shown} onChange={() => sec.onToggle(it.key)} style={{ cursor: 'pointer', accentColor: ACCENT.primary, flexShrink: 0 }} />
                    {it.color && <span style={{ width: 9, height: 9, borderRadius: 2, background: it.color, flexShrink: 0 }} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                  </label>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
