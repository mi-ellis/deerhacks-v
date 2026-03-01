import React, { useCallback, useRef, useState } from "react";
import Header from "./components/Header";
import StatusLegend from "./components/StatusLegend";
import EventFeed from "./components/EventFeed";
import NetworkGraph from "./components/NetworkGraph";
import NodeSidebar from "./components/NodeSidebar";

const BOTTOM_MIN = 80;
const BOTTOM_MAX = 600;
const BOTTOM_DEFAULT = 220;
import Chatbox from './components/Chatbox';

const App = () => {
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Sidebar state — lifted up so the sidebar is a flex sibling to the main column
  const [sidebarNode, setSidebarNode] = useState(null);
  const [sidebarVisible, setSidebarVisible] = useState(false);

  // Draggable bottom panel height
  const [bottomH, setBottomH] = useState(BOTTOM_DEFAULT);
  const dragRef = useRef(false);
  const lastY = useRef(0);

  const onHandleMouseDown = useCallback((e) => {
    e.preventDefault();
    dragRef.current = true;
    lastY.current = e.clientY;

    const onMove = (ev) => {
      if (!dragRef.current) return;
      const delta = lastY.current - ev.clientY; // drag up → panel grows
      lastY.current = ev.clientY;
      setBottomH((h) => Math.max(BOTTOM_MIN, Math.min(BOTTOM_MAX, h + delta)));
    };
    const onUp = () => {
      dragRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const handleNodeSelect = (node) => {
    setSidebarNode(node);
    setSidebarVisible(node !== null);
  };

  const handleColor = isDarkMode ? "#3f3f46" : "#d4d4d8";
  const handleBg = isDarkMode ? "#27272a" : "#f4f4f5";

  return (
    // Root: flex-row so the sidebar pushes the main content left instead of overlaying it
    <div
      className={`h-screen flex flex-row overflow-hidden font-mono transition-colors duration-300
        ${isDarkMode ? "bg-zinc-900 text-zinc-100" : "bg-white text-zinc-900"}`}
    >
      {/* ── Main column ── */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Header
          isDarkMode={isDarkMode}
          toggleDark={() => setIsDarkMode(!isDarkMode)}
        />

        {/* Network graph fills all remaining vertical space */}
        <main className="flex-1 relative overflow-hidden min-h-0">
          <NetworkGraph
            onNodeSelect={handleNodeSelect}
            isDarkMode={isDarkMode}
          />
        </main>

        {/* ── Drag handle ── */}
        <div
          onMouseDown={onHandleMouseDown}
          style={{
            flexShrink: 0,
            height: 8,
            cursor: "ns-resize",
            background: handleBg,
            borderTop: `1px solid ${handleColor}`,
            borderBottom: `1px solid ${handleColor}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "background 0.3s",
          }}
        >
          <div
            style={{
              width: 36,
              height: 3,
              borderRadius: 2,
              background: handleColor,
              transition: "background 0.3s",
            }}
          />
        </div>

        {/* Bottom panel — fixed height, scrollable */}
        <div
          style={{ height: bottomH, flexShrink: 0, overflowY: "auto" }}
          className="px-4 pb-4 pt-2"
        >
          <StatusLegend isDarkMode={isDarkMode} />
          <EventFeed isDarkMode={isDarkMode} />
        </div>
      </div>

      {/* ── Sidebar — appears to the right, pushes the main column ── */}
      <NodeSidebar
        node={sidebarNode}
        visible={sidebarVisible}
        isDarkMode={isDarkMode}
      />
    </div>
  );
};

export default App;
