import { useCallback, useEffect, useRef, useState, Component } from "react";
import ForceGraph2D from "react-force-graph-2d";
import topologyData from "./topology_sample.json";
import { resolveColor, resolveRadius } from "./graphUtils";

const L3_BASE_URL = process.env.REACT_APP_L3_URL || "http://localhost:8080";

// ── Error boundary — surfaces runtime crashes visibly ──────────────────────────
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(err) {
    return { error: err };
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            color: "#ff4444",
            background: "#07080f",
            padding: 40,
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
          }}
        >
          NetworkGraph runtime error:\n{String(this.state.error)}
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Graph constants ────────────────────────────────────────────────────────────

const BG_LIGHT = "#ffffff";
const BG_DARK = "#1c1c24"; // slightly dimmed, not pure black

// Link styles indexed by linkType
const LINK_STYLES = {
  parent: { color: "rgba(0, 0, 0, 0.30)", width: 4.0, dash: [] },
  peer: { color: "rgba(14, 116, 235, 0.70)", width: 3.0, dash: [8, 6] },
};
const LINK_STYLES_DARK = {
  parent: { color: "rgba(255, 255, 255, 0.25)", width: 4.0, dash: [] },
  peer: { color: "rgba(99, 179, 237, 0.75)", width: 3.0, dash: [8, 6] },
};

// ── Graph data builder ─────────────────────────────────────────────────────────

function buildGraphData(topology) {
  const nodes = [];
  const links = [];

  const L3_ID = "__L3_AGGREGATOR__";

  // Central L3 node — pinned to origin so it stays in the middle
  nodes.push({
    id: L3_ID,
    nodeType: "L3",
    label: "L3 Aggregator",
    status: "ONLINE",
    fx: 0,
    fy: 0,
  });

  const peerLinkKeys = new Set();
  // Track physical device IDs to avoid duplicating dual-homed devices
  const seenDeviceIds = new Set();

  for (const l2 of topology.nodes) {
    // L2 node
    nodes.push({
      ...l2,
      nodeType: "L2",
      label: l2.id,
    });

    // L3 → L2 hierarchy link
    links.push({ source: L3_ID, target: l2.id, linkType: "parent" });

    // L2 → each device (skip duplicates — dual-homed devices report to
    // multiple L2 nodes, but should only appear once in the graph)
    for (const dev of l2.devices ?? []) {
      if (seenDeviceIds.has(dev.id)) continue;
      seenDeviceIds.add(dev.id);
      const devId = `${l2.id}::${dev.id}`;
      nodes.push({
        ...dev,
        id: devId,
        nodeType: "device",
        label: dev.id,
        parentL2: l2.id,
      });
      links.push({ source: l2.id, target: devId, linkType: "parent" });
    }

    // Directed peer-watching link from this L2 to its declared peer
    if (l2.peer) {
      const key = `${l2.id}|${l2.peer}`;
      if (!peerLinkKeys.has(key)) {
        peerLinkKeys.add(key);
        links.push({ source: l2.id, target: l2.peer, linkType: "peer" });
      }
    }
  }

  return { nodes, links };
}

// ── Component ──────────────────────────────────────────────────────────────────

