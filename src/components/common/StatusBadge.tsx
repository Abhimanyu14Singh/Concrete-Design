interface Props {
  status: 'OK' | 'NG' | 'Warning';
  size?: 'sm' | 'md';
}

export default function StatusBadge({ status, size = 'md' }: Props) {
  const colors = {
    OK: 'bg-emerald-500 text-white',
    NG: 'bg-red-500 text-white',
    Warning: 'bg-amber-400 text-gray-900',
  };
  const sz = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  return (
    <span className={`${colors[status]} ${sz} rounded-full font-bold tracking-wide`}>
      {status}
    </span>
  );
}
