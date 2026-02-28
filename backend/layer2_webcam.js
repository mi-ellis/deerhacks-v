require('dotenv').config();
require('cross-fetch/polyfill');
const express = require('express');
const { spawn } = require('child_process');
const zlib   = require('zlib');
const dgram  = require('dgram');
const os     = require('os');
const crypto = require('crypto');
const fs     = require('fs');

// ─── Solana (used only for fraud-dispute submissions) ──────────────────────────
const { Connection, Keypair, Transaction, TransactionInstruction, PublicKey,
        sendAndConfirmTransaction, ComputeBudgetProgram } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');

const app = express();
app.use(express.json({ limit: '20mb' }));

// ─── CLI args ───────────────────────────────────────────────────────────────────
//   node layer2_webcam.js A          → name=A,    port=5000
//   node layer2_webcam.js A 5001     → name=A,    port=5001
//   node layer2_webcam.js 5001       → name=Node-5001, port=5001
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

// L2_BOOTSTRAP is the URL of another node to connect to on startup.
// Leave unset for the very first node in the mesh.
const BOOTSTRAP_URL   = process.env.L2_BOOTSTRAP || null;
const DISCOVERY_PORT  = 5099;   // UDP port used by L1 sensors to discover us
const OWN_URL         = `http://localhost:${PORT}`;

// ─── Local IP (used in UDP discovery replies) ──────────────────────────────────
function getLocalIP() {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function compress(str)   { return zlib.deflateSync(Buffer.from(str, 'utf8')).toString('base64'); }
function decompress(b64) { return zlib.inflateSync(Buffer.from(b64, 'base64')).toString('utf8'); }
function sha256(str)     { return crypto.createHash('sha256').update(str).digest('hex'); }

// ─── Solana setup (lazy — only initialised when a fraud dispute is filed) ──────
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
        console.error(`[Solana] Failed to init client: ${e.message}`);
        return null;
    }
}

// ─── HMAC-SHA256 Signature Verification ──────────────────────────────────────
// Verifies that tag is a valid HMAC-SHA256 of the canonical message
// ─── HMAC-SHA256 Signature Verification ──────────────────────────────────────
// Verifies that `signatureB64` is a valid HMAC-SHA256 tag for the canonical
// message "<id>|<value:.2f>|<timestamp>" using the device's shared secret
// (passed as `secretKeyB64`, which is the `publicKey` field in the payload).
//
// If Node B changes 85 → 0 the tag it forwards was computed over "...|85.00|..."
// but Node A recomputes over "...|0.00|...". The tags differ → fraud caught.
function verifyHMAC(deviceId, value, timestamp, signatureB64, secretKeyB64) {
    try {
        const message   = Buffer.from(`${deviceId}|${parseFloat(value).toFixed(2)}|${timestamp}`, 'utf8');
        const secretKey = Buffer.from(secretKeyB64, 'base64');
        const expected  = crypto.createHmac('sha256', secretKey).update(message).digest();
        const received  = Buffer.from(signatureB64, 'base64');
        if (expected.length !== received.length) return false;
        return crypto.timingSafeEqual(expected, received);
    } catch (e) {
        console.error(`[${NODE_NAME}] verifyHMAC error: ${e.message}`);
        return false;
    }
}

// Verifies HMAC over a raw binary frame.
// Canonical message: '<deviceId>|frame|<sha256hex>|<timestamp>'
// Matches DeviceSigner.sign_bytes() in layer1_base.py.
function verifyFrameHMAC(deviceId, frameHash, timestamp, signatureB64, secretKeyB64) {
    try {
        const message   = Buffer.from(`${deviceId}|frame|${frameHash}|${timestamp}`, 'utf8');
        const secretKey = Buffer.from(secretKeyB64, 'base64');
        const expected  = crypto.createHmac('sha256', secretKey).update(message).digest();
        const received  = Buffer.from(signatureB64, 'base64');
        if (expected.length !== received.length) return false;
        return crypto.timingSafeEqual(expected, received);
    } catch (e) {
        console.error(`[${NODE_NAME}] verifyFrameHMAC error: ${e.message}`);
        return false;
    }
}

