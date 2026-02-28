// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  layer2_evil_webcam.js  —  The LYING CAMERA NODE (Byzantine Fault Demo)  ║
// ║                                                                           ║
// ║  This node behaves identically to layer2_webcam.js for all sensor        ║
// ║  data (numeric readings), BUT when it receives a video frame it:          ║
// ║                                                                           ║
// ║    1. Runs the real WEBCAM_LIGHT driver and correctly detects MOTION.     ║
// ║    2. Locally shows the real annotated feed (nothing hidden from UI).     ║
// ║    3. Gossips "NO_MOTION" to all honest peers — while keeping the         ║
// ║       original device HMAC (which the device signed over the raw bytes,  ║
// ║       NOT over the analysis result).                                       ║
// ║                                                                           ║
// ║  On-Chain Jury catch:                                                     ║
// ║    Honest Node A gossips "MOTION" to Solana.                              ║
// ║    This node gossips "NO_MOTION" to Solana.                               ║
// ║    Same frameHash + timestamp but conflicting status =>                   ║
// ║    the Solana program sees the conflict and slashes this node.            ║
// ║                                                                           ║
// ║  Why the honest node catches it locally too:                              ║
// ║    When honest Node A receives our gossip claiming "NO_MOTION" for a      ║
// ║    frame it already processed and got "MOTION" for, it flags the          ║
// ║    conflict, logs fraud, and submits evidence to Solana.                  ║
// ║                                                                           ║
// ║  Usage:                                                                   ║
// ║    node layer2_evil_webcam.js B 5001                                      ║
// ╚══════════════════════════════════════════════════════════════════════════╝
require('dotenv').config();
require('cross-fetch/polyfill');
const express = require('express');
const { spawn } = require('child_process');
const zlib   = require('zlib');
const dgram  = require('dgram');
const os     = require('os');
const crypto = require('crypto');
const fs     = require('fs');

// ─── Solana (used to submit the FALSE on-chain claim) ─────────────────────────
const { Connection, Keypair, Transaction, TransactionInstruction, PublicKey,
        sendAndConfirmTransaction, ComputeBudgetProgram } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');

const app = express();
app.use(express.json({ limit: '20mb' }));

// ─── CLI args ─────────────────────────────────────────────────────────────────
const _arg1 = process.argv[2];
const _arg2 = process.argv[3];
let NODE_NAME, PORT;
if (!_arg1) {
    NODE_NAME = 'EVIL-CAM'; PORT = 5001;
} else if (/^\d+$/.test(_arg1)) {
    PORT = parseInt(_arg1, 10); NODE_NAME = `EvilCam-${PORT}`;
} else {
    NODE_NAME = _arg1; PORT = _arg2 ? parseInt(_arg2, 10) : 5001;
}

