/**
 * HelpLink — a small "?" button that deep-links into the Help tab's Doc Resources
 * at a specific section. It dispatches an `open-help` window event; App.tsx listens,
 * switches to the Help tab, closes any open dialog, and hands the section to
 * HelpView, which scrolls to it. Non-invasive: any panel can drop
 * <HelpLink section="verify" /> with no prop wiring.
 */
import { INK, BORDER, SURFACE } from '../../theme';

/** Open the user guide at a section (usable outside a component too). */
export function openHelp(section?: string) {
  window.dispatchEvent(new CustomEvent('open-help', { detail: section }));
}

export default function HelpLink({ section, title = 'Open the user guide' }: { section?: string; title?: string }) {
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); openHelp(section); }}
      title={title}
      aria-label={title}
      style={{
        width: 16, height: 16, flexShrink: 0, borderRadius: '50%', cursor: 'pointer', padding: 0,
        border: `1px solid ${BORDER.strong}`, background: 'white', color: INK.secondary,
        fontSize: 10, fontWeight: 700, lineHeight: 1,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = SURFACE.subtle; e.currentTarget.style.color = INK.strong; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'white'; e.currentTarget.style.color = INK.secondary; }}
    >?</button>
  );
}
