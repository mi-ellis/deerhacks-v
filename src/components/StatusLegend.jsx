import { L2_STATUS_COLORS } from "./graphUtils";

const StatusLegend = ({ isDarkMode }) => {
  const statuses = [
    { label: "ONLINE",      color: L2_STATUS_COLORS.ONLINE },
    { label: "SYNCING",     color: L2_STATUS_COLORS.SYNCING },
    { label: "WARMING UP",  color: L2_STATUS_COLORS.WARMING_UP },
    { label: "COMPROMISED", color: L2_STATUS_COLORS.COMPROMISED },
    { label: "PENDING",     color: L2_STATUS_COLORS.PENDING },
    { label: "DEAD",        color: L2_STATUS_COLORS.DEAD },
  ];

  return (
    <div
      className="flex flex-wrap gap-4 py-3 border-b text-[10px] font-bold"
      style={{ borderColor: isDarkMode ? "#3f3f46" : "#d4d4d8" }}
    >
      {statuses.map((s) => (
        <div key={s.label} className="flex items-center gap-2">
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: s.color,
              boxShadow: `0 0 5px ${s.color}88`,
              flexShrink: 0,
            }}
          />
          <span style={{ color: isDarkMode ? "#a1a1aa" : "#52525b" }}>
            {s.label}
          </span>
        </div>
      ))}
    </div>
  );
};

export default StatusLegend;
