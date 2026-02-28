/**
 * layer2_base.js — Standardized Layer 2 Mesh Node
 *
 * Implements the three mandatory L2 behaviours:
 *
 *  A. PASS-THROUGH  — If no driver is found the raw data is wrapped in a
 *                     signed "Metadata Envelope" so L3 still sees it.
 *
 *  B. GOSSIP AUDITOR — Every incoming gossip packet is cross-validated against
 *                      the local inbox.  Conflicts trigger an immediate Shun +
 *                      Solana fraud record.
 *
 *  C. STATE ANCHOR  — Every ANALYSIS_BATCH_MAX_SIZE frames (or every
 *                     ANALYSIS_BATCH_INTERVAL_MS) a SHA-256 root of the batch
 *                     is committed to Solana as a historical receipt.
 *
 * BONUS — LOCAL SHUN LIST
 *         If a peer is caught lying it is immediately removed from the active
 *         peer list.  The shun is then reported to Solana so the wider network
 *         can make the punishment permanent.  No waiting for a Solana round-trip
 *         before isolation — critical for space/offline scenarios.
 *
 * Standardised envelope (emitted at /latest/:deviceId and /envelope/:deviceId):
 *
 *  {
 *    "header":  { "node_id", "signature", "timestamp" },
 *    "payload": { "device_id", "raw_data", "driver_status", "interpretation" },
 *    "audit":   { "peer_consistency", "solana_batch_id" }
 *  }
 *
 * Usage:
 *   node layer2_base.js A          → name=A,    port=5000
 *   node layer2_base.js A 5001     → name=A,    port=5001
 *   node layer2_base.js 5001       → name=Node-5001, port=5001
 */

'use strict';
require('dotenv').config();
require('cross-fetch/polyfill');
const express  = require('express');
const { spawn } = require('child_process');
const zlib     = require('zlib');
const dgram    = require('dgram');
const os       = require('os');
const crypto   = require('crypto');
const fs       = require('fs');

// ─── Solana (fraud disputes + state anchoring) ──────────────────────────────
const {
    Connection, Keypair, Transaction, TransactionInstruction, PublicKey,
    sendAndConfirmTransaction, ComputeBudgetProgram,
} = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');

const app = express();
app.use(express.json({ limit: '20mb' }));

// ─── CLI args ────────────────────────────────────────────────────────────────
const _arg1 = process.argv[2];
const _arg2 = process.argv[3];
let NODE_NAME, PORT;
if (!_arg1) {
    NODE_NAME = 'DEFAULT'; PORT = 5000;
} else if (/^\d+$/.test(_arg1)) {
    PORT = parseInt(_arg1, 10); NODE_NAME = `Node-${PORT}`;
} else {
    NODE_NAME = _arg1; PORT = _arg2 ? parseInt(_arg2, 10) : 5000;
}

const BOOTSTRAP_URL  = process.env.L2_BOOTSTRAP || null;
const L3_URL         = process.env.L3_URL || null;       // optional upstream aggregator
const DISCOVERY_PORT = 5099;
const OWN_URL        = `http://localhost:${PORT}`;

// ─── Heartbeat constants ──────────────────────────────────────────────────────
const L1_HEARTBEAT_TTL_MS  = 9_000;   // 3 × HEARTBEAT_INTERVAL — mark device DEAD after this
const L2_HEARTBEAT_INTERVAL_MS = 3_000; // how often THIS node pings L3

// ─── Local IP (for UDP discovery replies) ────────────────────────────────────
function getLocalIP() {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function compress(str)   { return zlib.deflateSync(Buffer.from(str, 'utf8')).toString('base64'); }
function decompress(b64) { return zlib.inflateSync(Buffer.from(b64, 'base64')).toString('utf8'); }
function sha256(str)     { return crypto.createHash('sha256').update(str).digest('hex'); }

// ─── Node-level HMAC signing key ─────────────────────────────────────────────
// Each L2 node has its own 256-bit PSK stored under device_keys/NODE_<id>_key.json.
// This key is used to sign the envelope header (the "Node Signature" in spec §A),
// so L3 can verify that this specific node produced the envelope — not a relay.
let _nodeSecret = null;
let _nodeKeyB64 = null;

function loadOrCreateNodeKey() {
    const dir  = 'device_keys';
    const file = `${dir}/NODE_${NODE_NAME}_key.json`;
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file)) {
        const d     = JSON.parse(fs.readFileSync(file, 'utf8'));
        _nodeSecret = Buffer.from(d.secretKey, 'base64');
        _nodeKeyB64 = d.secretKey;
        console.log(`[${NODE_NAME}] Node key loaded. fp=${d.fingerprint.slice(0, 16)}...`);
    } else {
        _nodeSecret = crypto.randomBytes(32);
        _nodeKeyB64 = _nodeSecret.toString('base64');
        const fp    = crypto.createHash('sha256').update(_nodeSecret).digest('hex');
        fs.writeFileSync(file, JSON.stringify({ secretKey: _nodeKeyB64, fingerprint: fp }, null, 2));
        console.log(`[${NODE_NAME}] Node key generated. fp=${fp}`);
    }
}