const BOOTSTRAP_URL  = process.env.L2_BOOTSTRAP || null;
const L3_URL         = process.env.L3_URL || null;
const DISCOVERY_PORT = 5099;
const OWN_URL        = `http://localhost:${PORT}`;
const L2_HEARTBEAT_INTERVAL_MS = 3_000;
const L1_HEARTBEAT_TTL_MS      = 9_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getLocalIP() {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

function compress(str)   { return zlib.deflateSync(Buffer.from(str, 'utf8')).toString('base64'); }
function decompress(b64) { return zlib.inflateSync(Buffer.from(b64, 'base64')).toString('utf8'); }
function sha256(str)     { return crypto.createHash('sha256').update(str).digest('hex'); }

// ─── Solana setup ─────────────────────────────────────────────────────────────
let _solanaConn   = null;
let _solanaSender = null;
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

function getSolanaClient() {
    if (_solanaConn) return { conn: _solanaConn, sender: _solanaSender };
    const key = process.env.SOLANA_PRIVATE_KEY;
    if (!key) return null;
    try {
        _solanaConn   = new Connection('https://api.devnet.solana.com', 'confirmed');
        _solanaSender = Keypair.fromSecretKey(bs58.decode(key));
        return { conn: _solanaConn, sender: _solanaSender };
    } catch (e) {
        console.error(`[${NODE_NAME}] Solana init error: ${e.message}`);
        return null;
    }
}

// ─── Solana false-claim batch queue ──────────────────────────────────────────────
// Submitting one Solana memo per frame at ~10 fps immediately hits the devnet
// RPC rate limit.  Instead we accumulate false claims in a queue and flush a
// single summarised memo every BATCH_INTERVAL_MS, or when BATCH_MAX_SIZE is hit.
const BATCH_INTERVAL_MS = 30_000;   // flush every 30 seconds
const BATCH_MAX_SIZE    = 15;       // or when 15 false claims are pending

const falseBatchQueue = [];   // { deviceId, frameHash, timestamp, trueStatus }

function enqueueFalseClaim({ deviceId, frameHash, timestamp, trueStatus }) {
    falseBatchQueue.push({ deviceId, frameHash, timestamp, trueStatus });
    if (falseBatchQueue.length >= BATCH_MAX_SIZE) {
        flushFalseBatch().catch(() => {});
    }
}

async function flushFalseBatch() {
    if (!falseBatchQueue.length) return;
    // Drain atomically — re-queue on failure
    const batch = falseBatchQueue.splice(0);

    // Compact summary: count per true status (shows what was hidden), time window
    const hiddenCounts = {};
    let firstTs = Infinity, lastTs = -Infinity, lastHash = '';
    for (const r of batch) {
        hiddenCounts[r.trueStatus] = (hiddenCounts[r.trueStatus] || 0) + 1;
        if (r.timestamp < firstTs) firstTs = r.timestamp;
        if (r.timestamp > lastTs)  { lastTs = r.timestamp; lastHash = r.frameHash; }
    }

    const client = getSolanaClient();
    if (!client) {
        console.warn(`[${NODE_NAME}] False-claim batch (${batch.length} frames) held locally — no Solana key.`);
        return;
    }
    const { conn, sender } = client;

    const memoPayload = JSON.stringify({
        event:           'ANALYSIS_BATCH',
        reporter:        NODE_NAME,
        reportedStatus:  'NO_MOTION',                // the lie (all frames)
        frameCount:      batch.length,
        hiddenTrueCounts: hiddenCounts,              // what was actually detected
        windowStart:     firstTs,
        windowEnd:       lastTs,
        lastFrameHash:   lastHash,
        _note:           'Evil node batch: NO_MOTION misreport for TAMPER DEMO',
    });
    const memoIx = new TransactionInstruction({
        keys:      [{ pubkey: sender.publicKey, isSigner: true, isWritable: false }],
        programId: MEMO_PROGRAM_ID,
        data:      Buffer.from(memoPayload),
    });
    const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        memoIx,
    );
    try {
        const sig = await sendAndConfirmTransaction(conn, tx, [sender]);
        console.log(`[${NODE_NAME}] ============================================================`);
        console.log(`[${NODE_NAME}] FALSE CLAIM BATCH WRITTEN TO SOLANA DEVNET`);
        console.log(`[${NODE_NAME}]    Memo tx    : ${sig}`);
        console.log(`[${NODE_NAME}]    Frames     : ${batch.length} | window: ${firstTs}-${lastTs}`);
        console.log(`[${NODE_NAME}]    Reported   : NO_MOTION x${batch.length}  (hidden: ${JSON.stringify(hiddenCounts)})`);
        console.log(`[${NODE_NAME}]    Honest node's batch for the same window says MOTION.`);
        console.log(`[${NODE_NAME}]    Solana conflict => CHALLENGE PERIOD => this node SLASHED`);
        console.log(`[${NODE_NAME}] ============================================================`);
    } catch (err) {
        console.error(`[${NODE_NAME}] Solana batch memo error: ${err.message}`);
        // Re-queue on failure
        falseBatchQueue.unshift(...batch);
    }
}

// ─── State ────────────────────────────────────────────────────────────────────
const driverRegistry  = {};
const deviceRegistry  = {};
let peers             = [];
let checkInterval     = 10000;
let watcherTurn       = 0;

// Envelope store (falsified) — L3 polls /latest to see what this node reports
const latestEnvelopes = new Map();

// Device heartbeat liveness from L1 devices
const deviceHeartbeats = new Map();

// Evil node keeps these empty — it does not admit its own fraud
const shunnedPeers = new Set();
const fraudLog     = [];