function NetworkGraphInner({ onNodeSelect, isDarkMode }) {
  const fgRef = useRef(null);
  const wrapRef = useRef(null);
  const hoveredRef = useRef(null);
  // Persists node positions (fx/fy) across topology rebuilds so existing nodes
  // don't jump when a new node is added.
  const posCache = useRef(new Map());
  const [dims, setDims] = useState({ width: 800, height: 600 });
  const [hoveredNode, setHoveredNode] = useState(null);
  const [pinnedNode, setPinnedNode] = useState(null);

  // Live topology from L3 — starts empty; falls back to static sample only if
  // L3 is unreachable on the very first poll.
  const [topology, setTopology] = useState({ nodes: [] });
  const lastTopologyJson = useRef("");
  const hasLiveData = useRef(false);

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const res = await fetch(`${L3_BASE_URL}/topology`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return;
        const data = await res.json();
        hasLiveData.current = true;
        const json = JSON.stringify(data);
        if (!active || json === lastTopologyJson.current) return;
        lastTopologyJson.current = json;
        setTopology(data);
      } catch {
        // L3 unreachable — fall back to sample data on first failure only
        if (!active) return;
        if (!hasLiveData.current && lastTopologyJson.current === "") {
          lastTopologyJson.current = "fallback";
          setTopology(topologyData);
        }
      }
    }
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  // Stable graphData — only rebuilt when structure (node ids / link count)
  // actually changes.  Status-only updates are patched in-place so D3 never
  // sees new node objects and therefore never disturbs positions.
  const [graphData, setGraphData] = useState(() =>
    buildGraphData({ nodes: [] }),
  );
  const graphDataRef = useRef(graphData);

  useEffect(() => {
    const newData = buildGraphData(topology);
    const prev = graphDataRef.current;

    // Compute a cheap structural fingerprint
    const prevIds = new Set(prev.nodes.map((n) => n.id));
    const newIds = new Set(newData.nodes.map((n) => n.id));
    const structureChanged =
      newData.nodes.length !== prev.nodes.length ||
      newData.links.length !== prev.links.length ||
      newData.nodes.some((n) => !prevIds.has(n.id)) ||
      prev.nodes.some((n) => !newIds.has(n.id));

    if (structureChanged) {
      // Full rebuild — restore pinned positions from cache for existing nodes
      newData.nodes.forEach((n) => {
        const cached = posCache.current.get(n.id);
        if (cached) {
          n.fx = cached.fx;
          n.fy = cached.fy;
        }
      });
      graphDataRef.current = newData;
      setGraphData(newData);
    } else {
      // Status-only update: mutate node objects that D3 already tracks.
      // This preserves identity so the simulation is never disturbed.
      // Do NOT call setGraphData — the canvas redraws every animation frame
      // and will pick up the mutated .status/.devices etc. automatically.
      // Calling setGraphData with a new wrapper object (even with the same
      // nodes array) triggers ForceGraph2D to notify D3, which re-engages
      // the center force and causes nodes to drift.
      const nodeById = new Map(prev.nodes.map((n) => [n.id, n]));
      for (const fresh of newData.nodes) {
        const ex = nodeById.get(fresh.id);
        if (!ex) continue;
        ex.status = fresh.status;
        ex.heartbeat = fresh.heartbeat;
        ex.heartbeat_age_s = fresh.heartbeat_age_s;
        ex.fail_count = fresh.fail_count;
        ex.last_seen_ms = fresh.last_seen_ms;
        ex.active_drivers = fresh.active_drivers;
        ex.devices = fresh.devices;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology]);

  // Reheat the force simulation whenever new nodes/links arrive so they
  // spread out rather than piling up at the origin.
  const prevNodeCount = useRef(0);
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    if (graphData.nodes.length !== prevNodeCount.current) {
      prevNodeCount.current = graphData.nodes.length;
      try {
        fg.d3ReheatSimulation();
      } catch (_) {}
    }
  }, [graphData]);

  // Track container size so ForceGraph2D always gets real pixel dimensions
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setDims({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Configure d3 forces right after mount so they apply from tick 1
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    try {
      fg.d3Force("charge")?.strength(-1000);
      fg.d3Force("link")?.distance((link) => {
        if (link.linkType === "peer") return 560;
        const srcId =
          typeof link.source === "object" ? link.source.id : link.source;
        return srcId === "__L3_AGGREGATOR__" ? 640 : 300;
      });
      fg.d3Force("center")?.strength(0.04);
      fg.d3ReheatSimulation(); // restart so new distances take full effect
    } catch (_) {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Zoom to fit after the simulation cools down, then pin all nodes so
  // they stop drifting once the layout has settled.
  const onEngineStop = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.zoomToFit(500, 80);
    // Pin every node to its current position and persist to the cache so
    // positions survive topology refreshes.
    // Use graphDataRef (our own state) — the ForceGraph2D ref does not expose
    // a graphData() method in this version of the library.
    graphDataRef.current.nodes.forEach((node) => {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
      node.fx = node.x;
      node.fy = node.y;
      posCache.current.set(node.id, { fx: node.x, fy: node.y });
    });
  }, []);

  // ── Node renderer ────────────────────────────────────────────────────────────
  const paintNode = useCallback(
    (node, ctx, globalScale) => {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
      const baseR = resolveRadius(node);
      const color = resolveColor(node);
      // Use state (not just ref) so the callback is recreated on hover change → canvas repaint
      const isHovered = hoveredNode?.id === node.id;
      // Expand radius on hover
      const r = isHovered ? baseR * 1.45 : baseR;

      // Glow / aura for L3 only
      if (node.nodeType === "L3") {
        const grd = ctx.createRadialGradient(
          node.x,
          node.y,
          r * 0.4,
          node.x,
          node.y,
          r * 2.4,
        );
        grd.addColorStop(0, "rgba(0,200,83,0.18)");
        grd.addColorStop(1, "rgba(0,200,83,0)");
        ctx.beginPath();
        ctx.arc(node.x, node.y, r * 2.4, 0, 2 * Math.PI);
        ctx.fillStyle = grd;
        ctx.fill();
      }

      // Fill circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();

      // Thin border so nodes are crisp against the bg
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.strokeStyle = isDarkMode
        ? "rgba(255,255,255,0.22)"
        : "rgba(0,0,0,0.18)";
      ctx.lineWidth = 1.2 / globalScale;
      ctx.stroke();

      // Hover outline — contrasting ring outside the node
      if (isHovered) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 5 / globalScale, 0, 2 * Math.PI);
        ctx.strokeStyle = isDarkMode ? "#f4f4f5" : "#111111";
        ctx.lineWidth = 2.5 / globalScale;
        ctx.stroke();

        // Label badge below the node
        const label = node.label || node.id || "";
        const fontSize = Math.max(10, 13 / globalScale);
        ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const textW = ctx.measureText(label).width;
        const pad = 5 / globalScale;
        const gap = 7 / globalScale;
        const bx = node.x - textW / 2 - pad;
        const by = node.y + r + gap;
        const bw = textW + pad * 2;
        const bh = fontSize + pad * 2;
        const br = Math.min(4 / globalScale, bh / 2);
        // Pill background
        ctx.fillStyle = isDarkMode
          ? "rgba(15,15,20,0.82)"
          : "rgba(255,255,255,0.90)";
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, [br]);
        ctx.fill();
        // Text
        ctx.fillStyle = isDarkMode ? "#f4f4f5" : "#111111";
        ctx.fillText(label, node.x, by + bh / 2);
      }
    },
    [hoveredNode, isDarkMode],
  );

  // Clickable / hoverable hit area — generously padded so small nodes are easy to click
  const paintNodeArea = useCallback((node, color, ctx) => {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
    const r = resolveRadius(node) * 1.45 + 14; // matches hover size + extra margin
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }, []);

  // ── Link renderer — lines clipped to node perimeters ────────────────────────
  const paintLink = useCallback(
    (link, ctx, globalScale) => {
      const src = link.source;
      const tgt = link.target;
      if (!src || !tgt || !Number.isFinite(src.x) || !Number.isFinite(tgt.x))
        return;

      const styles = isDarkMode ? LINK_STYLES_DARK : LINK_STYLES;
      const style = styles[link.linkType] ?? styles.parent;

      // Shrink each endpoint to the node's perimeter so lines don't underlap fills
      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist === 0) return;
      const ux = dx / dist;
      const uy = dy / dist;
      const rSrc = resolveRadius(src);
      const rTgt = resolveRadius(tgt);
      const x1 = src.x + ux * rSrc;
      const y1 = src.y + uy * rSrc;
      const x2 = tgt.x - ux * rTgt;
      const y2 = tgt.y - uy * rTgt;

      ctx.save();
      ctx.beginPath();
      ctx.setLineDash(style.dash);
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.width / globalScale;
      ctx.lineCap = "round";
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.restore();
    },
    [isDarkMode],
  );

  // ── Hover tracking ───────────────────────────────────────────────────────────
  const onNodeHover = useCallback((node) => {
    hoveredRef.current = node ? node.id : null;
    setHoveredNode(node ?? null);
    document.body.style.cursor = node ? "pointer" : "default";
  }, []);

  // Notify parent when pinned node changes
  useEffect(() => {
    onNodeSelect?.(pinnedNode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedNode]);

  // Keep the sidebar in sync when live topology refreshes for the pinned node
  useEffect(() => {
    if (!pinnedNode) return;
    const updated = graphData.nodes.find((n) => n.id === pinnedNode.id);
    if (updated && JSON.stringify(updated) !== JSON.stringify(pinnedNode)) {
      setPinnedNode({ ...updated });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData]);

  // ── Click handling ───────────────────────────────────────────────────────────
  const onNodeClick = useCallback((node) => {
    setPinnedNode(node ?? null);
  }, []);

  const onBackgroundClick = useCallback(() => {
    setPinnedNode(null);
  }, []);

  return (
    <div
      ref={wrapRef}
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: isDarkMode ? BG_DARK : BG_LIGHT,
        transition: "background 0.3s",
      }}
    >
      <ForceGraph2D
        ref={fgRef}
        width={dims.width}
        height={dims.height}
        graphData={graphData}
        backgroundColor={isDarkMode ? BG_DARK : BG_LIGHT}
        // Node rendering
        nodeVal={(node) => resolveRadius(node) ** 2 / 4}
        nodeCanvasObject={paintNode}
        nodePointerAreaPaint={paintNodeArea}
        // Link rendering
        linkCanvasObject={paintLink}
        linkDirectionalParticles={0}
        // Interaction
        onNodeHover={onNodeHover}
        onNodeClick={onNodeClick}
        onBackgroundClick={onBackgroundClick}
        enableNodeDrag={true}
        enableZoomInteraction={true}
        minZoom={0.15}
        maxZoom={10}
        // Simulation
        cooldownTicks={200}
        onEngineStop={onEngineStop}
        warmupTicks={0}
        // No labels — hover only for now
        nodeLabel={() => ""}
      />
    </div>
  );
}

export default function NetworkGraph({ onNodeSelect, isDarkMode }) {
  return (
    <ErrorBoundary>
      <NetworkGraphInner onNodeSelect={onNodeSelect} isDarkMode={isDarkMode} />
    </ErrorBoundary>
  );
}