/**
 * Sign the canonical envelope header string
 *   "<NODE_NAME>|<deviceId>|<timestamp>"
 * using the node's own HMAC-SHA256 PSK.
 */
function signEnvelopeHeader(deviceId, timestamp) {
    const msg = Buffer.from(`${NODE_NAME}|${deviceId}|${timestamp}`, 'utf8');
    return crypto.createHmac('sha256', _nodeSecret).update(msg).digest('base64');
}

// ─── Standardised envelope builder ───────────────────────────────────────────
/**
 * Builds the standard L2 output envelope for L3 consumption.
 *
 * @param {string}      deviceId        — originating L1 device
 * @param {*}           rawData         — original value/frame hash/etc.
 * @param {'PROCESSED'|'NOT_LOADED'} driverStatus
 * @param {object|null} interpretation  — driver analysis result, or null
 * @param {'MATCH'|'CONFLICT'|'PENDING'} peerConsistency
 * @param {string|null} solanaBatchId   — TX sig from last batch flush, or null
 */
function buildEnvelope(deviceId, rawData, driverStatus, interpretation, peerConsistency, solanaBatchId) {
    const timestamp = Math.floor(Date.now() / 1000);
    return {
        header: {
            node_id:   NODE_NAME,
            signature: signEnvelopeHeader(deviceId, timestamp),
            timestamp,
        },
        payload: {
            device_id:     deviceId,
            raw_data:      rawData,
            driver_status: driverStatus,
            interpretation: interpretation ?? null,
        },
        audit: {
            peer_consistency: peerConsistency,
            solana_batch_id:  solanaBatchId ?? null,
        },
    };
}

// ─── Solana client (lazy init) ───────────────────────────────────────────────
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
        console.error(`[Solana] Failed to init: ${e.message}`);
        return null;
    }
}

// ─── HMAC-SHA256 device signature verification ────────────────────────────────
function verifyHMAC(deviceId, value, timestamp, signatureB64, secretKeyB64) {
    try {
        const message   = Buffer.from(`${deviceId}|${parseFloat(value).toFixed(2)}|${timestamp}`, 'utf8');
        const secretKey = Buffer.from(secretKeyB64, 'base64');
        const expected  = crypto.createHmac('sha256', secretKey).update(message).digest();
        const received  = Buffer.from(signatureB64, 'base64');
        if (expected.length !== received.length) return false;
        return crypto.timingSafeEqual(expected, received);
    } catch { return false; }
}

function verifyFrameHMAC(deviceId, frameHash, timestamp, signatureB64, secretKeyB64) {
    try {
        const message   = Buffer.from(`${deviceId}|frame|${frameHash}|${timestamp}`, 'utf8');
        const secretKey = Buffer.from(secretKeyB64, 'base64');
        const expected  = crypto.createHmac('sha256', secretKey).update(message).digest();
        const received  = Buffer.from(signatureB64, 'base64');
        if (expected.length !== received.length) return false;
        return crypto.timingSafeEqual(expected, received);
    } catch { return false; }
}

// ─── State ───────────────────────────────────────────────────────────────────
const driverRegistry  = {};          // type  → { version, script, hash }
const deviceRegistry  = {};          // id    → type
let   peers           = [];          // [{ name, url }] sorted
let   checkInterval   = 10000;
let   watcherTurn     = 0;

// BFT / shun state
const fraudLog      = [];            // persisted fraud events
const shunnedPeers  = new Set();     // URLs — locally isolated immediately

// ── B. GOSSIP AUDITOR ─────────────────────────────────────────────────────────
// analysisCache: the node's own cross-validation ground truth.
// Key: "<deviceId>:<frameHash>"  →  { status, brightness, frameDiff, timestamp … }
const analysisCache = new Map();
// Peer claims that arrived before we processed the same frame locally.
// Stored here; compared retroactively inside the /frame handler.
// Key: "<deviceId>:<frameHash>"  →  [{ fromUrl, fromName, reportedStatus, … }]
const pendingPeerClaims = new Map();

// ── A. PASS-THROUGH / PROCESSED envelopes ─────────────────────────────────────
// latest envelope per device — polled by L3
const latestEnvelopes = new Map();   // deviceId → envelope

// ── Device heartbeat tracking ─────────────────────────────────────────────────
// Populated by POST /heartbeat from L1 devices.
// { lastSeen: <ms epoch>, status: 'ALIVE'|'DEAD', type: string }
const deviceHeartbeats = new Map();

