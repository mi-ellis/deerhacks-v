import sys, json, base64, os, time
import cv2
import numpy as np

# ── Read JSON payload from stdin (sent by Layer 2 node) ───────────────────────
data       = json.load(sys.stdin)
frame_b64  = data.get('frame', '')
device_id  = data.get('id', 'unknown')
node_id    = data.get('nodeId', 'default')
timestamp  = float(data.get('timestamp', time.time()))

if not frame_b64:
    print(json.dumps({"error": "no frame data", "device": device_id}))
    print('')
    sys.exit(1)

# ── Decode JPEG bytes ──────────────────────────────────────────────────────────
raw    = base64.b64decode(frame_b64)
np_arr = np.frombuffer(raw, dtype=np.uint8)
frame  = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

if frame is None:
    print(json.dumps({"error": "cv2.imdecode failed", "device": device_id}))
    print('')
    sys.exit(1)

# ── Brightness ─────────────────────────────────────────────────────────────────
gray       = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
brightness = float(np.mean(gray))

# ── Motion + Entropy + Loop detection ─────────────────────────────────────────
# State is persisted between driver invocations via a small .npz file.
# The file is scoped to BOTH device and node so that two L2 nodes processing
# the same frame in parallel each maintain their own independent motion history.
# Without this, concurrent writes corrupt the prev_gray and produce zero diff
# (same frame compared to itself), causing spurious NO_MOTION readings.
LOOP_THRESHOLD_SECONDS = 3.0
MOTION_DIFF_THRESHOLD  = 2.0
ZERO_DIFF_THRESHOLD    = 0.05

STATE_FILE = f'/tmp/webcam_{device_id}_{node_id}_state.npz'

prev_gray       = None
last_motion_ts  = 0.0
zero_diff_since = 0.0   # 0.0 means "currently no zero-diff run"

if os.path.exists(STATE_FILE):
    try:
        s               = np.load(STATE_FILE, allow_pickle=False)
        prev_gray       = s['prev_gray']
        last_motion_ts  = float(s['last_motion_ts'])
        zero_diff_since = float(s['zero_diff_since'])
    except Exception:
        prev_gray = None   # corrupt state — start fresh

frame_diff    = 0.0
frame_entropy = 0.0
motion_status = 'NO_MOTION'

if prev_gray is not None and prev_gray.shape == gray.shape:
    # Frame difference (mean absolute deviation across all pixels)
    diff_img   = cv2.absdiff(prev_gray, gray)
    frame_diff = float(np.mean(diff_img))

    # Shannon entropy of the current frame histogram (bits per pixel)
    # A frozen / looping frame has entropy that does not change between calls,
    # but we measure it per-frame as a supplementary indicator.
    hist = cv2.calcHist([gray], [0], None, [256], [0, 256])
    hist = hist / (hist.sum() + 1e-9)
    frame_entropy = float(-np.sum(hist * np.log2(hist + 1e-9)))

    if frame_diff < ZERO_DIFF_THRESHOLD:
        # Near-zero diff — potential loop
        if zero_diff_since == 0.0:
            zero_diff_since = timestamp          # start the clock
        elif (timestamp - zero_diff_since) > LOOP_THRESHOLD_SECONDS:
            motion_status = 'LOOP_DETECTION'    # frozen for too long
        else:
            motion_status = 'NO_MOTION'
    else:
        zero_diff_since = 0.0                   # reset loop clock
        if frame_diff > MOTION_DIFF_THRESHOLD:
            motion_status   = 'MOTION'
            last_motion_ts  = timestamp

# Save updated state for the next invocation
np.savez_compressed(
    STATE_FILE,
    prev_gray=gray,
    last_motion_ts=np.float64(last_motion_ts),
    zero_diff_since=np.float64(zero_diff_since),
)

# ── Annotate frame with overlay ────────────────────────────────────────────────
STATUS_COLORS = {
    'MOTION':         (0, 140, 255),   # orange
    'NO_MOTION':      (0, 200, 0),     # green
    'LOOP_DETECTION': (0, 0, 255),     # red
}
color = STATUS_COLORS.get(motion_status, (200, 200, 200))

h, w    = frame.shape[:2]
label   = (f'{device_id}  {motion_status}  '
           f'diff={frame_diff:.2f}  brt={brightness:.1f}')

overlay = frame.copy()
cv2.rectangle(overlay, (0, 0), (w, 50), (0, 0, 0), -1)
cv2.addWeighted(overlay, 0.55, frame, 0.45, 0, frame)
cv2.putText(frame, label, (10, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.65, color, 2)

# ── Encode processed frame as JPEG ────────────────────────────────────────────
_, out_buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
out_b64    = base64.b64encode(out_buf.tobytes()).decode()

# ── Output protocol ───────────────────────────────────────────────────────────
# Line 1: JSON analysis result (consumed by Layer 2 for logging / gossip)
# Line 2: base64-encoded annotated JPEG (consumed by Layer 2 for MJPEG stream)
print(json.dumps({
    'status':     motion_status,
    'brightness': round(brightness, 2),
    'frameDiff':  round(frame_diff, 4),
    'entropy':    round(frame_entropy, 4),
    'device':     device_id,
}))
print(out_b64)

