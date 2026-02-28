import sys, json
data = json.load(sys.stdin)
val = data.get('value', 0)
dev = data.get('id', 'unknown')

# Deprecated
if val < 5:
    r = {"status": "SENSOR_COVERED", "level": "CRITICAL", "lux_raw": val, "is_healthy": False, "msg": "Sensor may be covered"}
elif val <= 10:
    r = {"status": "TOTAL_DARKNESS", "level": "CRITICAL", "lux_raw": val, "is_healthy": True, "msg": "Pitch black"}
elif val <= 50:
    r = {"status": "DARK", "level": "LOW", "lux_raw": val, "is_healthy": True, "msg": "Very dark room"}
elif val <= 200:
    r = {"status": "OPTIMAL_INDOOR", "level": "NORMAL", "lux_raw": val, "is_healthy": True, "msg": "Dim indoor lighting"}
elif val <= 1000:
    r = {"status": "BRIGHT_INDOOR", "level": "NORMAL", "lux_raw": val, "is_healthy": True, "msg": "Bright indoors"}
elif val <= 5000:
    r = {"status": "BRIGHT", "level": "HIGH", "lux_raw": val, "is_healthy": True, "msg": "Very bright / cloudy day"}
else:
    r = {"status": "EXTREME_LIGHT", "level": "CRITICAL", "lux_raw": val, "is_healthy": True, "msg": "Direct sunlight"}

print(f"[{dev}] {r['status']} (lux={val}) — {r['msg']}")
print(json.dumps(r))