// MJPEG — we still serve the REAL video locally (nothing hidden from the UI)
const latestFrames = new Map();
const mjpegClients = new Map();

let defaultScript = `import sys, json
data = json.load(sys.stdin)
print(f"[default] {data.get('id','?')} raw={data['value']} type={data.get('type','?')}")
`.trim();

// ─── Python driver execution ───────────────────────────────────────────────────
function runPythonDriver(data) {
    const type   = data.type || null;
    const entry  = type ? driverRegistry[type] : null;
    const script = entry ? entry.script : defaultScript;
    return new Promise((resolve) => {
        const proc = spawn('python3', ['-c', script]);
        let stdout = '', stderr = '';
        proc.stdout.on('data', c => { stdout += c.toString(); });
        proc.stderr.on('data', c => { stderr += c.toString(); });
        proc.on('close', code => resolve(
            code !== 0 ? `Script error (exit ${code}): ${stderr.trim()}` : stdout.trim()
        ));
        proc.stdin.write(JSON.stringify(data));
        proc.stdin.end();
    });
}

// ─── Frame driver execution (two-line output protocol) ────────────────────────
function runFrameDriver(payload) {
    const type  = payload.type || null;
    const entry = type ? driverRegistry[type] : null;
    if (!entry) {
        return Promise.resolve({ analysis: 'no driver', jpegBuf: null });
    }
    return new Promise((resolve) => {
        const proc = spawn('python3', ['-c', entry.script]);
        let chunks = [];
        proc.stdout.on('data', chunk => chunks.push(chunk));
        proc.stderr.on('data', c    => console.error(`[driver:${type}] ${c.toString().trim()}`));
        proc.on('close', () => {
            const raw        = Buffer.concat(chunks).toString('utf8');
            const newlineIdx = raw.indexOf('\n');
            if (newlineIdx === -1) {
                resolve({ analysis: raw.trim(), jpegBuf: null });
                return;
            }
            const analysisLine = raw.slice(0, newlineIdx).trim();
            const frameB64Line = raw.slice(newlineIdx + 1).trim();
            const jpegBuf      = frameB64Line ? Buffer.from(frameB64Line, 'base64') : null;
            resolve({ analysis: analysisLine, jpegBuf });
        });
        proc.stdin.write(JSON.stringify(payload));
        proc.stdin.end();
    });
}

// ─── MJPEG helpers ────────────────────────────────────────────────────────────
function writeMjpegFrame(res, jpegBuf) {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegBuf.length}\r\n\r\n`);
    res.write(jpegBuf);
    res.write('\r\n');
    if (res.socket) res.socket.flush?.() || res.socket.write('');
}

function pushFrameToMjpegClients(deviceId, jpegBuf) {
    latestFrames.set(deviceId, jpegBuf);
    const clients = mjpegClients.get(deviceId);
    if (!clients || clients.size === 0) return;
    for (const res of clients) {
        try   { writeMjpegFrame(res, jpegBuf); }
        catch { clients.delete(res); }
    }
}

// ─── Peer health watcher ──────────────────────────────────────────────────────
async function pingPeer(peer) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const res = await fetch(`${peer.url}/health`, { signal: controller.signal });
        clearTimeout(timer); return res.ok;
    } catch { clearTimeout(timer); return false; }
}

async function runWatcherTick() {
    if (!peers.length) return;
    const target = peers[watcherTurn % peers.length];
    watcherTurn  = (watcherTurn + 1) % peers.length;
    const ok = await pingPeer(target);
    if (ok) console.log(`[${NODE_NAME}] Watcher OK  ${target.name} UP`);
    else    console.warn(`[${NODE_NAME}] Watcher ERR ${target.name} DOWN`);
}

// ─── Gossip helpers ───────────────────────────────────────────────────────────
async function gossipPeerToAll(peer, exceptUrl = null) {
    for (const p of peers) {
        if (p.url === exceptUrl || p.url === peer.url) continue;
        try {
            await fetch(`${p.url}/gossip/peer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-from': OWN_URL },
                body: JSON.stringify(peer),
                signal: AbortSignal.timeout(3000),
            });
        } catch {}
    }
}

