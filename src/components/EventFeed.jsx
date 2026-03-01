import { Filter, Download } from 'lucide-react';

const EventFeed = ({ events, isDarkMode }) => {
  // Pre-calculating class names to keep the JSX cleaner
  const borderColor = isDarkMode ? 'border-zinc-800' : 'border-zinc-200';
  const headerBg = isDarkMode ? 'bg-zinc-800/50' : 'bg-zinc-50';

  return (
    <div className={`mt-2 border rounded-sm overflow-hidden ${borderColor}`}>
      {/* Table Header / Title Bar */}
      <div className={`flex justify-between items-center px-4 py-2 border-b ${headerBg} ${borderColor}`}>
        <span className="text-[10px] font-black uppercase tracking-widest">Live Event Feed</span>
        <div className="flex gap-2 opacity-50">
          <Filter size={14} />
          <Download size={14} />
        </div>
      </div>
      
      {/* The Data Table */}
      <table className="w-full text-left text-[11px] border-collapse">
        <thead className={headerBg}>
          <tr className={`border-b ${borderColor}`}>
            {/* Mapping column headers */}
            {['Time (UTC)', 'Status', 'Node ID', 'Solana Link'].map(head => (
              <th key={head} className={`p-2 border-r last:border-0 ${borderColor} font-bold uppercase text-center`}>
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* Mapping through the events array provided by App.jsx state */}
          {events.map((e, i) => (
            <tr key={i} className={`border-b last:border-0 ${borderColor} transition-colors duration-500`}>
              <td className={`p-2 border-r ${borderColor} text-center font-bold`}>{e.time}</td>
              {/* Highlight status in green */}
              <td className={`p-2 border-r ${borderColor} text-center text-emerald-500 font-bold`}>{e.status}</td>
              <td className={`p-2 border-r ${borderColor} text-center opacity-60`}>{e.node}</td>
              <td className="p-2 text-center italic opacity-80">{e.log}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default EventFeed;