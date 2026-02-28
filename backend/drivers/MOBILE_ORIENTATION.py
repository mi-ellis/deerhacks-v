import sys, json

# ─── MOBILE_ORIENTATION Driver ─────────────────────────────────────────────────
# Input: JSON on stdin with keys 'id' and 'value'
#   value = tilt magnitude in degrees = sqrt(pitch² + roll²)
#           produced by layer1_mobile_gyro.py from the Android TYPE_ORIENTATION sensor.
#           Range: 0° (perfectly flat) → ~127° (face-down, fully inverted).
#
# Orientation bands (tilt magnitude):
#   0 – 5°   : FLAT          — device resting face-up on a surface
#   5 – 20°  : SLIGHT_TILT   — casually held, minor tilt
#   20 – 45° : TILTED        — intentional tilt, interactive use
#   45 – 80° : STEEP_TILT    — near-vertical, reading / portrait mode
#   80 – 90° : UPRIGHT       — device held fully vertical
#   > 90°    : INVERTED      — device face-down or past vertical

data = json.load(sys.stdin)
val  = float(data.get("value", 0))
dev  = data.get("id", "unknown")

if val < 0:
    r = {
        "status":    "INVALID_READING",
        "level":     "CRITICAL",
        "tilt_deg":  val,
        "is_healthy": False,
        "msg":       "Negative tilt magnitude — sensor error or tampered data",
    }
elif val <= 5:
    r = {
        "status":    "FLAT",
        "level":     "NORMAL",
        "tilt_deg":  val,
        "is_healthy": True,
        "msg":       "Device is flat / resting face-up",
    }
elif val <= 20:
    r = {
        "status":    "SLIGHT_TILT",
        "level":     "NORMAL",
        "tilt_deg":  val,
        "is_healthy": True,
        "msg":       "Minor tilt — casually held or propped",
    }
elif val <= 45:
    r = {
        "status":    "TILTED",
        "level":     "NORMAL",
        "tilt_deg":  val,
        "is_healthy": True,
        "msg":       "Significant tilt — active use / landscape mode",
    }
elif val <= 80:
    r = {
        "status":    "STEEP_TILT",
        "level":     "NORMAL",
        "tilt_deg":  val,
        "is_healthy": True,
        "msg":       "Near-vertical — portrait reading mode",
    }
elif val <= 90:
    r = {
        "status":    "UPRIGHT",
        "level":     "NORMAL",
        "tilt_deg":  val,
        "is_healthy": True,
        "msg":       "Device held fully upright / vertical",
    }
else:
    r = {
        "status":    "INVERTED",
        "level":     "WARNING",
        "tilt_deg":  val,
        "is_healthy": True,
        "msg":       "Device is face-down or tilted past vertical",
    }

print(f"[{dev}] {r['status']} (tilt={val:.2f}°) — {r['msg']}")
print(json.dumps(r))
