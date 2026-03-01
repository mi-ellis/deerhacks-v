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
  // If status is COMPROMISED, return red
  if (node.status === "COMPROMISED") return "#ff1744";
  
  // Otherwise, return green
  return "#00e676";
}

export function resolveRadius(node) {
  if (node.nodeType === "L3") return 56;
  if (node.nodeType === "L2") return 36;
  return 24;
}
