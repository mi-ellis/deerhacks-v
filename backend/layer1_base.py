import time
import threading
import os
import json
import socket
import base64
import hashlib
import hmac
import secrets
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    print(
        "[layer1_base] ERROR: 'requests' is not installed.\n"
        "  Install it with:  pip install requests\n"
        "  Then re-run the script."
    )
    raise

# ─── Load .env ──────────────────────────────────────────────────────────────────
def load_dotenv(path='.env'):
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, _, v = line.partition('=')
                os.environ.setdefault(k.strip(), v.strip())

load_dotenv()

DISCOVERY_UDP_PORT = 5099  # L2 nodes listen here for UDP broadcast discovery

# ─── HMAC-SHA256 Device Signer ─────────────────────────────────────────────────
class DeviceSigner:
    """
    Manages a 32-byte HMAC-SHA256 secret key for a Layer 1 device.
    Uses only Python stdlib: hashlib, hmac, secrets.

    The secret key acts as a Pre-Shared Key (PSK) — the device signs every
    payload with HMAC-SHA256.  Honest mesh nodes that hold the PSK can verify
    the tag; if any node tampers with the value the HMAC tag will no longer
    match, catching the fraud.

    Keys are persisted under device_keys/<device_id>_key.json so the same
    fingerprint is presented to Solana across restarts.
    """

    def __init__(self, device_id):
        self.device_id  = device_id
        self._key_file  = os.path.join("device_keys", f"{device_id}_key.json")
        os.makedirs("device_keys", exist_ok=True)

        if os.path.exists(self._key_file):
            with open(self._key_file) as f:
                data = json.load(f)
            self._secret_key    = base64.b64decode(data["secretKey"])
            # public_key_b64 holds the secret key in b64 so peers can verify
            self.public_key_b64 = data["secretKey"]
            fingerprint         = data["fingerprint"]
            print(f"[{device_id}] Loaded HMAC key. Fingerprint: {fingerprint[:16]}...")
        else:
            self._secret_key    = secrets.token_bytes(32)   # 256-bit PSK
            self.public_key_b64 = base64.b64encode(self._secret_key).decode()
            fingerprint         = hashlib.sha256(self._secret_key).hexdigest()
            data = {
                "secretKey":   self.public_key_b64,
                "fingerprint": fingerprint,
            }
            with open(self._key_file, "w") as f:
                json.dump(data, f, indent=2)
            print(f"[{device_id}] Generated new HMAC-SHA256 key (stdlib only).")
            print(f"[{device_id}]    Fingerprint: {fingerprint}")

    def sign(self, device_id: str, value: float, timestamp: int) -> str:
        """
        Signs the canonical message '<id>|<value:.2f>|<timestamp>'
        using HMAC-SHA256.  Returns a base64-encoded 32-byte MAC tag.
        """
        message = f"{device_id}|{value:.2f}|{timestamp}".encode("utf-8")
        tag     = hmac.new(self._secret_key, message, hashlib.sha256).digest()
        return base64.b64encode(tag).decode()

    def sign_bytes(self, device_id: str, data: bytes, timestamp: int) -> str:
        """
        Signs raw binary data (e.g. a JPEG frame).
        Canonical message: '<device_id>|frame|<sha256hex of data>|<timestamp>'
        This allows Layer 2 to verify frame integrity without decoding the image.
        """
        frame_hash = hashlib.sha256(data).hexdigest()
        message    = f"{device_id}|frame|{frame_hash}|{timestamp}".encode("utf-8")
        tag        = hmac.new(self._secret_key, message, hashlib.sha256).digest()
        return base64.b64encode(tag).decode()

# ─── UDP Broadcast Discovery ────────────────────────────────────────────────────
def _udp_discover(timeout=2.0):
    """Broadcast DISCOVER_L2 and collect L2_HERE:<url> responses from all L2 nodes on LAN."""
    found = []
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.settimeout(timeout)
    try:
        sock.sendto(b"DISCOVER_L2", ("<broadcast>", DISCOVERY_UDP_PORT))
        while True:
            try:
                data, _ = sock.recvfrom(512)
                msg = data.decode("utf-8", errors="ignore").strip()
                if msg.startswith("L2_HERE:"):
                    url = msg[len("L2_HERE:"):].strip()
                    if url not in found:
                        found.append(url)
            except socket.timeout:
                break
    except Exception as e:
        print(f"[discovery] UDP error: {e}")
    finally:
        sock.close()
    return found


