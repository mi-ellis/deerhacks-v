// ── Shared colour palettes & helpers ──────────────────────────────────────────

export const L2_STATUS_COLORS = {
  ONLINE: "#00e676",
  COMPROMISED: "#ff1744",
  WARMING_UP: "#ffab40",
  SYNCING: "#40c4ff",
  DEAD: "#546e7a",
  // Awaiting admin approval in the Zero-Trust join flow
  PENDING: "#9e9e9e",
};

export const DEVICE_STATUS_COLORS = {
  STREAMING: "#69f0ae",
  MOTION_DETECTED: "#ce93d8",
  ALERT: "#ff6d00",
  DATA_PENDING: "#78909c",
  DEAD: "#546e7a",
  UNKNOWN: "#546e7a",
};

export const L3_COLOR = "#00c853";

export function resolveColor(node) {
  if (node.nodeType === "L3") return L3_COLOR;
  if (node.nodeType === "L2") return L2_STATUS_COLORS[node.status] ?? "#757575";
  // Device: a dead heartbeat overrides whatever the driver reports
  if (node.heartbeat === "DEAD") return DEVICE_STATUS_COLORS.DEAD;
  return DEVICE_STATUS_COLORS[node.status] ?? "#546e7a";
}

export function resolveRadius(node) {
  if (node.nodeType === "L3") return 56;
  if (node.nodeType === "L2") return 36;
  return 24;
}
