import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Component,
} from "react";
import ForceGraph2D from "react-force-graph-2d";
import topologyData from "./topology_sample.json";
import { resolveColor, resolveRadius } from "./graphUtils";
import NodeSidebar from "./NodeSidebar";

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

const BG_COLOR = "#ffffff";

// Link styles indexed by linkType
const LINK_STYLES = {
  parent: { color: "rgba(0, 0, 0, 0.30)", width: 4.0, dash: [] },
  peer: { color: "rgba(14, 116, 235, 0.70)", width: 3.0, dash: [8, 6] },
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

  for (const l2 of topology.nodes) {
    // L2 node
    nodes.push({
      ...l2,
      nodeType: "L2",
      label: l2.id,
    });

    // L3 → L2 hierarchy link
    links.push({ source: L3_ID, target: l2.id, linkType: "parent" });

    // L2 → each device
    for (const dev of l2.devices ?? []) {
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

function NetworkGraphInner() {
  const fgRef = useRef(null);
  const wrapRef = useRef(null);
  const hoveredRef = useRef(null);
  const [dims, setDims] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const [hoveredNode, setHoveredNode] = useState(null);
  const [pinnedNode, setPinnedNode] = useState(null);

  const graphData = useMemo(() => buildGraphData(topologyData), []);

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

  // Zoom to fit after the simulation cools down
  const onEngineStop = useCallback(() => {
    fgRef.current?.zoomToFit(500, 80);
  }, []);

  // ── Node renderer ────────────────────────────────────────────────────────────
  const paintNode = useCallback((node, ctx, globalScale) => {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
    const r = resolveRadius(node);
    const color = resolveColor(node);
    const isHovered = hoveredRef.current === node.id;

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

    // Thin dark border so nodes are crisp against the white bg
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1.2 / globalScale;
    ctx.stroke();

    // Hover outline — dark ring outside the node
    if (isHovered) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 5 / globalScale, 0, 2 * Math.PI);
      ctx.strokeStyle = "#111111";
      ctx.lineWidth = 2.5 / globalScale;
      ctx.stroke();
    }
  }, []);

  // Clickable / hoverable hit area (generously sized)
  const paintNodeArea = useCallback((node, color, ctx) => {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
    const r = resolveRadius(node) + 6;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }, []);

  // ── Link renderer — lines clipped to node perimeters ────────────────────────
  const paintLink = useCallback((link, ctx, globalScale) => {
    const src = link.source;
    const tgt = link.target;
    if (!src || !tgt || !Number.isFinite(src.x) || !Number.isFinite(tgt.x))
      return;

    const style = LINK_STYLES[link.linkType] ?? LINK_STYLES.parent;

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
  }, []);

  // ── Hover tracking ───────────────────────────────────────────────────────────
  const onNodeHover = useCallback((node) => {
    hoveredRef.current = node ? node.id : null;
    setHoveredNode(node ?? null);
    document.body.style.cursor = node ? "pointer" : "default";
  }, []);

  // ── Click handling ───────────────────────────────────────────────────────────
  const onNodeClick = useCallback((node) => {
    setPinnedNode(node ?? null);
  }, []);

  const onBackgroundClick = useCallback(() => {
    setPinnedNode(null);
  }, []);

  // Sidebar visibility / display node
  const sidebarNode = hoveredNode ?? pinnedNode;
  const sidebarVisible = hoveredNode !== null || pinnedNode !== null;

  return (
    <div
      ref={wrapRef}
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "#ffffff",
      }}
    >
      <ForceGraph2D
        ref={fgRef}
        width={dims.width}
        height={dims.height}
        graphData={graphData}
        backgroundColor={BG_COLOR}
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
      <NodeSidebar node={sidebarNode} visible={sidebarVisible} />
    </div>
  );
}

export default function NetworkGraph() {
  return (
    <ErrorBoundary>
      <NetworkGraphInner />
    </ErrorBoundary>
  );
}