// ── C. STATE ANCHOR batch queue ───────────────────────────────────────────────
const ANALYSIS_BATCH_INTERVAL_MS = 30_000;
const ANALYSIS_BATCH_MAX_SIZE    = 15;
const analysisBatchQueue         = [];
let   lastSolanaBatchId          = null;  // cached TX sig from most recent flush

// MJPEG state
const latestFrames  = new Map();     // deviceId → Buffer (annotated JPEG)
const mjpegClients  = new Map();     // deviceId → Set<res>

let defaultScript = `import sys, json
data = json.load(sys.stdin)
print(f"[default] {data.get('id','?')} raw={data.get('value',data.get('frameHash','?'))} type={data.get('type','?')}")
`.trim();

// ─── Python driver execution ──────────────────────────────────────────────────
/**
 * Run a text/JSON data driver.
 * If no driver is registered for `data.type`, uses defaultScript.
 * Returns { output: string, driverLoaded: boolean }.
 */
function runPythonDriver(data) {
    const type    = data.type || null;
    const entry   = type ? driverRegistry[type] : null;
    const script  = entry ? entry.script : defaultScript;
    const loaded  = Boolean(entry);
    if (type && !entry) {
        console.log(`[${NODE_NAME}] No driver for "${type}" — pass-through mode.`);
    }
    return new Promise((resolve) => {
        const proc = spawn('python3', ['-c', script]);
        let stdout = '', stderr = '';
        proc.stdout.on('data', c => { stdout += c.toString(); });
        proc.stderr.on('data', c => { stderr += c.toString(); });
        proc.on('close', code => resolve({
            output:       code !== 0 ? `Script error (exit ${code}): ${stderr.trim()}` : stdout.trim(),
            driverLoaded: loaded,
        }));
        proc.stdin.write(JSON.stringify(data));
        proc.stdin.end();
    });
}

/**
 * Run a frame/JPEG driver.
 * Stdout: line 1 = JSON analysis, line 2 = annotated JPEG in base64.
 * Returns { analysis, jpegBuf, driverLoaded }.
 */