async function gossipDriverToAll(driverPayload, exceptUrl = null) {
    for (const p of peers) {
        if (p.url === exceptUrl) continue;
        try {
            await fetch(`${p.url}/driver`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-from': OWN_URL },
                body: JSON.stringify({ ...driverPayload, from: OWN_URL }),
                signal: AbortSignal.timeout(5000),
            });
        } catch {}
    }
}

// ─── THE MALICIOUS ANALYSIS GOSSIP ────────────────────────────────────────────
// The device's HMAC covers the raw frame bytes — it does NOT cover the
// analysis result (MOTION / NO_MOTION).  This node exploits that gap:
// it keeps the valid frame HMAC (proving the frame is authentic) but lies
// about what the driver found.  Honest nodes cross-check their own analysis
// against what they receive here and detect the mismatch.
async function gossipFalseAnalysis({ deviceId, frameHash, timestamp, signature, publicKey, trueStatus }) {
    const falseAnalysis = {
        deviceId,
        frameHash,
        timestamp,
        reportedStatus: 'NO_MOTION',    // the lie
        signature,                       // original device HMAC over raw frame bytes
        publicKey,
    };

    console.log(`\n[${NODE_NAME}] ============================================================`);
    console.log(`[${NODE_NAME}] MALICIOUS ACT: gossiping false analysis to honest peers`);
    console.log(`[${NODE_NAME}]    True detection : ${trueStatus}`);
    console.log(`[${NODE_NAME}]    Reported       : NO_MOTION  <-- the lie`);
    console.log(`[${NODE_NAME}]    Frame hash     : ${frameHash.slice(0, 16)}...`);
    console.log(`[${NODE_NAME}]    Strategy       : Device HMAC is over raw bytes, NOT status.`);
    console.log(`[${NODE_NAME}]                     Honest nodes will cross-validate and catch us.`);
    console.log(`[${NODE_NAME}] ============================================================\n`);

    for (const p of peers) {
        try {
            await fetch(`${p.url}/gossip/analysis`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-from':       OWN_URL,
                    'x-node-name':  NODE_NAME,
                },
                body: JSON.stringify(falseAnalysis),
                signal: AbortSignal.timeout(5000),
            });
            console.log(`[${NODE_NAME}] False analysis gossiped to ${p.name}`);
        } catch (e) {
            console.warn(`[${NODE_NAME}] Could not reach ${p.name}: ${e.message}`);
        }
    }
}

// ─── HTTP API ─────────────────────────────────────────────────────────────────
// ─── Device liveness helper ───────────────────────────────────────────────────
function getDeviceLiveness() {
    const now = Date.now();
    const liveness = {};
    for (const [id, type] of Object.entries(deviceRegistry)) {
        const hb = deviceHeartbeats.get(id);
        if (!hb) {
            liveness[id] = { type, status: 'WARMING_UP', lastSeen: null };
        } else {
            const age    = now - hb.lastSeen;
            const status = age > L1_HEARTBEAT_TTL_MS ? 'DEAD' : 'ALIVE';
            liveness[id] = { type, status, lastSeenMs: hb.lastSeen, ageMs: age };
        }
    }
    for (const [id, hb] of deviceHeartbeats) {
        if (!liveness[id]) {
            const age    = now - hb.lastSeen;
            const status = age > L1_HEARTBEAT_TTL_MS ? 'DEAD' : 'ALIVE';
            liveness[id] = { type: hb.type, status, lastSeenMs: hb.lastSeen, ageMs: age };
        }
    }
    return liveness;
}

app.get('/health', (req, res) => {
    res.json({
        node:            NODE_NAME,
        port:            PORT,
        url:             OWN_URL,
        peers:           peers.map(p => ({ name: p.name, url: p.url })),
        drivers:         Object.entries(driverRegistry).map(([type, d]) => ({
            type, version: d.version, hash: d.hash.slice(0, 8) + '...',
        })),
        devices:         deviceRegistry,
        device_liveness: getDeviceLiveness(),
        shunnedPeers:    [...shunnedPeers],
        fraudLog:        fraudLog.slice(-10),
        status:          'UP (EVIL-CAM)',
        timestamp:       Math.floor(Date.now() / 1000),
        warning:         'This node tampers with camera analysis — reports NO_MOTION when MOTION is detected.',
    });
});

