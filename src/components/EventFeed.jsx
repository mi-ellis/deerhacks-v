import { Search, Download } from "lucide-react";
import { useState } from "react";
import rawAuditData from "./audit_trail_sample.json";

// Filter out comment-only objects (they lack signature_status) and show newest first
const events = [...rawAuditData].filter((e) => e.signature_status).reverse();

const EventFeed = ({ isDarkMode }) => {
  const borderColor = isDarkMode ? "border-zinc-800" : "border-zinc-200";
  const headerBg = isDarkMode ? "bg-zinc-800/50" : "bg-zinc-50";
  const inputBg = isDarkMode ? "bg-zinc-700" : "bg-zinc-100";
  const textColor = isDarkMode ? "text-zinc-100" : "text-zinc-900";

  // Search and filter state
  const [searchTerm, setSearchTerm] = useState("");
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [timeFilter, setTimeFilter] = useState("ALL");

  // CSV download function
  const downloadAsCSV = () => {
    if (filteredEvents.length === 0) {
      alert("No events to download");
      return;
    }

    // Create CSV header
    const headers = ["Time (UTC)", "Status", "Node", "Device ID", "Evidence", "Solana Link"];
    
    // Create CSV rows
    const rows = filteredEvents.map((e) => {
      const timeStr = new Date(e.logged_at).toLocaleTimeString("en-US", {
        timeZone: "UTC",
        hour12: false,
      });
      return [
        timeStr,
        e.signature_status,
        e.node,
        e.device_id,
        e.evidence,
        e.solana_link || "N/A",
      ];
    });

    // Combine headers and rows
    const csvContent = [
      headers.join(","),
      ...rows.map((row) =>
        row
          .map((cell) =>
            typeof cell === "string" && cell.includes(",")
              ? `"${cell}"`
              : cell
          )
          .join(",")
      ),
    ].join("\n");

    // Create blob and download
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `node_events_${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Filter events based on search and filters
  const filteredEvents = events.filter((e) => {
    // Status filter
    if (statusFilter !== "ALL" && e.signature_status !== statusFilter) {
      return false;
    }

    // Time filter
    if (timeFilter !== "ALL") {
      const eventTime = new Date(e.logged_at);
      const now = new Date();
      const minutesAgo = (now - eventTime) / (1000 * 60);

      if (timeFilter === "5MIN" && minutesAgo > 5) return false;
      if (timeFilter === "30MIN" && minutesAgo > 30) return false;
      if (timeFilter === "1HOUR" && minutesAgo > 60) return false;
    }

    // Search term (time, status, node, device)
    if (searchTerm) {
      const search = searchTerm.toLowerCase();
      const timeStr = new Date(e.logged_at)
        .toLocaleTimeString("en-US", { timeZone: "UTC", hour12: false })
        .toLowerCase();
      const node = (e.node || "").toLowerCase();
      const device = (e.device_id || "").toLowerCase();
      const status = (e.signature_status || "").toLowerCase();

      return (
        timeStr.includes(search) ||
        node.includes(search) ||
        device.includes(search) ||
        status.includes(search)
      );
    }

    return true;
  });

  return (
    <div className={`mt-2 border rounded-sm overflow-hidden ${borderColor}`}>
      {/* Title Bar */}
      <div
        className={`flex justify-between items-center px-4 py-2 border-b ${headerBg} ${borderColor}`}
      >
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-black uppercase tracking-widest">
            Live Event Feed
          </span>
          <button
            onClick={() => setShowFilterPanel(!showFilterPanel)}
            className={`flex items-center gap-2 px-3 py-1 rounded text-[10px] font-bold uppercase tracking-widest transition-colors ${
              showFilterPanel
                ? "bg-emerald-500/30 text-emerald-500"
                : "bg-zinc-500/20 text-zinc-400 hover:bg-zinc-500/40 hover:text-zinc-300"
            }`}
          >
            <Search size={14} />
            Search/Filter
          </button>
        </div>
        <div className="flex gap-2">
          <button
            onClick={downloadAsCSV}
            className="p-1 rounded hover:bg-zinc-500/10 transition-colors opacity-50 hover:opacity-100"
            title="Download events as CSV"
          >
            <Download size={14} />
          </button>
        </div>
      </div>

      {/* Filter Panel */}
      {showFilterPanel && (
        <div className={`px-4 py-3 border-b ${borderColor} ${inputBg} space-y-3`}>
          {/* Search Input */}
          <div>
            <label className="text-[10px] font-bold uppercase tracking-widest block mb-1">
              Search
            </label>
            <input
              type="text"
              placeholder="Search by time, status, node, or device..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className={`w-full p-2 border ${borderColor} rounded text-[11px] ${inputBg} ${textColor}`}
            />
          </div>

          {/* Status Filter */}
          <div>
            <label className="text-[10px] font-bold uppercase tracking-widest block mb-1">
              Status
            </label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className={`w-full p-2 border ${borderColor} rounded text-[11px] ${inputBg} ${textColor}`}
            >
              <option value="ALL">All Statuses</option>
              <option value="VERIFIED">Verified</option>
              <option value="FAILED">Failed</option>
            </select>
          </div>

          {/* Time Filter */}
          <div>
            <label className="text-[10px] font-bold uppercase tracking-widest block mb-1">
              Time Range
            </label>
            <select
              value={timeFilter}
              onChange={(e) => setTimeFilter(e.target.value)}
              className={`w-full p-2 border ${borderColor} rounded text-[11px] ${inputBg} ${textColor}`}
            >
              <option value="ALL">All Time</option>
              <option value="5MIN">Last 5 Minutes</option>
              <option value="30MIN">Last 30 Minutes</option>
              <option value="1HOUR">Last 1 Hour</option>
            </select>
          </div>

          <button
            onClick={() => {
              setShowFilterPanel(false);
              setSearchTerm("");
              setStatusFilter("ALL");
              setTimeFilter("ALL");
            }}
            className="w-full text-[11px] py-1 bg-emerald-500/20 text-emerald-500 rounded hover:bg-emerald-500/30 transition-colors"
          >
            Reset Filters
          </button>
        </div>
      )}

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
          {filteredEvents.length > 0 ? (
            filteredEvents.map((e, i) => {
              const isVerified = e.signature_status === "VERIFIED";
              const statusCls = isVerified ? "text-emerald-500" : "text-red-500";
              const timeStr = new Date(e.logged_at).toLocaleTimeString(
                "en-US",
                { timeZone: "UTC", hour12: false }
              );
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
            })
          ) : (
            <tr>
              <td colSpan="5" className={`p-4 text-center opacity-50`}>
                No events match your filters
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

export default EventFeed;
