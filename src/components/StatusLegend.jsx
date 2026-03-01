const StatusLegend = () => {
  const statuses = [
    { label: 'ACTIVE', color: 'bg-emerald-500' },
    { label: 'SYNCING', color: 'bg-amber-500' },
    { label: 'DOWN', color: 'bg-rose-500' }
  ];

  return (
    <div className="flex gap-6 py-3 border-b border-zinc-300 text-[10px] font-bold">
      {statuses.map((s) => (
        <div key={s.label} className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${s.color}`} />
          <span>{s.label} ()</span>
        </div>
      ))}
    </div>
  );
};

export default StatusLegend;