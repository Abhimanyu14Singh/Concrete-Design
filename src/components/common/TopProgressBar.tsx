/**
 * TopProgressBar — a thin indeterminate progress bar pinned to the top of the
 * nearest positioned ancestor. Shown while a background recompute is running
 * so the user gets feedback instead of a frozen-looking UI.
 *
 * Renders nothing when `active` is false.
 */
interface Props {
  active: boolean;
  /** Optional label shown as a small badge on the right. */
  label?: string;
}

export default function TopProgressBar({ active, label = 'Recalculating…' }: Props) {
  if (!active) return null;
  return (
    <>
      <style>{`
        @keyframes tpb-slide {
          0%   { left: -40%; width: 40%; }
          50%  { left: 30%;  width: 45%; }
          100% { left: 100%; width: 40%; }
        }
        @keyframes tpb-pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
      `}</style>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 3,
        background: '#e0e7ff', overflow: 'hidden', zIndex: 50,
      }}>
        <div style={{
          position: 'absolute', top: 0, height: '100%',
          background: '#4f46e5', borderRadius: 2,
          animation: 'tpb-slide 1.1s ease-in-out infinite',
        }} />
      </div>
      <div style={{
        position: 'absolute', top: 8, right: 12, zIndex: 51,
        background: '#4f46e5', color: 'white', fontSize: 10, fontWeight: 600,
        padding: '3px 9px', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
        display: 'flex', alignItems: 'center', gap: 5, pointerEvents: 'none',
      }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%', background: 'white',
          animation: 'tpb-pulse 1.1s ease-in-out infinite',
        }} />
        {label}
      </div>
    </>
  );
}
