const StatusLegend = ({ activeCount = 0, compromisedCount = 0, isDarkMode }) => {
  const statuses = [
    { label: 'ACTIVE', count: activeCount, color: 'bg-emerald-500' },
    { label: 'DOWN', count: compromisedCount, color: 'bg-rose-500' }
  ];  

  const borderColor = isDarkMode ? 'border-zinc-800' : 'border-zinc-300';
  const textColor = isDarkMode ? 'text-zinc-100' : 'text-zinc-900';

  return (
    <div className={`flex gap-6 py-3 border-b ${borderColor} text-[10px] font-bold ${textColor}`}>
      {statuses.map((s) => (
        <div key={s.label} className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${s.color}`} />
          <span>{s.label} ({s.count})</span>
        </div>
      ))}
    </div>
  );
};

export default StatusLegend;