// ─── Submit fraud evidence to Solana ──────────────────────────────────────────
// Records the fraud report on-chain via the Memo program.
// The HMAC mismatch is proven locally; this anchors the evidence permanently.
async function submitFraudToSolana(fraudReport) {
    const client = getSolanaClient();
    if (!client) {
        console.warn(`[${NODE_NAME}] No SOLANA_PRIVATE_KEY — fraud logged locally only.`);
        return null;
    }
    const { conn, sender } = client;
    const { deviceId, tamperedValue, timestamp, accusingNode, lyingPeer } = fraudReport;

    const memoPayload = JSON.stringify({
        event:         'BFT_FRAUD_DETECTED',
        sigScheme:     'HMAC-SHA256',
        deviceId,      accusingNode,    lyingPeer,
        tamperedValue, timestamp,
        verdict:       'HMAC-SHA256 tag FAILED for reported value — TAMPERED',
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
        console.log(`\n[${NODE_NAME}] ════════════════════════════════════════════`);
        console.log(`[${NODE_NAME}] SOLANA VERDICT: FRAUD RECORDED ON-CHAIN`);
        console.log(`[${NODE_NAME}]    Memo tx: ${sig}`);
        console.log(`[${NODE_NAME}]    HMAC-SHA256 mismatch for ${deviceId} proven locally.`);
        console.log(`[${NODE_NAME}]    ${lyingPeer} is permanently slashed on devnet.`);
        console.log(`[${NODE_NAME}] ════════════════════════════════════════════\n`);
        return { result: 'FRAUD_RECORDED_ON_CHAIN', sig };
    } catch (err) {
        console.error(`[${NODE_NAME}] Solana memo error: ${err.message}`);
        return { result: 'SOLANA_ERROR', error: err.message };
    }
}

// ─── State ─────────────────────────────────────────────────────────────────────
const driverRegistry = {};   // type  → { version, script, hash }
const deviceRegistry = {};   // id    → type
let peers            = [];   // [{ name, url }] — excludes self, sorted by name
let checkInterval    = 10000;
let watcherTurn      = 0;

// BFT state
const fraudLog      = [];         // { timestamp, deviceId, accusingPeer, tamperedValue, verdict }
const shunnedPeers  = new Set();  // URLs of peers caught lying
// On-Chain Jury: cache own analysis so we can cross-validate peer gossip.
// Key: "<deviceId>:<frameHash>"  Value: { status, brightness, frameDiff, entropy, timestamp }
const analysisCache = new Map();
// Peer claims received BEFORE we processed the same frame locally.
// Key: "<deviceId>:<frameHash>"  Value: [{ fromUrl, fromName, reportedStatus, signature, publicKey, timestamp }]
// When our own analysis arrives we retroactively compare and catch any lie.
const pendingPeerClaims = new Map();
// MJPEG video state
const latestFrames  = new Map();  // deviceId → Buffer (latest annotated JPEG)
const mjpegClients  = new Map();  // deviceId → Set<res>  (subscribed SSE clients)
// Default script — used when no driver is registered for a device type
let defaultScript = `import sys, json
data = json.load(sys.stdin)
print(f"[default] {data.get('id','?')} raw={data['value']} type={data.get('type','?')}")
`.trim();

// ─── Python driver execution ───────────────────────────────────────────────────
function runPythonDriver(data) {
    const type   = data.type || null;
    const entry  = type ? driverRegistry[type] : null;
    const script = entry ? entry.script : defaultScript;
    if (type && !entry) console.log(`[${NODE_NAME}] No driver for "${type}", using default.`);
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
// ─── Frame driver execution (two-line output protocol) ───────────────────────────────────────
// Stdin:  JSON payload including 'frame' (base64 JPEG) field
// Stdout: Line 1 = JSON analysis  (e.g. {"status":"DIM","brightness":45.2})
//         Line 2 = base64-encoded annotated JPEG (for MJPEG stream)
function runFrameDriver(payload) {
    const type  = payload.type || null;
    const entry = type ? driverRegistry[type] : null;
    if (!entry) {
        console.log(`[${NODE_NAME}] No driver for "${type}" — cannot process frame.`);
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

// ─── MJPEG helpers ─────────────────────────────────────────────────────────────────────────────
function writeMjpegFrame(res, jpegBuf) {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegBuf.length}\r\n\r\n`);
    res.write(jpegBuf);
    res.write('\r\n');
    // Flush through Node.js TCP buffers so the browser receives it immediately
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
// ─── Peer health watcher ───────────────────────────────────────────────────────
async function pingPeer(peer) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const res = await fetch(`${peer.url}/health`, { signal: controller.signal });
        clearTimeout(timer);
        return res.ok;
    } catch {
        clearTimeout(timer);
        return false;
    }
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
// Tell all peers about a new peer (except the one who told us, to avoid loops)
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
        } catch { /* unreachable — watcher handles it */ }
    }
}

// Broadcast this node's honest analysis to all peers so they can cross-validate.
// Any peer that received a different status for the same frameHash will flag fraud.
async function gossipAnalysisToAll(analysisPayload, exceptUrl = null) {
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
                body: JSON.stringify(analysisPayload),
                signal: AbortSignal.timeout(5000),
            });
        } catch { /* unreachable — watcher handles it */ }
    }
}

// Submit the honest analysis as a Solana Memo so the ledger has a ground-truth
// record.  When the evil node later submits a conflicting status for the same
// frameHash + timestamp, both memos are visible on-chain and the jury can see
// the contradiction without trusting either node's word.
//
// ─── Solana analysis batch queue ──────────────────────────────────────────────
// One Solana memo per frame at ~10 fps immediately hits devnet rate limits.
// Instead we accumulate reports in a queue and flush a single summarised memo
// every ANALYSIS_BATCH_INTERVAL_MS, or when the queue reaches ANALYSIS_BATCH_MAX_SIZE.
// Fraud reports always bypass the queue and are sent immediately.
const ANALYSIS_BATCH_INTERVAL_MS = 30_000;  // flush every 30 seconds
const ANALYSIS_BATCH_MAX_SIZE    = 15;       // or when 15 reports are pending

const analysisBatchQueue = [];   // { deviceId, frameHash, timestamp, status }

function enqueueAnalysis({ deviceId, frameHash, timestamp, status }) {
    analysisBatchQueue.push({ deviceId, frameHash, timestamp, status });
    if (analysisBatchQueue.length >= ANALYSIS_BATCH_MAX_SIZE) {
        flushAnalysisBatch().catch(() => {});
    }
}

async function flushAnalysisBatch() {
    if (!analysisBatchQueue.length) return;
    // Drain atomically — if the tx fails we re-queue
    const batch = analysisBatchQueue.splice(0);

    // Summarise into a compact payload that fits in a single Memo transaction
    const counts = {};
    let firstTs = Infinity, lastTs = -Infinity, lastHash = '';
    for (const r of batch) {
        counts[r.status] = (counts[r.status] || 0) + 1;
        if (r.timestamp < firstTs) firstTs = r.timestamp;
        if (r.timestamp > lastTs)  { lastTs = r.timestamp; lastHash = r.frameHash; }
    }

    const client = getSolanaClient();
    if (!client) {
        console.log(`[${NODE_NAME}] Analysis batch (${batch.length} frames) held locally — no Solana key.`);
        return;
    }
    const { conn, sender } = client;

    const memoPayload = JSON.stringify({
        event:         'ANALYSIS_BATCH',
        reporter:      NODE_NAME,
        frameCount:    batch.length,
        counts,
        windowStart:   firstTs,
        windowEnd:     lastTs,
        lastFrameHash: lastHash,
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
        console.log(`[${NODE_NAME}] Analysis batch (${batch.length} frames) committed to Solana: ${sig}`);
        console.log(`[${NODE_NAME}]    Counts: ${JSON.stringify(counts)} | window: ${firstTs}-${lastTs}`);
    } catch (err) {
        console.error(`[${NODE_NAME}] Solana batch memo error: ${err.message}`);
        // Re-queue so reports are not silently lost on transient RPC errors
        analysisBatchQueue.unshift(...batch);
    }
}

// Submit fraud evidence when cross-validation catches a lying peer.
async function submitAnalysisFraudToSolana(fraudReport) {
    const client = getSolanaClient();
    if (!client) {
        console.warn(`[${NODE_NAME}] No SOLANA_PRIVATE_KEY — analysis fraud logged locally only.`);
        return null;
    }
    const { conn, sender } = client;
    const { deviceId, frameHash, timestamp, lyingPeer, reportedStatus, ownStatus } = fraudReport;

    const memoPayload = JSON.stringify({
        event:           'BFT_ANALYSIS_FRAUD',
        deviceId,        frameHash,      timestamp,
        accusingNode:    NODE_NAME,      lyingPeer,
        ownStatus,       reportedStatus,
        verdict:         `Node ${lyingPeer} reported ${reportedStatus} but cross-validation got ${ownStatus} — TAMPERED`,
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
        console.log(`\n[${NODE_NAME}] ════════════════════════════════════════════`);
        console.log(`[${NODE_NAME}] SOLANA VERDICT: ANALYSIS FRAUD RECORDED ON-CHAIN`);
        console.log(`[${NODE_NAME}]    Memo tx     : ${sig}`);
        console.log(`[${NODE_NAME}]    Lying peer  : ${lyingPeer}`);
        console.log(`[${NODE_NAME}]    Reported    : ${reportedStatus}  (our analysis: ${ownStatus})`);
        console.log(`[${NODE_NAME}]    Frame hash  : ${frameHash.slice(0, 16)}...`);
        console.log(`[${NODE_NAME}]    ${lyingPeer} is permanently slashed on devnet.`);
        console.log(`[${NODE_NAME}] ════════════════════════════════════════════\n`);
        return { result: 'ANALYSIS_FRAUD_ON_CHAIN', sig };
    } catch (err) {
        console.error(`[${NODE_NAME}] Solana memo (analysis fraud) error: ${err.message}`);
        return { result: 'SOLANA_ERROR', error: err.message };
    }
}

// Forward a driver update to all peers except the sender (dedup via hash)
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
        } catch { /* fine */ }
    }
}

// ─── HTTP API ──────────────────────────────────────────────────────────────────

// Health / status
app.get('/health', (req, res) => {
    res.json({
        node:         NODE_NAME,
        port:         PORT,
        url:          OWN_URL,
        peers:        peers.map(p => ({ name: p.name, url: p.url })),
        drivers:      Object.entries(driverRegistry).map(([type, d]) => ({
            type, version: d.version, hash: d.hash.slice(0, 8) + '...',
        })),
        devices:      deviceRegistry,
        status:       'UP',
        shunnedPeers: [...shunnedPeers],
        fraudLog:     fraudLog.slice(-10),   // last 10 fraud events
    });
});

// Peer list (used by L1 discovery fallback and new nodes on join)
app.get('/peers', (req, res) => {
    res.json({ node: NODE_NAME, url: OWN_URL, peers });
});

// Driver summary (admin inspection)
app.get('/drivers', (req, res) => {
    const summary = {};
    for (const [type, { version, hash, script }] of Object.entries(driverRegistry)) {
        summary[type] = { version, hash, scriptLength: script.length };
    }
    res.json({ node: NODE_NAME, drivers: summary });
});

// ── Gossip: peer announcement ──────────────────────────────────────────────────
// L3 or other nodes POST here to announce a new peer.
// We add it, then forward to everyone else so it propagates.
app.post('/gossip/peer', async (req, res) => {
    const { name, url } = req.body || {};
    if (!name || !url) return res.status(400).json({ error: 'name and url required' });
    if (url === OWN_URL) return res.sendStatus(200);   // that's us, ignore
    const already = peers.find(p => p.url === url);
    if (!already) {
        peers.push({ name, url });
        peers.sort((a, b) => a.name.localeCompare(b.name));
        watcherTurn = 0;
        console.log(`[${NODE_NAME}] Peer joined: ${name} @ ${url}`);
        console.log(`[${NODE_NAME}] Peers: [${peers.map(p => p.name).join(', ')}]`);
        // Propagate to everyone except who told us
        await gossipPeerToAll({ name, url }, req.headers['x-from'] || null);
    }
    res.sendStatus(200);
});

// ── BFT: Gossip Data Integrity Check ──────────────────────────────────────────
// Peer nodes gossip sensor data here. We verify the HMAC-SHA256 tag.
// If the signature is INVALID: the gossiping peer tampered with the data.
app.post('/gossip/data', async (req, res) => {
    const payload      = req.body || {};
    const fromUrl      = req.headers['x-from']      || 'unknown';
    const fromName     = req.headers['x-node-name'] || fromUrl;
    const { id: deviceId, value, timestamp, signature, publicKey } = payload;

    console.log(`\n[${NODE_NAME}] Gossip received from [${fromName}]`);
    console.log(`[${NODE_NAME}]    Device: ${deviceId} | Reported value: ${value}`);

    // Skip nodes we have already shunned
    if (shunnedPeers.has(fromUrl)) {
        console.log(`[${NODE_NAME}] Ignored gossip from shunned peer: ${fromName}`);
        return res.sendStatus(200);
    }

    // ── Signature verification ──────────────────────────────────────────────────
    if (!signature || !publicKey) {
        console.warn(`[${NODE_NAME}] Gossip missing signature or publicKey — skipping.`);
        return res.sendStatus(400);
    }

    const isValid = verifyHMAC(deviceId, value, timestamp, signature, publicKey);

    if (isValid) {
        console.log(`[${NODE_NAME}] HMAC valid — data from ${fromName} is honest.`);
        return res.sendStatus(200);
    }

    // ── FRAUD DETECTED ─────────────────────────────────────────────────────────
    console.log(`[${NODE_NAME}] ╔══════════════════════════════════════════════════`);
    console.log(`[${NODE_NAME}] ║  FRAUD DETECTED!`);
    console.log(`[${NODE_NAME}] ║  Peer      : ${fromName} (${fromUrl})`);
    console.log(`[${NODE_NAME}] ║  Device    : ${deviceId}`);
    console.log(`[${NODE_NAME}] ║  Tampered  : value = ${value}  (HMAC tag was for a different value)`);
    console.log(`[${NODE_NAME}] ║  Verdict  : HMAC-SHA256(key, "${deviceId}|${parseFloat(value).toFixed(2)}|${timestamp}") ≠ received tag`);
    console.log(`[${NODE_NAME}] ╚══════════════════════════════════════════════════\n`);

    // Shun the lying peer
    shunnedPeers.add(fromUrl);
    // Remove from active peers list
    const prevLen = peers.length;
    peers = peers.filter(p => p.url !== fromUrl);
    if (peers.length < prevLen) {
        console.log(`[${NODE_NAME}] Peer ${fromName} has been SHUNNED and removed from mesh.`);
    }

    // Log fraud event
    const fraudEntry = {
        detectedAt:    new Date().toISOString(),
        accusingNode:  NODE_NAME,
        lyingPeer:     fromName,
        lyingPeerUrl:  fromUrl,
        deviceId,
        tamperedValue: value,
        timestamp,
        publicKey,
        signature,
        verdict:       'HMAC-SHA256 FAIL — data tampered',
    };
    fraudLog.push(fraudEntry);

    // Persist fraud log to disk (for offline sync later)
    const logPath = 'fraud_log.json';
    try {
        const existing = fs.existsSync(logPath)
            ? JSON.parse(fs.readFileSync(logPath, 'utf8'))
            : [];
        existing.push(fraudEntry);
        fs.writeFileSync(logPath, JSON.stringify(existing, null, 2));
        console.log(`[${NODE_NAME}] Fraud evidence saved to ${logPath}`);
    } catch (e) {
        console.error(`[${NODE_NAME}] Could not write fraud log: ${e.message}`);
    }

    // Submit to Solana (online) or defer to offline sync
    console.log(`[${NODE_NAME}] Submitting fraud evidence to Solana...`);
    const verdict = await submitFraudToSolana(fraudEntry);
    fraudEntry.solanaVerdict = verdict;

    res.sendStatus(200);
});

// ── Driver update (replaces Solana DRIVER_UPDATE memo) ─────────────────────────
// Receives full driver code from L3 (or another node's gossip).
// Deduplicates by hash. Gossips to all other peers automatically.
app.post('/driver', async (req, res) => {
    const { type, version, script: raw, gz, hash: claimedHash, from: fromUrl } = req.body || {};
    if (!type || !raw) return res.status(400).json({ error: 'type and script required' });

    const script       = gz ? decompress(raw) : raw;
    const computedHash = sha256(script);
    const hash         = claimedHash || computedHash;

    // Skip if already up-to-date (prevents gossip loops)
    const existing = driverRegistry[type];
    if (existing && existing.hash === hash) return res.sendStatus(200);

    driverRegistry[type] = { version, script, hash };
    console.log(`[${NODE_NAME}] Driver updated: type="${type}" v${version} hash=${hash.slice(0,8)}...`);

    // Forward to all peers except sender
    const gossipPayload = { type, version, script: compress(script), gz: true, hash };
    await gossipDriverToAll(gossipPayload, fromUrl || req.headers['x-from'] || null);

    res.sendStatus(200);
});

// ── Device registration (replaces Solana DEVICE_REGISTER memo) ─────────────────
app.post('/device', (req, res) => {
    const { devices } = req.body || {};
    if (!Array.isArray(devices)) return res.status(400).json({ error: 'devices array required' });
    devices.forEach(({ id, type }) => { if (id && type) deviceRegistry[id] = type; });
    console.log(`[${NODE_NAME}] Devices registered:`, deviceRegistry);
    res.sendStatus(200);
});

// ── Runtime config (replaces Solana SET_INTERVAL memo) ─────────────────────────
app.post('/config', (req, res) => {
    const { interval } = req.body || {};
    if (typeof interval === 'number' && interval > 0) {
        checkInterval = interval;
        console.log(`[${NODE_NAME}] Check interval → ${interval}ms`);
    }
    res.sendStatus(200);
});

// ── Sensor data from L1 ────────────────────────────────────────────────────────
app.post('/data', async (req, res) => {
    const payload = req.body;
    if (payload.id && deviceRegistry[payload.id] && !payload.type) {
        payload.type = deviceRegistry[payload.id];
    }

    // Verify HMAC-SHA256 tag if present (L1 always signs with hashlib hmac)
    if (payload.signature && payload.publicKey && payload.id && payload.timestamp) {
        const ok = verifyHMAC(payload.id, payload.value, payload.timestamp,
                               payload.signature, payload.publicKey);
        if (ok) {
            console.log(`[${NODE_NAME}] HMAC valid | ${payload.id} value=${payload.value}`);
        } else {
            console.warn(`[${NODE_NAME}] HMAC INVALID for ${payload.id} value=${payload.value} — possible replay/tamper`);
        }
    }

    const interpreted = await runPythonDriver(payload);
    console.log(`[${NODE_NAME}] ${payload.id || '?'} → ${interpreted}`);
    res.sendStatus(200);
});

// ── Fraud log inspection ───────────────────────────────────────────────────────
app.get('/fraud-log', (req, res) => {
    res.json({ node: NODE_NAME, fraudEvents: fraudLog, shunnedPeers: [...shunnedPeers] });
});

// ── On-Chain Jury: cross-validate peer analysis claims ────────────────────────
// When a peer gossips its analysis of a frame, we compare it against our own
// cached analysis for the same frameHash.  A conflicting status means the peer
// is lying about what the camera showed.
//
// Catch logic:
//   - Frame HMAC covers raw bytes only, NOT the derived status.  A lying node
//     can keep a valid frame HMAC while reporting a wrong status.
//   - We independently ran the same driver on the same frame and cached the
//     result.  If the statuses differ, fraud is certain.
//
// [LOG] Node A: Valid Signature - Analysis MOTION confirmed.
// [LOG] Node B: CONFLICT — reported NO_MOTION, we got MOTION. SLASHED.
app.post('/gossip/analysis', async (req, res) => {
    const { deviceId, frameHash, timestamp, reportedStatus, signature, publicKey } = req.body || {};
    const fromUrl  = req.headers['x-from']      || 'unknown';
    const fromName = req.headers['x-node-name'] || fromUrl;

    if (!deviceId || !frameHash || !reportedStatus) return res.sendStatus(400);

    // Skip shunned peers
    if (shunnedPeers.has(fromUrl)) {
        console.log(`[${NODE_NAME}] Ignored analysis gossip from shunned peer: ${fromName}`);
        return res.sendStatus(200);
    }

    // The device's frame HMAC authenticates the RAW FRAME, not the status.
    // We verify it to confirm the frame is genuine, but a valid HMAC does
    // not prove the analysis result is honest.
    const frameHmacValid = (signature && publicKey && timestamp)
        ? verifyFrameHMAC(deviceId, frameHash, timestamp, signature, publicKey)
        : null;

    // NOTE: "Frame HMAC: VALID" below means the L1 device genuinely signed this frame.
    // It does NOT validate this peer's analysis claim — a lying node forwards the original
    // L1 HMAC unchanged while reporting a false status.  Only cross-validation catches that.
    console.log(`\n[${NODE_NAME}] Analysis gossip from [${fromName}]`);
    console.log(`[${NODE_NAME}]    Device : ${deviceId} | Reported: ${reportedStatus}`);
    console.log(`[${NODE_NAME}]    Frame  : ${(frameHash || '').slice(0, 16)}... | L1 frame signature: ${frameHmacValid === null ? 'not provided' : frameHmacValid ? 'VALID (authenticates raw L1 frame only, NOT this peer\'s analysis)' : 'INVALID'}`);

    // Cross-validate against our own cached analysis for this frame
    const cacheKey   = `${deviceId}:${frameHash}`;
    const ownAnalysis = analysisCache.get(cacheKey);

    if (!ownAnalysis) {
        // We haven't processed this frame yet — store the claim so we can
        // retroactively cross-validate the moment our own analysis arrives.
        if (!pendingPeerClaims.has(cacheKey)) pendingPeerClaims.set(cacheKey, []);
        pendingPeerClaims.get(cacheKey).push(
            { fromUrl, fromName, reportedStatus, signature, publicKey, timestamp }
        );
        console.log(`[${NODE_NAME}]    No local analysis yet — claim stored for retroactive cross-validation.`);
        return res.sendStatus(200);
    }

    const ownStatus = ownAnalysis.status;
    console.log(`[${NODE_NAME}]    Our analysis  : ${ownStatus}`);
    console.log(`[${NODE_NAME}]    Peer reported : ${reportedStatus}`);

    if (ownStatus === reportedStatus) {
        console.log(`[${NODE_NAME}]    [LOG] Node ${fromName}: Analysis CONFIRMED — ${reportedStatus}. Transaction valid.`);
        return res.sendStatus(200);
    }

    // ── CONFLICT DETECTED ─────────────────────────────────────────────────────
    console.log(`[${NODE_NAME}] ╔════════════════════════════════════════════════════`);
    console.log(`[${NODE_NAME}]║  ANALYSIS CONFLICT DETECTED (On-Chain Jury trigger)`);
    console.log(`[${NODE_NAME}] ║  Peer      : ${fromName} (${fromUrl})`);
    console.log(`[${NODE_NAME}] ║  Device    : ${deviceId}`);
    console.log(`[${NODE_NAME}] ║  Frame     : ${(frameHash || '').slice(0, 16)}...`);
    console.log(`[${NODE_NAME}] ║  Peer says : ${reportedStatus}`);
    console.log(`[${NODE_NAME}] ║  We got    : ${ownStatus}`);
    console.log(`[${NODE_NAME}] ║  Verdict   : CHALLENGE PERIOD INITIATED — submitting to Solana`);
    console.log(`[${NODE_NAME}] ║`);
    console.log(`[${NODE_NAME}] ║  [LOG] Node ${fromName}: INVALID_STATUS_ERROR — Transaction Reverted. Node Slashed.`);
    console.log(`[${NODE_NAME}] ╚════════════════════════════════════════════════════\n`);

    // Shun the lying peer
    shunnedPeers.add(fromUrl);
    peers = peers.filter(p => p.url !== fromUrl);

    // Record fraud event
    const fraudEntry = {
        detectedAt:     new Date().toISOString(),
        kind:           'ANALYSIS_CONFLICT',
        accusingNode:   NODE_NAME,
        lyingPeer:      fromName,
        lyingPeerUrl:   fromUrl,
        deviceId,
        frameHash,
        timestamp,
        ownStatus,
        reportedStatus,
        verdict:        `Peer reported ${reportedStatus} — cross-validation returned ${ownStatus}`,
    };
    fraudLog.push(fraudEntry);

    // Persist to disk
    const logPath = 'fraud_log.json';
    try {
        const existing = fs.existsSync(logPath)
            ? JSON.parse(fs.readFileSync(logPath, 'utf8'))
            : [];
        existing.push(fraudEntry);
        fs.writeFileSync(logPath, JSON.stringify(existing, null, 2));
    } catch (e) {
        console.error(`[${NODE_NAME}] Could not write fraud log: ${e.message}`);
    }

    // Submit evidence to Solana
    const verdict = await submitAnalysisFraudToSolana(fraudEntry);
    fraudEntry.solanaVerdict = verdict;

    res.sendStatus(200);
});
// ── Video: receive JPEG frame from Layer 1 ──────────────────────────────────────────────────────
// L1 sends {id, type, frame (b64 JPEG), frameHash, timestamp, signature, publicKey}
// We verify the HMAC, run the assigned driver, buffer the annotated frame, then:
//   1. Cache own analysis for cross-validation against peer gossip.
//   2. Gossip own analysis to all peers (honest commit).
//   3. Commit analysis to Solana as the ground-truth record.
app.post('/frame', async (req, res) => {
    const { id, type, frame, frameHash, timestamp, signature, publicKey } = req.body;
    if (!id || !frame || !frameHash) return res.sendStatus(400);

    // Register / update device type
    if (type) deviceRegistry[id] = type;
    const resolvedType = deviceRegistry[id] || type;

    // Verify HMAC over frame hash
    if (signature && publicKey && timestamp) {
        const ok = verifyFrameHMAC(id, frameHash, timestamp, signature, publicKey);
        if (ok) {
            console.log(`[${NODE_NAME}] Frame HMAC valid | ${id}`);
        } else {
            console.warn(`[${NODE_NAME}] Frame HMAC INVALID for ${id} — possible replay/tamper`);
        }
    }

    // Run the frame-aware driver
    const payload = { id, type: resolvedType, frame, frameHash, timestamp, nodeId: NODE_NAME };
    const { analysis, jpegBuf } = await runFrameDriver(payload);

    let ownStatus = 'UNKNOWN';
    let ownMeta   = {};
    try {
        ownMeta   = JSON.parse(analysis);
        ownStatus = ownMeta.status ?? 'UNKNOWN';
        console.log(`[${NODE_NAME}] FRAME ${id} -> ${ownStatus} (diff=${ownMeta.frameDiff ?? '?'} brt=${ownMeta.brightness ?? '?'})`);
    } catch {
        console.log(`[${NODE_NAME}] FRAME ${id} -> ${analysis}`);
    }

    // Cache own analysis so /gossip/analysis can cross-validate peer claims
    const cacheKey = `${id}:${frameHash}`;
    analysisCache.set(cacheKey, { status: ownStatus, timestamp, ...ownMeta });
    // Evict old entries to prevent unbounded growth (keep last 500)
    if (analysisCache.size > 500) {
        const firstKey = analysisCache.keys().next().value;
        analysisCache.delete(firstKey);
    }

    // Retroactively cross-validate any peer claims that arrived before our analysis.
    // This is the fix for the race where Node B gossips BEFORE we finish processing:
    //   B sends NO_MOTION → we store the claim → we finish: got MOTION → CONFLICT.
    const pending = pendingPeerClaims.get(cacheKey);
    if (pending && pending.length) {
        pendingPeerClaims.delete(cacheKey);
        for (const claim of pending) {
            if (shunnedPeers.has(claim.fromUrl)) continue;
            if (claim.reportedStatus === ownStatus) {
                console.log(`[${NODE_NAME}] Retroactive check: ${claim.fromName} MATCH (${ownStatus})`);
                continue;
            }
            console.log(`[${NODE_NAME}] ╔══ RETROACTIVE CONFLICT DETECTED ════════════════════`);
            console.log(`[${NODE_NAME}] ║  Peer : ${claim.fromName} reported ${claim.reportedStatus}`);
            console.log(`[${NODE_NAME}] ║  We got (now) : ${ownStatus}`);
            console.log(`[${NODE_NAME}] ║  Frame : ${(frameHash || '').slice(0, 16)}...`);
            console.log(`[${NODE_NAME}] ╚════════════════════════════════════════════════════\n`);
            shunnedPeers.add(claim.fromUrl);
            peers = peers.filter(p => p.url !== claim.fromUrl);
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
            fraudLog.push(fraudEntry);
            try {
                const existing = fs.existsSync('fraud_log.json')
                    ? JSON.parse(fs.readFileSync('fraud_log.json', 'utf8')) : [];
                existing.push(fraudEntry);
                fs.writeFileSync('fraud_log.json', JSON.stringify(existing, null, 2));
            } catch {}
            submitAnalysisFraudToSolana(fraudEntry).catch(() => {});
        }
    }

    // Feed the annotated frame into the MJPEG broadcaster
    if (jpegBuf) pushFrameToMjpegClients(id, jpegBuf);

    // Gossip own (honest) analysis to all peers — they will cross-validate it
    // and flag a conflict if another peer reported a different status.
    const analysisGossip = {
        deviceId:       id,
        frameHash,
        timestamp,
        reportedStatus: ownStatus,
        signature,
        publicKey,
    };
    gossipAnalysisToAll(analysisGossip).catch(() => {});

    // Enqueue for the next Solana batch flush (sent every 30 s or on 15 reports).
    // This avoids hitting the devnet RPC rate limit at ~10 fps.
    enqueueAnalysis({ deviceId: id, frameHash, timestamp, status: ownStatus });

    res.sendStatus(200);
});

// ── Video: MJPEG live stream ────────────────────────────────────────────────────────────────────
// Any browser / dashboard can view the live annotated feed:
//   <img src="http://<L2-IP>:<PORT>/video_feed?id=WEBCAM_01">
app.get('/video_feed', (req, res) => {
    const deviceId = req.query.id || [...latestFrames.keys()][0] || 'WEBCAM_01';

    // Disable Nagle's algorithm so each frame is sent immediately
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
    // Flush headers to the client immediately so the browser starts parsing
    res.flushHeaders();

    // Register this client
    if (!mjpegClients.has(deviceId)) mjpegClients.set(deviceId, new Set());
    mjpegClients.get(deviceId).add(res);
    console.log(`[${NODE_NAME}] MJPEG client connected for ${deviceId}`);

    // Immediately send the latest cached frame so the stream isn't blank
    const latest = latestFrames.get(deviceId);
    if (latest) writeMjpegFrame(res, latest);

    req.on('close', () => {
        mjpegClients.get(deviceId)?.delete(res);
        console.log(`[${NODE_NAME}] MJPEG client disconnected for ${deviceId}`);
    });
});
// ─── UDP Discovery (answers L1 sensor broadcasts) ─────────────────────────────
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

// ─── Mesh join: fetch peers from bootstrap, announce self ─────────────────────
async function joinMesh() {
    if (!BOOTSTRAP_URL || BOOTSTRAP_URL === OWN_URL) {
        console.log(`[${NODE_NAME}] First node in mesh — waiting for peers to gossip in.`);
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
        console.warn(`[${NODE_NAME}] Bootstrap ${BOOTSTRAP_URL} unreachable: ${e.message}`);
    }

    // Announce ourselves to all known peers
    for (const p of peers) {
        try {
            await fetch(`${p.url}/gossip/peer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-from': OWN_URL },
                body: JSON.stringify({ name: NODE_NAME, url: OWN_URL }),
                signal: AbortSignal.timeout(3000),
            });
        } catch { /* not yet up */ }
    }
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
    startUdpDiscovery();

    app.listen(PORT, async () => {
        console.log(`\n[${NODE_NAME}] Layer 2 node running on port ${PORT}`);
        console.log(`[${NODE_NAME}] LAN IP: ${getLocalIP()} | URL: ${OWN_URL}`);
        console.log(`[${NODE_NAME}] Bootstrap: ${BOOTSTRAP_URL || 'none (I am the first node)'}\n`);

        await joinMesh();

        // Periodic Solana analysis batch flush
        setInterval(() => flushAnalysisBatch().catch(() => {}), ANALYSIS_BATCH_INTERVAL_MS);

        // Peer health watcher — self-adjusting interval
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
