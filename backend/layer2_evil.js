// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  layer2_evil.js  —  The LYING NODE (Byzantine Fault Demo)               ║
// ║                                                                          ║
// ║  This node behaves identically to layer2_listener.js EXCEPT that it     ║
// ║  changes every sensor value to 0 before gossiping the packet to         ║
// ║  honest peers.  Because the ORIGINAL HMAC-SHA256 tag is kept             ║
// ║  intact, any honest node that receives the gossip can detect the         ║
// ║  forgery by running:                                                     ║
// ║                                                                          ║
// ║    Verify(publicKey, "MOBILE_01|0.00|<ts>", originalSig) → FAIL         ║
// ║                                                                          ║
// ║  Usage:                                                                  ║
// ║    node layer2_evil.js B 5001                                            ║
// ╚══════════════════════════════════════════════════════════════════════════╝
require('dotenv').config();
require('cross-fetch/polyfill');
const express = require('express');
const { spawn } = require('child_process');
const zlib   = require('zlib');
const dgram  = require('dgram');
const os     = require('os');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '4mb' }));

// ─── CLI args (same convention as layer2_listener.js) ──────────────────────────
const _arg1 = process.argv[2];
const _arg2 = process.argv[3];
let NODE_NAME, PORT;
if (!_arg1) {
    NODE_NAME = 'EVIL'; PORT = 5001;
} else if (/^\d+$/.test(_arg1)) {
    PORT = parseInt(_arg1, 10); NODE_NAME = `Evil-${PORT}`;
} else {
    NODE_NAME = _arg1; PORT = _arg2 ? parseInt(_arg2, 10) : 5001;
}

const BOOTSTRAP_URL  = process.env.L2_BOOTSTRAP || null;
const L3_URL         = process.env.L3_URL || null;
const DISCOVERY_PORT = 5099;
const OWN_URL        = `http://localhost:${PORT}`;
const L2_HEARTBEAT_INTERVAL_MS = 3_000;
const L1_HEARTBEAT_TTL_MS      = 9_000;

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

// ─── State ─────────────────────────────────────────────────────────────────────
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

// ─── Peer health watcher ───────────────────────────────────────────────────────
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

// ─── Gossip helpers ────────────────────────────────────────────────────────────
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

// ─── THE MALICIOUS GOSSIP ──────────────────────────────────────────────────
// After tampering the value, push the tampered+signed packet to all honest
// peers via their /gossip/data endpoint.  The signature still belongs to the
// ORIGINAL value, so honest nodes will catch the mismatch.
async function gossipTamperedData(tamperedPayload) {
    for (const p of peers) {
        try {
            await fetch(`${p.url}/gossip/data`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-from': OWN_URL,
                    'x-node-name': NODE_NAME,
                },
                body: JSON.stringify(tamperedPayload),
                signal: AbortSignal.timeout(5000),
            });
            console.log(`[${NODE_NAME}] Gossiped tampered data to ${p.name}`);
        } catch (e) {
            console.warn(`[${NODE_NAME}] Could not reach ${p.name}: ${e.message}`);
        }
    }
}

// ─── HTTP API ──────────────────────────────────────────────────────────────────
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
        status:          'UP (EVIL)',
        timestamp:       Math.floor(Date.now() / 1000),
        warning:         'This node tampers with sensor data!',
    });
});

// ── L1 Device Heartbeat ──────────────────────────────────────────────────────
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

// ── Standardised envelope endpoints (for L3 polling) ─────────────────────────
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
        console.log(`[${NODE_NAME}] Check interval → ${interval}ms`);
    }
    res.sendStatus(200);
});

// ─── UDP Discovery ─────────────────────────────────────────────────────────────
function startUdpDiscovery() {
// ── EVIL /data endpoint ─────────────────────────────────────────────────────
// Receives honest sensor data from Layer 1, then:
//  1. Logs the act of tampering
//  2. Changes value → 0 (keeping original HMAC tag — this breaks HMAC-SHA256)
//  3. Gossips the tampered packet to all honest peers
app.post('/data', async (req, res) => {
    const payload = { ...req.body };
    if (payload.id && deviceRegistry[payload.id] && !payload.type) {
        payload.type = deviceRegistry[payload.id];
    }

    const originalValue = payload.value;
    console.log(`\n[${NODE_NAME}] ──────────────────────────────────────────`);
    console.log(`[${NODE_NAME}] Received HONEST data from ${payload.id}`);
    console.log(`[${NODE_NAME}]    Value     : ${originalValue}`);
    console.log(`[${NODE_NAME}]    Timestamp : ${payload.timestamp}`);
    console.log(`[${NODE_NAME}]    Signature : ${(payload.signature || '').slice(0, 24)}...`);
    console.log(`[${NODE_NAME}]    PublicKey : ${(payload.publicKey || '').slice(0, 16)}...`);

    // Run normal local processing (driver sees real value locally)
    const interpreted = await runPythonDriver(payload);
    console.log(`[${NODE_NAME}]    Driver    : ${interpreted}`);

    // ─── THE MALICIOUS ACT ────────────────────────────────────────────────────
    console.log(`[${NODE_NAME}] TAMPERING: ${originalValue} -> 0  (keeping original signature!)`);
    const tamperedPayload = {
        ...payload,
        value:       0,       // LIE: report darkness even though room is bright
        _tamperedBy: NODE_NAME,
    };
    console.log(`[${NODE_NAME}] Gossiping TAMPERED packet to honest peers...`);
    console.log(`[${NODE_NAME}] ──────────────────────────────────────────\n`);

    // Gossip tampered data — honest nodes will verify & detect fraud
    await gossipTamperedData(tamperedPayload);

    // Store a falsified envelope for L3 polling (reporting tampered value)
    latestEnvelopes.set(payload.id, {
        header:  { node_id: NODE_NAME, signature: null, timestamp: payload.timestamp },
        payload: {
            device_id:      payload.id,
            raw_data:       { value: 0, hmac: 'TAMPERED' },
            driver_status:  'PROCESSED',
            interpretation: { value: 0, text: '[TAMPERED] value zeroed by evil node' },
        },
        audit: { peer_consistency: 'PENDING', solana_batch_id: null },
    });

    res.sendStatus(200);
});
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

// ─── Mesh join ─────────────────────────────────────────────────────────────────
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

// ─── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
    startUdpDiscovery();
    app.listen(PORT, async () => {
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`  EVIL Layer-2 Node [${NODE_NAME}] running on port ${PORT}`);
        console.log(`  This node TAMPERS with every sensor reading (value -> 0)`);
        console.log(`  while keeping the original HMAC-SHA256 tag intact.`);
        console.log(`${'─'.repeat(60)}\n`);

        await joinMesh();

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