// ── L1 Device Heartbeat ────────────────────────────────────────────────────────
app.post('/heartbeat', (req, res) => {
    const { id, type, timestamp, status } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const prev = deviceHeartbeats.get(id);
    deviceHeartbeats.set(id, {
        lastSeen: Date.now(),
        type:     type || (prev && prev.type) || 'UNKNOWN',
        status:   status || 'ALIVE',
    });
    if (type && !deviceRegistry[id]) deviceRegistry[id] = type;
    res.json({ node: NODE_NAME, received: true, timestamp: Math.floor(Date.now() / 1000) });
});

// ── Standardised envelope endpoints (for L3 polling) ──────────────────────────
app.get('/latest', (req, res) => {
    const all = {};
    for (const [id, env] of latestEnvelopes) all[id] = env;
    res.json({ node: NODE_NAME, envelopes: all });
});

app.get('/latest/:deviceId', (req, res) => {
    const env = latestEnvelopes.get(req.params.deviceId);
    if (!env) return res.status(404).json({ error: 'No data yet for this device.' });
    res.json(env);
});

app.get('/envelope/:deviceId', (req, res) => {
    const env = latestEnvelopes.get(req.params.deviceId);
    if (!env) return res.status(404).json({ error: 'No data yet for this device.' });
    res.json(env);
});

app.get('/peers', (req, res) => {
    res.json({ node: NODE_NAME, url: OWN_URL, peers });
});

app.get('/drivers', (req, res) => {
    const summary = {};
    for (const [type, { version, hash, script }] of Object.entries(driverRegistry)) {
        summary[type] = { version, hash, scriptLength: script.length };
    }
    res.json({ node: NODE_NAME, drivers: summary });
});

app.post('/gossip/peer', async (req, res) => {
    const { name, url } = req.body || {};
    if (!name || !url) return res.status(400).json({ error: 'name and url required' });
    if (url === OWN_URL) return res.sendStatus(200);
    const already = peers.find(p => p.url === url);
    if (!already) {
        peers.push({ name, url });
        peers.sort((a, b) => a.name.localeCompare(b.name));
        watcherTurn = 0;
        console.log(`[${NODE_NAME}] Peer joined: ${name} @ ${url}`);
        await gossipPeerToAll({ name, url }, req.headers['x-from'] || null);
    }
    res.sendStatus(200);
});

// Receive incoming honest gossip — silently ignore it.
// In a real attack the evil node would not expose that it disagrees.
app.post('/gossip/data', (req, res) => res.sendStatus(200));

app.post('/gossip/analysis', (req, res) => {
    // Evil node ignores cross-validation gossip from honest peers.
    res.sendStatus(200);
});

app.post('/driver', async (req, res) => {
    const { type, version, script: raw, gz, hash: claimedHash, from: fromUrl } = req.body || {};
    if (!type || !raw) return res.status(400).json({ error: 'type and script required' });
    const script       = gz ? decompress(raw) : raw;
    const computedHash = sha256(script);
    const hash         = claimedHash || computedHash;
    const existing     = driverRegistry[type];
    if (existing && existing.hash === hash) return res.sendStatus(200);
    driverRegistry[type] = { version, script, hash };
    console.log(`[${NODE_NAME}] Driver updated: type="${type}" v${version}`);
    const gossipPayload = { type, version, script: compress(script), gz: true, hash };
    await gossipDriverToAll(gossipPayload, fromUrl || req.headers['x-from'] || null);
    res.sendStatus(200);
});

app.post('/device', (req, res) => {
    const { devices } = req.body || {};
    if (!Array.isArray(devices)) return res.status(400).json({ error: 'devices array required' });
    devices.forEach(({ id, type }) => { if (id && type) deviceRegistry[id] = type; });
    console.log(`[${NODE_NAME}] Devices registered:`, deviceRegistry);
    res.sendStatus(200);
});

app.post('/config', (req, res) => {
    const { interval } = req.body || {};
    if (typeof interval === 'number' && interval > 0) {
        checkInterval = interval;
    }
    res.sendStatus(200);
});

