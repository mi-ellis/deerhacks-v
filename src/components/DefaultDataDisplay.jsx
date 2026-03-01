import telemetryData from "./telemetry_sample.json";

// ── Telemetry lookup ──────────────────────────────────────────────────────────

const telemetryByDevice = Object.fromEntries(
  telemetryData.map((d) => [d.device_id, d]),
);

function formatTs(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ── DefaultDataDisplay ────────────────────────────────────────────────────────

export default function DefaultDataDisplay({ display, height }) {
  const deviceId = display?.nodeType === "device" ? display.label : null;
  const entry = deviceId ? telemetryByDevice[deviceId] : null;
  const history = entry ? entry.history.slice(-20) : [];

  return (
    <div
      style={{
        height,
        overflowY: "auto",
        fontFamily: "monospace",
        fontSize: 11,
        background: "#fff",
        flexShrink: 0,
      }}
    >
      {!deviceId && (
        <div style={{ padding: "12px 16px", color: "#999" }}>
          No telemetry — select a device node.
        </div>
      )}
      {deviceId && !entry && (
        <div style={{ padding: "12px 16px", color: "#999" }}>
          No telemetry found for <strong>{deviceId}</strong>.
        </div>
      )}
      {entry && (
        <>
          <div
            style={{
              padding: "8px 14px 4px",
              color: "#555",
              fontSize: 10,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>Device: {deviceId}</span>
            <span
              style={{
                color:
                  entry.consensus_score === "DISPUTED" ? "#ff6d00" : "#388e3c",
              }}
            >
              {entry.consensus_score}
            </span>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              padding: "4px 14px 2px",
              color: "#999",
              fontSize: 10,
              borderBottom: "1px solid #eee",
            }}
          >
            <span>TIME</span>
            <span>VALUE</span>
            <span>STATE</span>
          </div>
          {history.map((h, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                padding: "5px 14px",
                borderBottom: "1px solid #f5f5f5",
                background: i % 2 === 0 ? "#fafafa" : "#fff",
                color: "#333",
              }}
            >
              <span style={{ color: "#777" }}>{formatTs(h.timestamp)}</span>
              <span>{h.value}</span>
              <span style={{ color: "#555" }}>{h.state}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
