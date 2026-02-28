"""
layer1_mobile_gyro.py — Android orientation sensor via plyer

Run on Android with Pydroid 3.  Install plyer first:
    pip install plyer

Falls back to simulation when running on a desktop (no Android hardware).
"""

import time
import math
import random
from layer1_base import SolanaIoTDevice

# ─── Try to import real Android sensors via plyer ──────────────────────────────
try:
    from plyer import accelerometer, compass
    accelerometer.enable()
    compass.enable()
    time.sleep(0.5)
    REAL_SENSORS = True
    print("[sensors] plyer OK — reading from hardware accelerometer & compass")
except Exception as _e:
    REAL_SENSORS = False
    print(f"[sensors] plyer unavailable ({_e}) — using simulation fallback")

# ─── Sensor reading helpers ────────────────────────────────────────────────────

def _read_real():
    """Return (azimuth_deg, pitch_deg, roll_deg) from Android hardware sensors."""
    acc = accelerometer.acceleration
    mag = compass.field

    if acc is None or None in acc:
        return None, None, None

    gx, gy, gz = acc
    pitch_rad = math.atan2(-gx, math.sqrt(gy * gy + gz * gz))
    roll_rad  = math.atan2(gy, gz)
    pitch_deg = math.degrees(pitch_rad)
    roll_deg  = math.degrees(roll_rad)

    azimuth_deg = 0.0
    if mag is not None and None not in mag:
        mx, my, mz = mag
        cos_p, sin_p = math.cos(pitch_rad), math.sin(pitch_rad)
        cos_r, sin_r = math.cos(roll_rad),  math.sin(roll_rad)
        mx2 = mx * cos_p + mz * sin_p
        my2 = mx * sin_r * sin_p + my * cos_r - mz * sin_r * cos_p
        azimuth_deg = (math.degrees(math.atan2(-my2, mx2)) + 360) % 360

    return azimuth_deg, pitch_deg, roll_deg


_sim = {"azimuth": 45.0, "pitch": 0.0, "roll": 0.0}

def _read_simulated():
    _sim["azimuth"] = (_sim["azimuth"] + random.uniform(-2.0, 2.0)) % 360
    _sim["pitch"]   = max(-90.0, min(90.0, _sim["pitch"] + random.uniform(-3.0, 3.0)))
    _sim["roll"]    = max(-90.0, min(90.0, _sim["roll"]  + random.uniform(-2.0, 2.0)))
    return _sim["azimuth"], _sim["pitch"], _sim["roll"]

# ─── Main ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    device = SolanaIoTDevice("MOBILE_01", "MOBILE_ORIENTATION")
    device.start_heartbeat_thread()

    print("Layer 1 (Mobile Gyro Sensor) Starting...")
    print(f"Device: {device.device_id} | Type: {device.device_type}")
    print(f"Source: {'Android hardware' if REAL_SENSORS else 'simulation'}")
    print(f"Dual-homed to {len(device.l2_nodes)} Layer 2 node(s): {device.l2_nodes}")
    print("BFT active: same signed reading is sent to ALL nodes simultaneously.")
    print("Signed value = tilt magnitude = sqrt(pitch² + roll²)\n")

    while True:
        if REAL_SENSORS:
            az, pitch, roll = _read_real()
            if az is None:
                print("[L1] Waiting for sensor warm-up...")
                time.sleep(0.5)
                continue
        else:
            az, pitch, roll = _read_simulated()

        tilt = math.sqrt(pitch ** 2 + roll ** 2)

        ok = device.send_data(tilt)
        if ok:
            print(
                f"[L1] Sent  | az={az:6.1f}°  pitch={pitch:+6.1f}°  "
                f"roll={roll:+6.1f}°  tilt={tilt:5.2f}°"
            )
        else:
            print("[L1] Failed to send data to any Layer 2 node.")

        time.sleep(2)