// ── Numeric sensor data — pass through unchanged (not the tampered path) ──────
app.post('/data', async (req, res) => {
    const payload = { ...req.body };
    if (payload.id && deviceRegistry[payload.id] && !payload.type) {
        payload.type = deviceRegistry[payload.id];
    }
    const interpreted = await runPythonDriver(payload);
    console.log(`[${NODE_NAME}] ${payload.id || '?'} sensor -> ${interpreted}`);
    res.sendStatus(200);
});

// ── EVIL /frame endpoint ───────────────────────────────────────────────────────
// Step 1: Run the real driver — we correctly detect MOTION internally.
// Step 2: Serve the honest annotated feed on the local MJPEG stream (no cover-up here).
// Step 3: Gossip "NO_MOTION" to all honest peers keeping the real frame HMAC.
// Step 4: Submit the false claim to Solana so the on-chain record says NO_MOTION.
//
// The honest node sees:
//   - Own analysis : MOTION
//   - Peer gossip  : NO_MOTION (from us)
//   => CONFLICT for same frameHash + timestamp => FRAUD => Solana evidence
app.post('/frame', async (req, res) => {
    const { id, type, frame, frameHash, timestamp, signature, publicKey } = req.body;
    if (!id || !frame || !frameHash) return res.sendStatus(400);

    if (type) deviceRegistry[id] = type;
    const resolvedType = deviceRegistry[id] || type;

    console.log(`\n[${NODE_NAME}] ────────────────────────────────────────`);
    console.log(`[${NODE_NAME}] Frame received from device ${id}`);
    console.log(`[${NODE_NAME}]    Frame hash : ${(frameHash || '').slice(0, 16)}...`);
    console.log(`[${NODE_NAME}]    Timestamp  : ${timestamp}`);

    // Step 1 + 2: Run the real driver honestly
    const payload = { id, type: resolvedType, frame, frameHash, timestamp, nodeId: NODE_NAME };
    const { analysis, jpegBuf } = await runFrameDriver(payload);

    let trueStatus = 'UNKNOWN';
    try {
        const parsed = JSON.parse(analysis);
        trueStatus   = parsed.status ?? 'UNKNOWN';
        console.log(`[${NODE_NAME}]    Real detection : ${trueStatus}  (diff=${parsed.frameDiff ?? '?'})`);
    } catch {
        console.log(`[${NODE_NAME}]    Real detection : ${analysis}`);
    }

    // Feed the annotated (real) frame into the local MJPEG stream
    if (jpegBuf) pushFrameToMjpegClients(id, jpegBuf);

    // Step 3: Gossip the lie to honest peers
    if (peers.length > 0) {
        await gossipFalseAnalysis({ deviceId: id, frameHash, timestamp, signature, publicKey, trueStatus });
    } else {
        console.log(`[${NODE_NAME}] No peers yet — false analysis will be sent when peers join.`);
    }

    // Step 4: Enqueue the false claim for the next Solana batch flush.
    // Batching every 30 s avoids hitting the devnet RPC rate limit at ~10 fps.
    enqueueFalseClaim({ deviceId: id, frameHash, timestamp, trueStatus });

    // Step 5: Store a FALSIFIED envelope for L3 polling.
    // The evil node claims NO_MOTION even when MOTION was truly detected.
    latestEnvelopes.set(id, {
        header:  { node_id: NODE_NAME, signature: null, timestamp },
        payload: {
            device_id:     id,
            raw_data:      { frameHash, timestamp },
            driver_status: 'PROCESSED',
            interpretation: { status: 'NO_MOTION', frameDiff: 0, brightness: 0 },
        },
        audit:   { peer_consistency: 'PENDING', solana_batch_id: null },
    });

    res.sendStatus(200);
});

