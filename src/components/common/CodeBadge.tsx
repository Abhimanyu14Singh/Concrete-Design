import { codeAccent, codeBg, TRACK } from '../../theme';

interface Props {
  code: string;
  size?: 'sm' | 'md';
}

const DISPLAY: Record<string, string> = {
  'ACI318-19': 'ACI 318-19',
  'ACI318-14': 'ACI 318-14',
  'EN1992-1-1': 'EN 1992-1-1',
};

export default function CodeBadge({ code, size = 'sm' }: Props) {
  const accent = codeAccent(code);
  return (
    <span style={{
      display: 'inline-block',
      fontSize: size === 'sm' ? 10 : 12,
      fontWeight: 700,
      color: accent,
      background: codeBg(code),
      border: `1px solid ${accent}40`,
      borderRadius: 12,
      padding: size === 'sm' ? '2px 8px' : '3px 12px',
      whiteSpace: 'nowrap',
      letterSpacing: TRACK.wide,
    }}>
      {DISPLAY[code] ?? code}
    </span>
  );
}
