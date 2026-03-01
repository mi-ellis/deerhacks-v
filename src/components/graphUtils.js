// ── Shared colour palettes & helpers ──────────────────────────────────────────

export const L2_STATUS_COLORS = {
  ONLINE: "#00e676",
  COMPROMISED: "#ff1744",
  WARMING_UP: "#ffab40",
  SYNCING: "#40c4ff",
  DEAD: "#546e7a",
};

export const DEVICE_STATUS_COLORS = {
  STREAMING: "#69f0ae",
  MOTION_DETECTED: "#ce93d8",
  ALERT: "#ff6d00",
  DATA_PENDING: "#78909c",
  UNKNOWN: "#546e7a",
};

export const L3_COLOR = "#00c853";

export function resolveColor(node) {
  if (node.nodeType === "L3") return L3_COLOR;
  if (node.nodeType === "L2") return L2_STATUS_COLORS[node.status] ?? "#757575";
  return DEVICE_STATUS_COLORS[node.status] ?? "#546e7a";
}

export function resolveRadius(node) {
  if (node.nodeType === "L3") return 56;
  if (node.nodeType === "L2") return 36;
  return 24;
}