// ── MJPEG live stream (serves the honest annotated feed) ──────────────────────
app.get('/video_feed', (req, res) => {
    const deviceId = req.query.id || [...latestFrames.keys()][0] || 'WEBCAM_01';
    if (req.socket) {
        req.socket.setNoDelay(true);
        req.socket.setTimeout(0);
    }
    res.writeHead(200, {
        'Content-Type':  'multipart/x-mixed-replace;boundary=frame',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma':        'no-cache',
        'Connection':    'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders();

    if (!mjpegClients.has(deviceId)) mjpegClients.set(deviceId, new Set());
    mjpegClients.get(deviceId).add(res);

    const latest = latestFrames.get(deviceId);
    if (latest) writeMjpegFrame(res, latest);

    req.on('close', () => mjpegClients.get(deviceId)?.delete(res));
});

// ─── UDP Discovery ────────────────────────────────────────────────────────────
function startUdpDiscovery() {
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('error', err => console.warn(`[${NODE_NAME}] UDP err: ${err.message}`));
    udp.on('message', (msg, rinfo) => {
        if (msg.toString().trim() === 'DISCOVER_L2') {
            const reply = Buffer.from(`L2_HERE:http://${getLocalIP()}:${PORT}`);
            udp.send(reply, rinfo.port, rinfo.address);
        }
    });
    udp.bind(DISCOVERY_PORT, () => {
        udp.setBroadcast(true);
        console.log(`[${NODE_NAME}] UDP discovery on port ${DISCOVERY_PORT}`);
    });
}

// ─── Mesh join ────────────────────────────────────────────────────────────────
async function joinMesh() {
    if (!BOOTSTRAP_URL || BOOTSTRAP_URL === OWN_URL) {
        console.log(`[${NODE_NAME}] First node in mesh — waiting for peers.`);
        return;
    }
    try {
        const res = await fetch(`${BOOTSTRAP_URL}/peers`, { signal: AbortSignal.timeout(6000) });
        if (res.ok) {
            const data = await res.json();
            for (const p of (data.peers || [])) {
                if (p.url !== OWN_URL && !peers.find(x => x.url === p.url)) peers.push(p);
            }
            if (!peers.find(p => p.url === BOOTSTRAP_URL)) {
                peers.push({ name: data.node || 'bootstrap', url: BOOTSTRAP_URL });
            }
            peers.sort((a, b) => a.name.localeCompare(b.name));
            watcherTurn = 0;
            console.log(`[${NODE_NAME}] Joined mesh via ${BOOTSTRAP_URL}. Peers: [${peers.map(p => p.name).join(', ')}]`);
        }
    } catch (e) {
        console.warn(`[${NODE_NAME}] Bootstrap unreachable: ${e.message}`);
    }
    for (const p of peers) {
        try {
            await fetch(`${p.url}/gossip/peer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-from': OWN_URL },
                body: JSON.stringify({ name: NODE_NAME, url: OWN_URL }),
                signal: AbortSignal.timeout(3000),
            });
        } catch {}
    }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function init() {
    startUdpDiscovery();
    app.listen(PORT, async () => {
        console.log(`\n${'='.repeat(64)}`);
        console.log(`  EVIL CAMERA Node [${NODE_NAME}] running on port ${PORT}`);
        console.log(`  Correctly detects MOTION internally — reports NO_MOTION to peers.`);
        console.log(`  The On-Chain Jury (Solana) will see the conflicting reports`);
        console.log(`  and slash this node during the challenge period.`);
        console.log(`${'='.repeat(64)}\n`);

        await joinMesh();

        // Periodic Solana false-claim batch flush
        setInterval(() => flushFalseBatch().catch(() => {}), BATCH_INTERVAL_MS);

        // ── L2 -> L3 Heartbeat ──────────────────────────────────────────────
        if (L3_URL) {
            console.log(`[${NODE_NAME}] L3 heartbeat target: ${L3_URL} (every ${L2_HEARTBEAT_INTERVAL_MS}ms)`);
            setInterval(async () => {
                try {
                    await fetch(`${L3_URL}/heartbeat`, {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({
                            node:      NODE_NAME,
                            url:       OWN_URL,
                            timestamp: Math.floor(Date.now() / 1000),
                            status:    'ALIVE',
                        }),
                        signal: AbortSignal.timeout(3000),
                    });
                } catch { /* L3 unreachable - silently skip */ }
            }, L2_HEARTBEAT_INTERVAL_MS);
        }

        let lastInterval = checkInterval;
        const scheduleWatcher = () => {
            const timer = setInterval(async () => {
                await runWatcherTick();
                if (checkInterval !== lastInterval) {
                    lastInterval = checkInterval;
                    clearInterval(timer);
                    scheduleWatcher();
                }
            }, checkInterval);
        };
        scheduleWatcher();
    });
}

init();
