import { useCallback, useEffect, useRef, useState } from "react";
import { resolveColor } from "./graphUtils";
import DefaultDataDisplay from "./DefaultDataDisplay";
import GeminiChat from "./GeminiChat";

// ── Layout constants ──────────────────────────────────────────────────────────

const TITLE_H = 44; // px — black title bar
const HEADER_H = 80; // px — two-box row
const HDIV = 10; // px — draggable handle height
const SIDEBAR_W = 300;
const SIDEBAR_MIN_W = 180;
const SIDEBAR_MAX_W = 640;

// ── Draggable divider ─────────────────────────────────────────────────────────

function DragDivider({ onDragDelta }) {
  const dragging = useRef(false);
  const lastY = useRef(0);

  const onMouseDown = useCallback(
    (e) => {
      e.preventDefault();
      dragging.current = true;
      lastY.current = e.clientY;

      const onMove = (ev) => {
        if (!dragging.current) return;
        const delta = ev.clientY - lastY.current;
        lastY.current = ev.clientY;
        onDragDelta(delta);
      };
      const onUp = () => {
        dragging.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [onDragDelta],
  );

  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        flexShrink: 0,
        height: HDIV,
        cursor: "ns-resize",
        background: "linear-gradient(to top, #e0e0e0, #d0d0d0)",
        borderTop: "1px solid #bbb",
        borderBottom: "1px solid #bbb",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 32,
          height: 3,
          borderRadius: 2,
          background: "#aaa",
        }}
      />
    </div>
  );
}

// ── NodeSidebar ───────────────────────────────────────────────────────────────

export default function NodeSidebar({ node, visible }) {
  const lastNodeRef = useRef(node);
  if (node) lastNodeRef.current = node;
  const display = lastNodeRef.current;

  const sidebarRef = useRef(null);
  const [totalH, setTotalH] = useState(window.innerHeight);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_W);

  // ── Horizontal resize (left edge drag) ──────────────────────────────────────
  const resizeDragging = useRef(false);
  const resizeLastX = useRef(0);

  const onResizeMouseDown = useCallback((e) => {
    e.preventDefault();
    resizeDragging.current = true;
    resizeLastX.current = e.clientX;

    const onMove = (ev) => {
      if (!resizeDragging.current) return;
      // Moving left (smaller clientX) → wider sidebar
      const delta = resizeLastX.current - ev.clientX;
      resizeLastX.current = ev.clientX;
      setSidebarWidth((prev) =>
        Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, prev + delta)),
      );
    };
    const onUp = () => {
      resizeDragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  useEffect(() => {
    const el = sidebarRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setTotalH(entries[0].contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Space below header available to sections (excludes the two divider handles)
  const varH = Math.max(0, totalH - TITLE_H - HEADER_H - 2 * HDIV);
  const MIN_SEC = 20; // minimum section height in px

  // Layout state:
  //   spacerH  — invisible spacer above div1 (0 = div1 right below header by default)
  //   telemH   — data display section height (null → auto = varH/2)
  // geminiH is derived: varH - spacerH - telemH
  const [spacerH, setSpacerH] = useState(0);
  const [telemHRaw, setTelemHRaw] = useState(null);
  const telemH = Math.max(MIN_SEC, telemHRaw ?? varH / 2);
  const geminiH = Math.max(MIN_SEC, varH - spacerH - telemH);

  // div1 dragged: spacer grows/shrinks, data panel compensates (div2 stays fixed)
  const onDrag1 = useCallback(
    (delta) => {
      setSpacerH((prev) => {
        const next = Math.max(
          0,
          Math.min(varH - telemH - MIN_SEC, prev + delta),
        );
        const actualDelta = next - prev;
        setTelemHRaw((t) => Math.max(MIN_SEC, (t ?? varH / 2) - actualDelta));
        return next;
      });
    },
    [varH, telemH],
  );

  // div2 dragged: data panel grows/shrinks, gemini compensates (spacer + div1 fixed)
  const onDrag2 = useCallback(
    (delta) => {
      setTelemHRaw((prev) => {
        const cur = prev ?? varH / 2;
        const maxT = varH - spacerH - MIN_SEC;
        return Math.max(MIN_SEC, Math.min(maxT, cur + delta));
      });
    },
    [spacerH, varH],
  );

  const statusColor = display ? resolveColor(display) : "#546e7a";
  const nodeLabel = display?.label ?? display?.id ?? "—";

  return (
    <div
      ref={sidebarRef}
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        width: sidebarWidth,
        height: "100vh",
        transform: visible ? "translateX(0)" : "translateX(100%)",
        transition: "transform 0.28s cubic-bezier(0.4, 0, 0.2, 1)",
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        borderLeft: "2px solid #000",
        pointerEvents: visible ? "auto" : "none",
        userSelect: "none",
        background: "#fff",
      }}
    >
      {/* ── Left-edge resize handle ── */}
      <div
        onMouseDown={onResizeMouseDown}
        style={{
          position: "absolute",
          top: 0,
          left: -5,
          width: 10,
          height: "100%",
          cursor: "ew-resize",
          zIndex: 10,
        }}
      />
      {/* ── Title bar ── */}
      <div
        style={{
          flexShrink: 0,
          height: TITLE_H,
          background: "#000",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          padding: "0 18px",
          fontFamily: "monospace",
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        Node Inspector
      </div>

      {/* ── Two info boxes ── */}
      <div
        style={{
          flexShrink: 0,
          height: HEADER_H,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 10px",
          background: "#fff",
        }}
      >
        {/* Status box */}
        <div
          style={{
            flex: 1,
            border: "1.5px solid #000",
            borderRadius: 4,
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            height: 58,
            justifyContent: "center",
          }}
        >
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 9,
              color: "#888",
              letterSpacing: "0.15em",
              textTransform: "uppercase",
            }}
          >
            Status
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: statusColor,
                flexShrink: 0,
                boxShadow: `0 0 6px ${statusColor}88`,
              }}
            />
            <span
              style={{
                fontFamily: "monospace",
                fontSize: 11,
                fontWeight: 700,
                color: statusColor,
                letterSpacing: "0.05em",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {display?.status ?? "—"}
            </span>
          </div>
        </div>

        {/* Node ID box */}
        <div
          style={{
            flex: 1,
            border: "1.5px solid #000",
            borderRadius: 4,
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            height: 58,
            justifyContent: "center",
          }}
        >
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 9,
              color: "#888",
              letterSpacing: "0.15em",
              textTransform: "uppercase",
            }}
          >
            Node ID
          </span>
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 11,
              fontWeight: 700,
              color: "#111",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {nodeLabel}
          </span>
        </div>
      </div>

      {/* ── Spacer above div1 (expands when div1 is dragged down) ── */}
      {spacerH > 0 && <div style={{ flexShrink: 0, height: spacerH }} />}

      {/* ── Divider 1 ── */}
      <DragDivider onDragDelta={onDrag1} />

      {/* ── Data display section ── */}
      <DefaultDataDisplay display={display} height={telemH} />

      {/* ── Divider 2 ── */}
      <DragDivider onDragDelta={onDrag2} />

      {/* ── GeminiChat section ── */}
      <GeminiChat height={geminiH} />
    </div>
  );
}