function runFrameDriver(payload) {
    const type  = payload.type || null;
    const entry = type ? driverRegistry[type] : null;
    if (!entry) {
        console.log(`[${NODE_NAME}] No driver for "${type}" — pass-through mode.`);
        return Promise.resolve({ analysis: null, jpegBuf: null, driverLoaded: false });
    }
    return new Promise((resolve) => {
        const proc = spawn('python3', ['-c', entry.script]);
        let chunks = [];
        proc.stdout.on('data', chunk => chunks.push(chunk));
        proc.stderr.on('data', c    => console.error(`[driver:${type}] ${c.toString().trim()}`));
        proc.on('close', () => {
            const raw        = Buffer.concat(chunks).toString('utf8');
            const nlIdx      = raw.indexOf('\n');
            if (nlIdx === -1) {
                resolve({ analysis: raw.trim() || null, jpegBuf: null, driverLoaded: true });
                return;
            }
            const anlLine  = raw.slice(0, nlIdx).trim();
            const jpegLine = raw.slice(nlIdx + 1).trim();
            resolve({
                analysis:     anlLine || null,
                jpegBuf:      jpegLine ? Buffer.from(jpegLine, 'base64') : null,
                driverLoaded: true,
            });
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
    if (res.socket) res.socket.write('');
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

// ─── Peer watcher ─────────────────────────────────────────────────────────────
async function pingPeer(peer) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
        const res = await fetch(`${peer.url}/health`, { signal: ctrl.signal });
        clearTimeout(timer); return res.ok;
    } catch { clearTimeout(timer); return false; }
}
async function runWatcherTick() {
    if (!peers.length) return;
    const target = peers[watcherTurn % peers.length];
    watcherTurn  = (watcherTurn + 1) % peers.length;
    const ok     = await pingPeer(target);
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

async function gossipAnalysisToAll(payload, exceptUrl = null) {
    for (const p of peers) {
        if (p.url === exceptUrl) continue;
        try {
            await fetch(`${p.url}/gossip/analysis`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-from':       OWN_URL,
                    'x-node-name':  NODE_NAME,
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(5000),
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

// ─── Fraud evidence → Solana ──────────────────────────────────────────────────
async function submitFraudToSolana(fraudReport) {
    const client = getSolanaClient();
    if (!client) {
        console.warn(`[${NODE_NAME}] No SOLANA_PRIVATE_KEY — fraud logged locally only.`);
        return null;
    }
    const { conn, sender } = client;
    const memoPayload = JSON.stringify({ event: 'BFT_FRAUD_DETECTED', sigScheme: 'HMAC-SHA256', ...fraudReport });
    const memoIx = new TransactionInstruction({
        keys: [{ pubkey: sender.publicKey, isSigner: true, isWritable: false }],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(memoPayload),
    });
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), memoIx);
    try {
        const sig = await sendAndConfirmTransaction(conn, tx, [sender]);
        console.log(`[${NODE_NAME}] FRAUD recorded on Solana: ${sig}`);
        return { result: 'FRAUD_RECORDED_ON_CHAIN', sig };
    } catch (err) {
        console.error(`[${NODE_NAME}] Solana fraud memo error: ${err.message}`);
        return { result: 'SOLANA_ERROR', error: err.message };
    }
}

async function submitAnalysisFraudToSolana(fraudReport) {
    const client = getSolanaClient();
    if (!client) {
        console.warn(`[${NODE_NAME}] No SOLANA_PRIVATE_KEY — analysis fraud logged locally only.`);
        return null;
    }
    const { conn, sender } = client;
    const memoPayload = JSON.stringify({ event: 'BFT_ANALYSIS_FRAUD', accusingNode: NODE_NAME, ...fraudReport });
    const memoIx = new TransactionInstruction({
        keys: [{ pubkey: sender.publicKey, isSigner: true, isWritable: false }],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(memoPayload),
    });
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), memoIx);
    try {
        const sig = await sendAndConfirmTransaction(conn, tx, [sender]);
        console.log(`[${NODE_NAME}] ANALYSIS FRAUD on Solana: ${sig}`);
        return { result: 'ANALYSIS_FRAUD_ON_CHAIN', sig };
    } catch (err) {
        console.error(`[${NODE_NAME}] Solana analysis fraud error: ${err.message}`);
        return { result: 'SOLANA_ERROR', error: err.message };
    }
}

// ── C. STATE ANCHOR — Batch flush ─────────────────────────────────────────────
/**
 * Accumulate frame analysis reports.  Every ANALYSIS_BATCH_MAX_SIZE frames
 * (or every ANALYSIS_BATCH_INTERVAL_MS) compute a SHA-256 "batch root" of
 * all frame hashes in the window and post it to Solana as a Memo.
 *
 * The TX signature is stored in lastSolanaBatchId so subsequent envelopes
 * can reference it in their audit.solana_batch_id field.
 */
function enqueueAnalysis({ deviceId, frameHash, timestamp, status }) {
    analysisBatchQueue.push({ deviceId, frameHash, timestamp, status });
    if (analysisBatchQueue.length >= ANALYSIS_BATCH_MAX_SIZE) {
        flushAnalysisBatch().catch(() => {});
    }
}

async function flushAnalysisBatch() {
    if (!analysisBatchQueue.length) return;
    const batch = analysisBatchQueue.splice(0);

    // Build a simple Merkle-like root: SHA-256 of concatenated frame hashes
    const batchRoot = sha256(batch.map(r => r.frameHash).join('|'));

    const counts = {};
    let firstTs = Infinity, lastTs = -Infinity;
    for (const r of batch) {
        counts[r.status] = (counts[r.status] || 0) + 1;
        if (r.timestamp < firstTs) firstTs = r.timestamp;
        if (r.timestamp > lastTs)  lastTs  = r.timestamp;
    }

    const client = getSolanaClient();
    if (!client) {
        console.log(`[${NODE_NAME}] Batch (${batch.length} frames) batchRoot=${batchRoot.slice(0,16)}... — no Solana key, stored locally.`);
        return;
    }
    const { conn, sender } = client;

    const memoPayload = JSON.stringify({
        event:       'ANALYSIS_BATCH',
        reporter:    NODE_NAME,
        frameCount:  batch.length,
        batchRoot,               // SHA-256 of all frame hashes — the "historical receipt"
        counts,
        windowStart: firstTs,
        windowEnd:   lastTs,
    });
    const memoIx = new TransactionInstruction({
        keys: [{ pubkey: sender.publicKey, isSigner: true, isWritable: false }],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(memoPayload),
    });
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), memoIx);
    try {
        const sig = await sendAndConfirmTransaction(conn, tx, [sender]);
        lastSolanaBatchId = sig;
        console.log(`[${NODE_NAME}] STATE ANCHOR — batch(${batch.length}) root=${batchRoot.slice(0,16)}... → Solana: ${sig}`);
    } catch (err) {
        console.error(`[${NODE_NAME}] Solana batch error: ${err.message}`);
        analysisBatchQueue.unshift(...batch);
    }
}

// ─── Fraud log persistence ────────────────────────────────────────────────────
function persistFraud(entry) {
    fraudLog.push(entry);
    const path = 'fraud_log.json';
    try {
        const existing = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : [];
        existing.push(entry);
        fs.writeFileSync(path, JSON.stringify(existing, null, 2));
    } catch (e) {
        console.error(`[${NODE_NAME}] Could not write fraud log: ${e.message}`);
    }
}

// ─── LOCAL SHUN — isolate a lying peer immediately ───────────────────────────
/**
 * Shun a peer locally without waiting for Solana confirmation.
 * Critical for space/isolated environments where you can't afford to keep
 * talking to a liar while the on-chain punishment is being processed.
 */
function shunPeer(fromUrl, fromName, fraudEntry) {
    if (shunnedPeers.has(fromUrl)) return;   // already shunned
    shunnedPeers.add(fromUrl);
    const prevLen = peers.length;
    peers = peers.filter(p => p.url !== fromUrl);
    if (peers.length < prevLen) {
        console.log(`[${NODE_NAME}] SHUNNED ${fromName} — removed from active peer list immediately.`);
        console.log(`[${NODE_NAME}] (Solana punishment pending — shun is effective NOW)`);
    }
    persistFraud(fraudEntry);
}

// ─── HTTP API ─────────────────────────────────────────────────────────────────

// ─── Device heartbeat liveness check ────────────────────────────────────────
function getDeviceLiveness() {
    const now = Date.now();
    const liveness = {};
    // Devices that have registered via data/frame but may have no heartbeat yet
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
    // Also include devices only seen via heartbeat
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
        node:           NODE_NAME,
        port:           PORT,
        url:            OWN_URL,
        peers:          peers.map(p => ({ name: p.name, url: p.url })),
        drivers:        Object.entries(driverRegistry).map(([type, d]) => ({
            type, version: d.version, hash: d.hash.slice(0, 8) + '...',
        })),
        devices:        deviceRegistry,
        device_liveness: getDeviceLiveness(),
        status:         'UP',
        timestamp:      Math.floor(Date.now() / 1000),
        shunnedPeers:   [...shunnedPeers],
        fraudLog:       fraudLog.slice(-10),
    });
});

