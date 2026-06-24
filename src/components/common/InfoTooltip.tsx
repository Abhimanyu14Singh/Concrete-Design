/**
 * InfoTooltip — lightweight hover tooltip for inline engineering explanations.
 * Renders an ⓘ icon; on hover, shows a floating panel positioned to avoid
 * viewport overflow. No external dependencies.
 */
import { useState, useRef, useCallback } from 'react';

interface Props {
  text: string;
  /** Optional formula / equation to display below the text in monospace. */
  formula?: string;
  /** Placement hint — default 'right'. Panel flips when near viewport edge. */
  placement?: 'right' | 'left' | 'top';
}

const ICON: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 13, height: 13, borderRadius: '50%',
  background: '#e0e7ff', color: '#4338ca',
  fontSize: 9, fontWeight: 700, cursor: 'default',
  flexShrink: 0, userSelect: 'none', lineHeight: 1,
  marginLeft: 4, verticalAlign: 'middle',
};

const PANEL: React.CSSProperties = {
  position: 'fixed',
  zIndex: 9999,
  maxWidth: 280,
  background: '#1e293b',
  color: '#f1f5f9',
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 11,
  lineHeight: 1.5,
  boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
  pointerEvents: 'none',
};

export default function InfoTooltip({ text, formula, placement = 'right' }: Props) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  const show = useCallback(() => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const panelW = 280, panelH = formula ? 80 : 52;

    let top = r.top - 4;
    let left = placement === 'left' ? r.left - panelW - 6 : r.right + 6;

    // Flip if too close to right edge
    if (left + panelW > vw - 8) left = r.left - panelW - 6;
    // Flip if too close to left edge
    if (left < 8) left = r.right + 6;
    // Clamp vertically
    if (top + panelH > vh - 8) top = vh - panelH - 8;
    if (top < 8) top = 8;

    setPos({ top, left });
  }, [placement, formula]);

  const hide = useCallback(() => setPos(null), []);

  return (
    <>
      <span ref={ref} style={ICON} onMouseEnter={show} onMouseLeave={hide} aria-label="info">ⓘ</span>
      {pos && (
        <div style={{ ...PANEL, top: pos.top, left: pos.left }}>
          {text}
          {formula && (
            <div style={{ marginTop: 5, fontFamily: 'monospace', fontSize: 10, color: '#94a3b8', whiteSpace: 'pre' }}>
              {formula}
            </div>
          )}
        </div>
      )}
    </>
  );
}
