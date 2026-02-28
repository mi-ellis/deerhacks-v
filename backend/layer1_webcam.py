import cv2
import time
from layer1_base import SolanaIoTDevice

# ─── Main ──────────────────────────────────────────────────────────────────────
device = SolanaIoTDevice("WEBCAM_01", "WEBCAM_LIGHT")

print("Layer 1 (Webcam Sensor) Starting...")
print(f"Device: {device.device_id} | Type: {device.device_type}")
print(f"Dual-homed to {len(device.l2_nodes)} Layer 2 node(s): {device.l2_nodes}")
print("BFT active: same signed frame is sent to ALL nodes simultaneously.")
print("An evil node cannot suppress a reading — at least one honest node always sees it.\n")

cap = cv2.VideoCapture(0)
if not cap.isOpened():
    print("ERROR: Cannot open webcam")
    exit(1)

print("Streaming frames to Layer 2 (POST /frame)...\n")
print("  Each frame is fan-out to every known L2 node in parallel.")
print("  Layer 2 nodes decode via WEBCAM_LIGHT driver and serve MJPEG at /video_feed\n")

frame_num = 0
while True:
    ret, frame = cap.read()
    if not ret:
        break

    frame_num += 1

    # Encode as JPEG — Layer 2 is the processor, not us
    _, buf      = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
    frame_bytes = buf.tobytes()

    ok = device.send_frame(frame_bytes)
    # send_frame already prints per-node confirmation; add frame counter here
    if not ok:
        print(f"[WARN] Frame #{frame_num} not delivered to any node — check Layer 2 nodes are running")

    time.sleep(0.1)  # ~10 fps

cap.release()