// ── L1 Device Heartbeat ────────────────────────────────────────────────────────
// L1 devices POST here every HEARTBEAT_INTERVAL seconds.
// L2 tracks liveness; unresponsive devices are marked DEAD automatically.
app.post('/heartbeat', (req, res) => {
    const { id, type, timestamp, status } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const prev = deviceHeartbeats.get(id);
    deviceHeartbeats.set(id, { lastSeen: Date.now(), type: type || (prev && prev.type) || 'UNKNOWN', status: status || 'ALIVE' });
    // Ensure device is in registry
    if (type && !deviceRegistry[id]) deviceRegistry[id] = type;
    res.json({ node: NODE_NAME, received: true, timestamp: Math.floor(Date.now() / 1000) });
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

app.get('/fraud-log', (req, res) => {
    res.json({ node: NODE_NAME, fraudEvents: fraudLog, shunnedPeers: [...shunnedPeers] });
});

// ── A. Standardised envelope endpoints ────────────────────────────────────────
// L3 dashboard polls these to get the latest output for any device.

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

// Alias for clarity in L3 config scripts
app.get('/envelope/:deviceId', (req, res) => {
    const env = latestEnvelopes.get(req.params.deviceId);
    if (!env) return res.status(404).json({ error: 'No data yet for this device.' });
    res.json(env);
});

// ── Peer gossip ────────────────────────────────────────────────────────────────
app.post('/gossip/peer', async (req, res) => {
    const { name, url } = req.body || {};
    if (!name || !url) return res.status(400).json({ error: 'name and url required' });
    if (url === OWN_URL) return res.sendStatus(200);
    if (!peers.find(p => p.url === url)) {
        peers.push({ name, url });
        peers.sort((a, b) => a.name.localeCompare(b.name));
        watcherTurn = 0;
        console.log(`[${NODE_NAME}] Peer joined: ${name} @ ${url}`);
        await gossipPeerToAll({ name, url }, req.headers['x-from'] || null);
    }
    res.sendStatus(200);
});

// ── B. GOSSIP AUDITOR — numeric data ──────────────────────────────────────────
// A peer gossips sensor data to us.  We verify the HMAC.  If the tag does
// not match the reported value the peer tampered the data → CONFLICT.
app.post('/gossip/data', async (req, res) => {
    const payload  = req.body || {};
    const fromUrl  = req.headers['x-from']      || 'unknown';
    const fromName = req.headers['x-node-name'] || fromUrl;
    const { id: deviceId, value, timestamp, signature, publicKey } = payload;

    console.log(`\n[${NODE_NAME}] GOSSIP from [${fromName}] device=${deviceId} value=${value}`);

    if (shunnedPeers.has(fromUrl)) {
        console.log(`[${NODE_NAME}] Ignored gossip from shunned peer: ${fromName}`);
        return res.sendStatus(200);
    }
    if (!signature || !publicKey) {
        console.warn(`[${NODE_NAME}] Gossip missing signature/publicKey — rejected.`);
        return res.sendStatus(400);
    }

    const isValid = verifyHMAC(deviceId, value, timestamp, signature, publicKey);
    if (isValid) {
        console.log(`[${NODE_NAME}] GOSSIP AUDITOR — HMAC VALID from ${fromName}. peer_consistency=MATCH`);
        // Update the envelope audit field for this device
        const env = latestEnvelopes.get(deviceId);
        if (env) env.audit.peer_consistency = 'MATCH';
        return res.sendStatus(200);
    }

    // ── FRAUD DETECTED — peer tampered with the value ──────────────────────────
    console.log(`[${NODE_NAME}] ╔══ GOSSIP AUDITOR: CONFLICT DETECTED ══════════════`);
    console.log(`[${NODE_NAME}] ║  Peer      : ${fromName}`);
    console.log(`[${NODE_NAME}] ║  Device    : ${deviceId}`);
    console.log(`[${NODE_NAME}] ║  Reported  : ${value}  (HMAC tag says different value)`);
    console.log(`[${NODE_NAME}] ╚══════════════════════════════════════════════════\n`);

    // Mark the envelope as CONFLICT
    const env = latestEnvelopes.get(deviceId);
    if (env) env.audit.peer_consistency = 'CONFLICT';

    const fraudEntry = {
        detectedAt:    new Date().toISOString(),
        kind:          'VALUE_TAMPER',
        accusingNode:  NODE_NAME,
        lyingPeer:     fromName,
        lyingPeerUrl:  fromUrl,
        deviceId,
        tamperedValue: value,
        timestamp,
        verdict:       'HMAC-SHA256 FAIL — data tampered',
    };
    shunPeer(fromUrl, fromName, fraudEntry);

    console.log(`[${NODE_NAME}] Submitting fraud evidence to Solana...`);
    const verdict = await submitFraudToSolana(fraudEntry);
    fraudEntry.solanaVerdict = verdict;

    res.sendStatus(200);
});

// ── B. GOSSIP AUDITOR — frame analysis cross-validation ───────────────────────
// Honest nodes gossip their driver analysis result for each frame.
// If a peer reports a different status for the same frameHash we know it lied.
app.post('/gossip/analysis', async (req, res) => {
    const { deviceId, frameHash, timestamp, reportedStatus, signature, publicKey } = req.body || {};
    const fromUrl  = req.headers['x-from']      || 'unknown';
    const fromName = req.headers['x-node-name'] || fromUrl;

    if (!deviceId || !frameHash || !reportedStatus) return res.sendStatus(400);
    if (shunnedPeers.has(fromUrl)) return res.sendStatus(200);

    const frameHmacValid = (signature && publicKey && timestamp)
        ? verifyFrameHMAC(deviceId, frameHash, timestamp, signature, publicKey)
        : null;

    // NOTE: frameHmacValid proves the L1 device signed this raw frame.
    // It does NOT prove this peer's analysis is honest — a lying node reuses
    // the original L1 HMAC while reporting a false status (e.g. NO_MOTION).
    console.log(`\n[${NODE_NAME}] GOSSIP AUDITOR (analysis) from [${fromName}] device=${deviceId} status=${reportedStatus}`);
    console.log(`[${NODE_NAME}]   L1 frame signature: ${frameHmacValid === null ? 'not provided' : frameHmacValid ? 'VALID (raw frame only — does NOT validate peer analysis)' : 'INVALID'}`);

    const cacheKey    = `${deviceId}:${frameHash}`;
    const ownAnalysis = analysisCache.get(cacheKey);

    if (!ownAnalysis) {
        // Store the peer's claim — we'll cross-validate it retroactively
        // the moment our own /frame analysis finishes for this frameHash.
        if (!pendingPeerClaims.has(cacheKey)) pendingPeerClaims.set(cacheKey, []);
        pendingPeerClaims.get(cacheKey).push(
            { fromUrl, fromName, reportedStatus, signature, publicKey, timestamp }
        );
        console.log(`[${NODE_NAME}]   No local analysis yet — claim stored for retroactive cross-validation.`);
        return res.sendStatus(200);
    }

    const ownStatus = ownAnalysis.status;
    if (ownStatus === reportedStatus) {
        console.log(`[${NODE_NAME}]   peer_consistency=MATCH  (${fromName} agrees: ${ownStatus})`);
        const env = latestEnvelopes.get(deviceId);
        if (env) env.audit.peer_consistency = 'MATCH';
        return res.sendStatus(200);
    }

    // ── ANALYSIS CONFLICT ─────────────────────────────────────────────────────
    console.log(`[${NODE_NAME}] ╔══ GOSSIP AUDITOR: ANALYSIS CONFLICT ══════════════`);
    console.log(`[${NODE_NAME}] ║  Peer ${fromName} says: ${reportedStatus}`);
    console.log(`[${NODE_NAME}] ║  We got              : ${ownStatus}`);
    console.log(`[${NODE_NAME}] ║  Frame               : ${(frameHash || '').slice(0, 16)}...`);
    console.log(`[${NODE_NAME}] ╚══════════════════════════════════════════════════\n`);

    const env = latestEnvelopes.get(deviceId);
    if (env) env.audit.peer_consistency = 'CONFLICT';

    const fraudEntry = {
        detectedAt:     new Date().toISOString(),
        kind:           'ANALYSIS_CONFLICT',
        accusingNode:   NODE_NAME,
        lyingPeer:      fromName,
        lyingPeerUrl:   fromUrl,
        deviceId,       frameHash,    timestamp,
        ownStatus,      reportedStatus,
        verdict:        `${fromName} reported ${reportedStatus} — cross-validation got ${ownStatus}`,
    };
    shunPeer(fromUrl, fromName, fraudEntry);

    const verdict = await submitAnalysisFraudToSolana(fraudEntry);
    fraudEntry.solanaVerdict = verdict;

    res.sendStatus(200);
});

// ── Driver management ──────────────────────────────────────────────────────────
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
    await gossipDriverToAll({ type, version, script: compress(script), gz: true, hash },
                             fromUrl || req.headers['x-from'] || null);
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

// ── A. Sensor data from L1 (numeric) ──────────────────────────────────────────
// If no driver is found the raw value is still wrapped in the standard
// envelope with driver_status="NOT_LOADED" so L3 sees the raw telemetry.
app.post('/data', async (req, res) => {
    const payload = req.body;
    if (payload.id && deviceRegistry[payload.id] && !payload.type) {
        payload.type = deviceRegistry[payload.id];
    }

    // Verify device HMAC
    let hmacStatus = 'NOT_CHECKED';
    if (payload.signature && payload.publicKey && payload.id && payload.timestamp) {
        const ok = verifyHMAC(payload.id, payload.value, payload.timestamp,
                              payload.signature, payload.publicKey);
        hmacStatus = ok ? 'VALID' : 'INVALID';
        if (ok) console.log(`[${NODE_NAME}] HMAC valid | ${payload.id} value=${payload.value}`);
        else    console.warn(`[${NODE_NAME}] HMAC INVALID for ${payload.id} value=${payload.value}`);
    }

    const { output, driverLoaded } = await runPythonDriver(payload);

    // ── A. Build standardised envelope ─────────────────────────────────────
    let interpretation = null;
    if (driverLoaded) {
        try { interpretation = JSON.parse(output); } catch { interpretation = { text: output }; }
    }
    const driverStatus = driverLoaded ? 'PROCESSED' : 'NOT_LOADED';
    const envelope = buildEnvelope(
        payload.id,
        { value: payload.value, hmac: hmacStatus },
        driverStatus,
        interpretation,
        'PENDING',           // will update when gossip arrives
        lastSolanaBatchId,
    );
    latestEnvelopes.set(payload.id, envelope);

    if (driverLoaded) {
        console.log(`[${NODE_NAME}] DATA ${payload.id} → PROCESSED: ${output}`);
    } else {
        console.log(`[${NODE_NAME}] DATA ${payload.id} → PASS-THROUGH (no driver). Envelope saved for L3.`);
    }

    res.json(envelope);
});

// ── A. Frame from L1 (JPEG) ────────────────────────────────────────────────────
app.post('/frame', async (req, res) => {
    const { id, type, frame, frameHash, timestamp, signature, publicKey } = req.body;
    if (!id || !frame || !frameHash) return res.sendStatus(400);

    if (type) deviceRegistry[id] = type;
    const resolvedType = deviceRegistry[id] || type;

    if (signature && publicKey && timestamp) {
        const ok = verifyFrameHMAC(id, frameHash, timestamp, signature, publicKey);
        if (ok) console.log(`[${NODE_NAME}] Frame HMAC valid | ${id}`);
        else    console.warn(`[${NODE_NAME}] Frame HMAC INVALID for ${id}`);
    }

    const { analysis, jpegBuf, driverLoaded } = await runFrameDriver(
        { id, type: resolvedType, frame, frameHash, timestamp, nodeId: NODE_NAME }
    );

    let ownStatus = 'UNKNOWN';
    let ownMeta   = null;
    if (driverLoaded && analysis) {
        try {
            ownMeta   = JSON.parse(analysis);
            ownStatus = ownMeta.status ?? 'UNKNOWN';
            console.log(`[${NODE_NAME}] FRAME ${id} → ${ownStatus}`);
        } catch {
            console.log(`[${NODE_NAME}] FRAME ${id} → ${analysis}`);
            ownMeta = { text: analysis };
        }
    } else {
        console.log(`[${NODE_NAME}] FRAME ${id} → PASS-THROUGH (no driver). Raw hash stored.`);
    }

    // Cache for Gossip Auditor cross-validation
    const cacheKey = `${id}:${frameHash}`;
    analysisCache.set(cacheKey, { status: ownStatus, timestamp, ...ownMeta });
    if (analysisCache.size > 500) {
        analysisCache.delete(analysisCache.keys().next().value);
    }

    // Retroactively cross-validate peer claims that arrived before our analysis.
    // Race fix: Node B can gossip NO_MOTION before we finish processing the same
    // frame — we stored B's claim; now we compare it against our own result.
    const pending = pendingPeerClaims.get(cacheKey);
    if (pending && pending.length) {
        pendingPeerClaims.delete(cacheKey);
        for (const claim of pending) {
            if (shunnedPeers.has(claim.fromUrl)) continue;
            if (claim.reportedStatus === ownStatus) {
                console.log(`[${NODE_NAME}] Retroactive check: ${claim.fromName} MATCH (${ownStatus})`);
                const env = latestEnvelopes.get(id);
                if (env) env.audit.peer_consistency = 'MATCH';
                continue;
            }
            console.log(`[${NODE_NAME}] ╔══ RETROACTIVE CONFLICT DETECTED ════════════════════`);
            console.log(`[${NODE_NAME}] ║  Peer : ${claim.fromName} reported ${claim.reportedStatus}`);
            console.log(`[${NODE_NAME}] ║  We got (now) : ${ownStatus}`);
            console.log(`[${NODE_NAME}] ║  Frame : ${(frameHash || '').slice(0, 16)}...`);
            console.log(`[${NODE_NAME}] ╚════════════════════════════════════════════════════\n`);
            const fraudEntry = {
                detectedAt:     new Date().toISOString(),
                kind:           'RETROACTIVE_ANALYSIS_CONFLICT',
                accusingNode:   NODE_NAME,
                lyingPeer:      claim.fromName,
                lyingPeerUrl:   claim.fromUrl,
                deviceId:       id,
                frameHash,
                timestamp,
                ownStatus,
                reportedStatus: claim.reportedStatus,
                verdict: `${claim.fromName} pre-gossiped ${claim.reportedStatus} — we later got ${ownStatus}`,
            };
            shunPeer(claim.fromUrl, claim.fromName, fraudEntry);
            submitAnalysisFraudToSolana(fraudEntry).catch(() => {});
            const env = latestEnvelopes.get(id);
            if (env) env.audit.peer_consistency = 'CONFLICT';
        }
    }

    if (jpegBuf) pushFrameToMjpegClients(id, jpegBuf);

    // ── A. Build standardised envelope ─────────────────────────────────────
    const driverStatus = driverLoaded ? 'PROCESSED' : 'NOT_LOADED';
    const envelope = buildEnvelope(
        id,
        { frameHash, timestamp },   // raw data for pass-through
        driverStatus,
        driverLoaded ? ownMeta : null,
        'PENDING',
        lastSolanaBatchId,
    );
    latestEnvelopes.set(id, envelope);

    // ── B. Gossip honest analysis to peers ─────────────────────────────────
    if (driverLoaded) {
        gossipAnalysisToAll({ deviceId: id, frameHash, timestamp, reportedStatus: ownStatus, signature, publicKey })
            .catch(() => {});
    }

    // ── C. Enqueue for Solana State Anchor ─────────────────────────────────
    enqueueAnalysis({ deviceId: id, frameHash, timestamp, status: ownStatus });

    res.json(envelope);
});

// ── MJPEG live stream ──────────────────────────────────────────────────────────
app.get('/video_feed', (req, res) => {
    const deviceId = req.query.id || [...latestFrames.keys()][0] || 'WEBCAM_01';
    if (req.socket) { req.socket.setNoDelay(true); req.socket.setTimeout(0); }
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
            udp.send(Buffer.from(`L2_HERE:http://${getLocalIP()}:${PORT}`), rinfo.port, rinfo.address);
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
        const r = await fetch(`${BOOTSTRAP_URL}/peers`, { signal: AbortSignal.timeout(6000) });
        if (r.ok) {
            const data = await r.json();
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
    loadOrCreateNodeKey();
    startUdpDiscovery();

    app.listen(PORT, async () => {
        console.log(`\n${'─'.repeat(62)}`);
        console.log(`  Layer 2 Base Node [${NODE_NAME}]  port=${PORT}`);
        console.log(`  A. Pass-Through  B. Gossip Auditor  C. State Anchor`);
        console.log(`  Local Shun List active — peers are isolated immediately.`);
        console.log(`${'─'.repeat(62)}\n`);

        await joinMesh();

        // ── C. Periodic State Anchor flush ──────────────────────────────────
        setInterval(() => flushAnalysisBatch().catch(() => {}), ANALYSIS_BATCH_INTERVAL_MS);

        // ── L2 → L3 Heartbeat ────────────────────────────────────────────────
        // If an L3 aggregator URL is configured, send periodic heartbeats so
        // L3 can detect when this node goes offline.
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
                } catch { /* L3 unreachable — silently skip */ }
            }, L2_HEARTBEAT_INTERVAL_MS);
        }

        // Peer health watcher (self-adjusting interval)
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