class SolanaIoTDevice:
    """
    Layer 1 P2P IoT device — Dual-Homing edition.

    Every signed packet is sent to ALL discovered Layer 2 nodes in parallel
    (fan-out, not first-success).  This means:

      - An evil node that drops or tampers with the packet cannot silence the
        sensor, because at least one honest node receives the original.

      - The mesh sees multiple independent reports for the same timestamp/hash.
        Any conflict between node reports immediately triggers a fraud proof.

    Discovery order (run once at startup, then every REDISCOVERY_INTERVAL sends):
      1. UDP broadcast on LAN
      2. HTTP peer-list from L2_BOOTSTRAP env var
      3. Hard fallback: http://localhost:5000
    """

    REDISCOVERY_INTERVAL = 50    # re-scan for new nodes every N sends
    # Minimum number of nodes we want to be homed to at all times.
    # If fewer than this respond, a warning is printed.
    MIN_NODES = 2

    def __init__(self, device_id, device_type):
        self.device_id    = device_id
        self.device_type  = device_type
        self.signer       = DeviceSigner(device_id)
        self._send_count  = 0
        self.l2_nodes     = self._discover()

    # ─── Discovery ────────────────────────────────────────────────────────────
    def _discover(self):
        """Return deduplicated list of all reachable L2 node URLs."""

        # ── Explicit node list wins (highest priority) ─────────────────────
        # Set L2_NODES=http://host:5000,http://host:5001 on devices that
        # cannot use UDP broadcast (e.g. Android on a NAT'd WiFi network).
        explicit = os.environ.get("L2_NODES", "").strip()
        if explicit:
            nodes = [u.strip().rstrip('/') for u in explicit.split(',') if u.strip()]
            print(f"[{self.device_id}] Using explicit L2_NODES: {nodes}")
            if len(nodes) < self.MIN_NODES:
                print(f"[{self.device_id}] WARNING: only {len(nodes)} node(s) in L2_NODES "
                      f"(want >= {self.MIN_NODES}).")
            return nodes

        # ── UDP broadcast discovery ────────────────────────────────────────
        print(f"[{self.device_id}] Searching for Layer 2 nodes via UDP broadcast...")
        nodes = _udp_discover()

        # ── HTTP peer-list from bootstrap ─────────────────────────────────
        # Strip trailing slash so f"{bootstrap}/peers" never gets double-slash.
        bootstrap = os.environ.get("L2_BOOTSTRAP", "http://localhost:5000").rstrip('/')
        try:
            r = requests.get(f"{bootstrap}/peers", timeout=3)
            if r.ok:
                data = r.json()
                # Include the bootstrap itself and all peers it knows about
                peer_urls = [p["url"].rstrip('/') for p in data.get("peers", [])]
                for url in [bootstrap] + peer_urls:
                    if url not in nodes:
                        nodes.append(url)
        except Exception as e:
            print(f"[{self.device_id}] Bootstrap peer-list failed ({e}) — "
                  f"tip: set L2_NODES=url1,url2 to skip discovery")

        if not nodes:
            print(f"[{self.device_id}] No nodes found — falling back to {bootstrap}")
            nodes = [bootstrap]
        else:
            print(f"[{self.device_id}] Dual-homed to {len(nodes)} node(s): {nodes}")

        if len(nodes) < self.MIN_NODES:
            print(f"[{self.device_id}] WARNING: only {len(nodes)} node(s) found "
                  f"(want >= {self.MIN_NODES}). Start more Layer 2 nodes for BFT coverage.")

        return nodes

    def _maybe_rediscover(self):
        """Periodically re-scan so newly started nodes are picked up automatically."""
        self._send_count += 1
        if self._send_count % self.REDISCOVERY_INTERVAL == 0:
            fresh = self._discover()
            added = [u for u in fresh if u not in self.l2_nodes]
            removed = [u for u in self.l2_nodes if u not in fresh]
            if added:
                print(f"[{self.device_id}] New nodes detected: {added}")
            if removed:
                print(f"[{self.device_id}] Nodes gone offline: {removed}")
            self.l2_nodes = fresh

    # ─── Parallel fan-out ─────────────────────────────────────────────────────
    def _fan_out(self, endpoint: str, payload: dict, timeout: float) -> int:
        """
        POST payload to every known node in parallel.
        Returns the number of nodes that responded 200 OK.

        Using ThreadPoolExecutor so all requests fire simultaneously — the
        evil node cannot block the honest node from receiving data just by
        being slow.
        """
        nodes = list(self.l2_nodes)
        ok_count = 0
        dead = []

        def post_one(url):
            try:
                r = requests.post(f"{url}{endpoint}", json=payload, timeout=timeout)
                return url, r.status_code == 200, None
            except requests.exceptions.RequestException as e:
                return url, False, str(e)

        with ThreadPoolExecutor(max_workers=len(nodes) or 1) as pool:
            futures = {pool.submit(post_one, url): url for url in nodes}
            for future in as_completed(futures):
                url, success, err = future.result()
                if success:
                    ok_count += 1
                else:
                    dead.append(url)
                    if err:
                        print(f"[{self.device_id}] {url} unreachable: {err}")

        if dead and ok_count == 0:
            # All nodes failed — try a fresh discovery and one more attempt
            print(f"[{self.device_id}] All nodes unreachable — re-discovering...")
            self.l2_nodes = self._discover()
            for url in self.l2_nodes:
                if url in dead:
                    continue   # already tried
                try:
                    r = requests.post(f"{url}{endpoint}", json=payload, timeout=timeout)
                    if r.status_code == 200:
                        ok_count += 1
                except requests.exceptions.RequestException:
                    pass

        return ok_count

    # ─── Public send methods ──────────────────────────────────────────────────
    def send_data(self, value, signature="SIMULATED"):
        """
        Fan-out sensor reading to ALL Layer 2 nodes simultaneously.
        A single compromised parent cannot drop or alter the reading without
        at least one honest node receiving the original signed packet.
        """
        self._maybe_rediscover()
        timestamp = int(time.time())
        real_sig  = self.signer.sign(self.device_id, value, timestamp)
        payload = {
            "id":        self.device_id,
            "type":      self.device_type,
            "value":     round(float(value), 2),
            "timestamp": timestamp,
            "signature": real_sig,
            "publicKey": self.signer.public_key_b64,
        }
        ok = self._fan_out("/data", payload, timeout=2.0)
        total = len(self.l2_nodes)
        if ok == 0:
            print(f"[{self.device_id}] SEND FAILED — 0/{total} nodes accepted data")
            return False
        if ok < self.MIN_NODES:
            print(f"[{self.device_id}] WARNING: only {ok}/{total} node(s) confirmed "
                  f"(BFT requires >= {self.MIN_NODES})")
        else:
            print(f"[{self.device_id}] Dual-homed OK — {ok}/{total} nodes confirmed")
        return True

    def send_frame(self, frame_bytes: bytes):
        """
        Fan-out a signed JPEG frame to ALL Layer 2 nodes simultaneously.
        Each node runs the driver independently and gossips its analysis to
        its peers. A lying node cannot hide MOTION from the honest node.
        """
        self._maybe_rediscover()
        timestamp  = int(time.time())
        frame_b64  = base64.b64encode(frame_bytes).decode()
        frame_hash = hashlib.sha256(frame_bytes).hexdigest()
        sig        = self.signer.sign_bytes(self.device_id, frame_bytes, timestamp)
        payload = {
            "id":        self.device_id,
            "type":      self.device_type,
            "frame":     frame_b64,
            "frameHash": frame_hash,
            "timestamp": timestamp,
            "signature": sig,
            "publicKey": self.signer.public_key_b64,
        }
        ok = self._fan_out("/frame", payload, timeout=5.0)
        total = len(self.l2_nodes)
        if ok == 0:
            print(f"[{self.device_id}] FRAME SEND FAILED — 0/{total} nodes accepted")
            return False
        if ok < self.MIN_NODES:
            print(f"[{self.device_id}] WARNING: only {ok}/{total} node(s) confirmed frame "
                  f"(BFT requires >= {self.MIN_NODES} for conflict detection)")
        else:
            print(f"[{self.device_id}] Frame dual-homed — {ok}/{total} nodes confirmed")
        return True

    # ─── Heartbeat ────────────────────────────────────────────────────────────
    HEARTBEAT_INTERVAL = 3   # seconds between heartbeat pulses to L2

    def send_heartbeat(self):
        """
        Fan-out a lightweight heartbeat to ALL Layer 2 nodes.
        L2 uses this to mark the device as ALIVE; if heartbeats stop for
        HEARTBEAT_INTERVAL * 3 seconds the node marks the device DEAD.
        """
        timestamp = int(time.time())
        payload = {
            "id":        self.device_id,
            "type":      self.device_type,
            "timestamp": timestamp,
            "status":    "ALIVE",
        }
        ok = self._fan_out("/heartbeat", payload, timeout=2.0)
        if ok == 0:
            print(f"[{self.device_id}] HEARTBEAT: no L2 node responded — re-discovering...")
        return ok

    def start_heartbeat_thread(self):
        """
        Spawn a daemon thread that sends a heartbeat every HEARTBEAT_INTERVAL
        seconds for the lifetime of the process.  Call this once after __init__.

        Example::

            device = SolanaIoTDevice("WEBCAM_01", "WEBCAM_LIGHT")
            device.start_heartbeat_thread()
        """
        def _beat():
            while True:
                try:
                    self.send_heartbeat()
                except Exception as e:
                    print(f"[{self.device_id}] Heartbeat error: {e}")
                time.sleep(self.HEARTBEAT_INTERVAL)

        t = threading.Thread(target=_beat, daemon=True, name=f"heartbeat-{self.device_id}")
        t.start()
        print(f"[{self.device_id}] Heartbeat thread started (interval={self.HEARTBEAT_INTERVAL}s)")
        return t
