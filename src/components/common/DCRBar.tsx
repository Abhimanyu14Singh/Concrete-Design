interface Props {
  label: string;
  dcr: number;
  capacity?: number;
  demand?: number;
  unit?: string;
}

export default function DCRBar({ label, dcr, capacity, demand, unit = 'kip-ft' }: Props) {
  const pct = Math.min(dcr * 100, 120);
  const color = dcr > 1 ? 'bg-red-500' : dcr > 0.9 ? 'bg-amber-400' : 'bg-emerald-500';
  const textColor = dcr > 1 ? 'text-red-600' : dcr > 0.9 ? 'text-amber-600' : 'text-emerald-600';

  return (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{label}</span>
        <span className={`text-sm font-bold ${textColor}`}>
          DCR = {dcr.toFixed(3)}
        </span>
      </div>
      <div className="relative h-5 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full transition-all duration-500`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
        {dcr > 1 && (
          <div
            className="absolute top-0 left-0 h-full bg-red-300 opacity-50 rounded-full"
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        )}
        <div className="absolute inset-0 flex items-center px-2">
          <span className="text-xs font-bold text-white drop-shadow">{(pct).toFixed(0)}%</span>
        </div>
      </div>
      {(capacity !== undefined || demand !== undefined) && (
        <div className="flex justify-between text-xs text-gray-500 mt-0.5">
          {demand !== undefined && <span>Demand: {demand.toFixed(1)} {unit}</span>}
          {capacity !== undefined && <span>Capacity: {capacity.toFixed(1)} {unit}</span>}
        </div>
      )}
    </div>
  );
}
