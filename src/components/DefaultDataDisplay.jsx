import { useEffect, useRef, useState } from "react";
import telemetryData from "./telemetry_sample.json";

// ── Telemetry lookup (fallback) ───────────────────────────────────────────────

const FALLBACK_TELEMETRY = Object.fromEntries(
  telemetryData.map((d) => [d.device_id, d]),
);

const L3_BASE_URL = process.env.REACT_APP_L3_URL || "http://localhost:8080";

function formatTs(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ── DefaultDataDisplay ────────────────────────────────────────────────────────

export default function DefaultDataDisplay({ display, height, isDarkMode }) {
  const deviceId = display?.nodeType === "device" ? display.label : null;

  // Live telemetry map: device_id → { device_id, history, consensus_score }
  const [liveTelemetry, setLiveTelemetry] = useState(FALLBACK_TELEMETRY);
  const hasLiveData = useRef(false);

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const res = await fetch(`${L3_BASE_URL}/telemetry`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok || !active) return;
        const packets = await res.json(); // array of { device_id, history, consensus_score }
        hasLiveData.current = true;
        setLiveTelemetry(
          Object.fromEntries(packets.map((p) => [p.device_id, p])),
        );
      } catch {
        // L3 unreachable — keep showing whatever we have
      }
    }
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const entry = deviceId ? liveTelemetry[deviceId] : null;
  const history = entry ? entry.history.slice(-20) : [];

  const bg = isDarkMode ? "#18181b" : "#fff";
  const mutedText = isDarkMode ? "#71717a" : "#999";
  const subText = isDarkMode ? "#a1a1aa" : "#555";
  const divider = isDarkMode ? "#27272a" : "#eee";
  const rowEven = isDarkMode ? "#1f1f23" : "#fafafa";
  const rowOdd = isDarkMode ? "#18181b" : "#fff";
  const bodyText = isDarkMode ? "#e4e4e7" : "#333";

  return (
    <div
      style={{
        height,
        overflowY: "auto",
        fontFamily: "monospace",
        fontSize: 11,
        background: bg,
        flexShrink: 0,
        transition: "background 0.3s",
      }}
    >
      {!deviceId && (
        <div style={{ padding: "12px 16px", color: mutedText }}>
          No telemetry — select a device node.
        </div>
      )}
      {deviceId && !entry && (
        <div style={{ padding: "12px 16px", color: mutedText }}>
          No telemetry found for <strong>{deviceId}</strong>.
        </div>
      )}
      {entry && (
        <>
          <div
            style={{
              padding: "8px 14px 4px",
              color: subText,
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
                  entry.consensus_score === "DISPUTED" ? "#ff6d00" : "#4ade80",
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
              color: mutedText,
              fontSize: 10,
              borderBottom: `1px solid ${divider}`,
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
                borderBottom: `1px solid ${divider}`,
                background: i % 2 === 0 ? rowEven : rowOdd,
                color: bodyText,
              }}
            >
              <span style={{ color: mutedText }}>{formatTs(h.timestamp)}</span>
              <span>{h.value}</span>
              <span style={{ color: subText }}>{h.state}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
