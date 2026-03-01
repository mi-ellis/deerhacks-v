import { Filter, Download } from "lucide-react";
import rawAuditData from "./audit_trail_sample.json";

// Filter out comment-only objects (they lack signature_status) and show newest first
const events = [...rawAuditData].filter((e) => e.signature_status).reverse();

const EventFeed = ({ isDarkMode }) => {
  const borderColor = isDarkMode ? "border-zinc-800" : "border-zinc-200";
  const headerBg = isDarkMode ? "bg-zinc-800/50" : "bg-zinc-50";

  return (
    <div className={`mt-2 border rounded-sm overflow-hidden ${borderColor}`}>
      {/* Title Bar */}
      <div
        className={`flex justify-between items-center px-4 py-2 border-b ${headerBg} ${borderColor}`}
      >
        <span className="text-[10px] font-black uppercase tracking-widest">
          Live Event Feed
        </span>
        <div className="flex gap-2 opacity-50">
          <Filter size={14} />
          <Download size={14} />
        </div>
      </div>

      {/* Table */}
      <table className="w-full text-left text-[11px] border-collapse">
        <thead className={headerBg}>
          <tr className={`border-b ${borderColor}`}>
            {[
              "Time (UTC)",
              "Status",
              "Node / Device",
              "Evidence",
              "Solana Link",
            ].map((head) => (
              <th
                key={head}
                className={`p-2 border-r last:border-0 ${borderColor} font-bold uppercase text-center`}
              >
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {events.map((e, i) => {
            const isVerified = e.signature_status === "VERIFIED";
            const statusCls = isVerified ? "text-emerald-500" : "text-red-500";
            const timeStr = new Date(e.logged_at).toLocaleTimeString("en-US", {
              timeZone: "UTC",
              hour12: false,
            });
            const shortLink = e.solana_link
              ? (e.solana_link.split("/tx/")[1] ?? "").slice(0, 12) + "…"
              : null;

            return (
              <tr key={i} className={`border-b last:border-0 ${borderColor}`}>
                <td
                  className={`p-2 border-r ${borderColor} text-center font-bold whitespace-nowrap`}
                >
                  {timeStr}
                </td>
                <td
                  className={`p-2 border-r ${borderColor} text-center font-bold ${statusCls} whitespace-nowrap`}
                >
                  {e.signature_status}
                </td>
                <td
                  className={`p-2 border-r ${borderColor} text-center opacity-60`}
                >
                  {e.node} / {e.device_id}
                </td>
                <td
                  className={`p-2 border-r ${borderColor} text-left opacity-80`}
                >
                  {e.evidence}
                </td>
                <td className="p-2 text-center">
                  {shortLink ? (
                    <a
                      href={e.solana_link}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-500 italic hover:underline"
                    >
                      {shortLink}
                    </a>
                  ) : (
                    <span className="opacity-40">N/A</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default EventFeed;
