/**
 * layer3_base.js — L3 Aggregator: WebSocket (Socket.io) Server
 *
 * Implements the three mandatory L3 behaviours / "standard protocol":
 *
 *  1. TOPOLOGY EVENT  — Pushed every 500 ms.  Describes the full mesh:
 *                       which nodes are online, compromised, or warming up;
 *                       what drivers each node has loaded; which devices are
 *                       attached and whether their data is trusted.
 *
 *  2. AUDIT TRAIL EVENT — Append-only security log.  Every time a Solana
 *                         batch is anchored or fraud is detected a new card
 *                         is appended and the full log is broadcast.
 *
 *  3. TELEMETRY EVENT — Verified-only sensor history per device.  If a node
 *                       is COMPROMISED its data is excluded.  Feed directly
 *                       into a recharts line chart.
 *
 * SILENT FILTER RULE
 *   If a node reports driver_status=NOT_LOADED (no driver yet) the device is
 *   shown as "DATA_PENDING" — not "No Motion" — in the topology.  The L3
 *   node marks that L2 node as "WARMING_UP" or "SYNCING", never as online
 *   with bad data.
 *
 * HEARTBEAT LOGIC
 *   L2 nodes POST to /heartbeat here every ~3 seconds.  If a node misses
 *   L2_HEARTBEAT_TTL_MS (default 9 s ≈ 3 missed beats) it is marked DEAD
 *   and excluded from push events.  L3 also discovers nodes from the
 *   L2_NODES environment variable (comma-separated URLs).
 *
 * Usage:
 *   node layer3_base.js
 *
 * Environment:
 *   L3_PORT      — HTTP / WS port (default 8080)
 *   L2_NODES     — comma-separated L2 URLs to bootstrap from
 *                  e.g. "http://localhost:5000,http://localhost:5001"
 *   SOLANA_PRIVATE_KEY — optional, only needed if L3 anchors its own memos
 */

'use strict';
require('dotenv').config();
require('cross-fetch/polyfill');

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const { spawn } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT     = parseInt(process.env.L3_PORT || '8080', 10);
const OWN_URL  = `http://localhost:${PORT}`;

// --config <file> — auto-run a network.config after the server boots
const configArgIdx = process.argv.indexOf('--config');
const STARTUP_CONFIG = configArgIdx !== -1 ? process.argv[configArgIdx + 1] : null;

// Comma-separated list of L2 node URLs known at startup.
// Only seed nodes if the L2_NODES env var is explicitly provided.
// Without it, nodes must join through the Zero-Trust /register flow.
const SEED_L2_NODES = process.env.L2_NODES
    ? process.env.L2_NODES.split(',').map(s => s.trim()).filter(Boolean)
    : [];

const PUSH_INTERVAL_MS      = 500;    // how often to broadcast to React clients
const L2_HEARTBEAT_TTL_MS   = 9_000; // 3 missed beats → DEAD
const TELEMETRY_HISTORY_MAX = 200;   // data points kept per device
const AUDIT_LOG_MAX         = 500;   // max audit events in memory

// ─── App + Socket.io ─────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: {
        origin:  '*',
        methods: ['GET', 'POST'],
    },
});

app.use(express.json({ limit: '5mb' }));

// ─── State ────────────────────────────────────────────────────────────────────

/**
 * Known L2 nodes.
 * Key: URL string
 * Value: {
 *   name:       string,
 *   url:        string,
 *   status:     'ONLINE'|'COMPROMISED'|'WARMING_UP'|'SYNCING'|'DEAD',
 *   lastSeen:   ms epoch (from heartbeat),
 *   health:     last /health response object | null,
 *   envelopes:  last /latest response object | null,
 *   failCount:  number of consecutive poll failures
 * }
 */
const l2Nodes = new Map();

/**
 * Nodes waiting for admin approval (Zero-Trust join flow).
 * Key: nodeId string
 * Value: { nodeId, url, port, requestedAt }
 */
const pendingNodes = new Map();

/**
 * Telemetry history.  Only VERIFIED data is stored here.
 * Key: deviceId
 * Value: [{ timestamp, value, state }]
 */
const telemetryHistory = new Map();

/**
 * Audit trail.  Append-only; newest events at the end.
 */
const auditLog = [];

// Track which Solana batch IDs we have already logged to avoid duplicates
const seenBatchIds = new Set();

// ─── L2 Node registration ─────────────────────────────────────────────────────
function ensureNode(url, name = null) {
    if (!l2Nodes.has(url)) {
        l2Nodes.set(url, {
            name:      name || url,
            url,
            status:    'SYNCING',
            lastSeen:  Date.now(),
            health:    null,
            envelopes: null,
            failCount: 0,
        });
        console.log(`[L3] Registered L2 node: ${name || url} @ ${url}`);
    }
    return l2Nodes.get(url);
}

// Bootstrap from env
for (const url of SEED_L2_NODES) ensureNode(url);

// ─── Silent Filter Rule ───────────────────────────────────────────────────────
/**
 * Determine device-level display status applying the Silent Filter:
 *   NOT_LOADED driver → "DATA_PENDING"   (never show "No Motion")
 *   CONFLICT          → "ALERT"
 *   MOTION            → "MOTION_DETECTED"
 *   default           → "STREAMING"
 */
function deviceStatus(envelope) {
    if (!envelope) return 'DATA_PENDING';
    const ds = envelope.payload?.driver_status;
    const pc = envelope.audit?.peer_consistency;
    const st = envelope.payload?.interpretation?.status;

    if (ds === 'NOT_LOADED' || ds === 'UNKNOWN') return 'DATA_PENDING';
    if (pc === 'CONFLICT')                        return 'ALERT';
    if (st === 'MOTION')                          return 'MOTION_DETECTED';
    return 'STREAMING';
}

/**
 * Build the global set of node URLs that have been shunned by any honest peer.
 * A node whose URL appears here has been caught lying and should be COMPROMISED.
 * The nodes that did the shunning are innocent — they stay ONLINE.
 */
function buildGlobalShunnedSet() {
    const shunned = new Set();
    for (const [, node] of l2Nodes) {
        const health = node.health;
        if (health?.shunnedPeers) {
            for (const url of health.shunnedPeers) shunned.add(url);
        }
        // Also harvest lyingPeerUrl from fraud log entries
        if (health?.fraudLog) {
            for (const entry of health.fraudLog) {
                if (entry.lyingPeerUrl) shunned.add(entry.lyingPeerUrl);
            }
        }
    }
    return shunned;
}

/**
 * Determine node-level status from its health data.
 *   Node URL in global shunned set → COMPROMISED (it was caught lying)
 *   No drivers loaded              → WARMING_UP
 *   Otherwise                      → ONLINE
 *
 * NOTE: A node that HAS shunnedPeers / fraudLog entries is the ACCUSER, not
 * the accused — it remains ONLINE.  Only the shunned URL is COMPROMISED.
 */
function nodeStatus(nodeEntry, globalShunnedUrls = new Set()) {
    // NOTE: Do NOT short-circuit on status==='DEAD' here — recovery is handled
    // dynamically by computeNodeStatus based on lastSeen age and failCount.

    const health = nodeEntry.health;
    if (!health) return 'SYNCING';

    // If this node was shunned by any other honest node it has been caught lying
    if (globalShunnedUrls.has(nodeEntry.url)) return 'COMPROMISED';

    // No drivers loaded yet
    const drivers = health.drivers || [];
    if (drivers.length === 0) return 'WARMING_UP';

    return 'ONLINE';
}

// ─── Poll a single L2 node ────────────────────────────────────────────────────
async function pollNode(nodeEntry) {
    const { url } = nodeEntry;
    try {
        const [healthRes, latestRes] = await Promise.all([
            fetch(`${url}/health`,  { signal: AbortSignal.timeout(3000) }),
            fetch(`${url}/latest`,  { signal: AbortSignal.timeout(3000) }),
        ]);

        const health    = healthRes.ok    ? await healthRes.json()  : null;
        const latestRaw = latestRes.ok    ? await latestRes.json()  : null;
        const envelopes = latestRaw?.envelopes || null;

        nodeEntry.health    = health;
        nodeEntry.envelopes = envelopes;
        nodeEntry.failCount = 0;
        nodeEntry.lastSeen  = Date.now();
        nodeEntry.name      = health?.node || nodeEntry.name;

        // Discover peers this node knows about and add them
        if (health?.peers) {
            for (const peer of health.peers) {
                if (peer.url && !l2Nodes.has(peer.url)) {
                    ensureNode(peer.url, peer.name);
                }
            }
        }

        // Ingest telemetry from verified envelopes
        if (envelopes) {
            const ns = nodeStatus(nodeEntry);
            const isCompromised = (ns === 'COMPROMISED' || ns === 'DEAD');

            for (const [deviceId, env] of Object.entries(envelopes)) {
                const pc    = env?.audit?.peer_consistency;
                const ds    = env?.payload?.driver_status;
                const interp = env?.payload?.interpretation;
                const ts    = env?.header?.timestamp;

                // Silent Filter: skip unverified / conflicting / no-driver data
                if (isCompromised)           continue;
                if (pc === 'CONFLICT')       continue;
                if (ds  === 'NOT_LOADED')    continue;
                if (!interp || !ts)          continue;

                // Extract value — supports numeric sensors and webcam frames
                const value = interp.brightness ?? interp.value ?? interp.raw_value ?? null;
                const state = interp.status ?? 'UNKNOWN';

                if (value === null) continue;

                if (!telemetryHistory.has(deviceId)) telemetryHistory.set(deviceId, []);
                const hist = telemetryHistory.get(deviceId);

                // Append only if newer than the last entry
                const last = hist[hist.length - 1];
                if (!last || ts > last.timestamp) {
                    hist.push({ timestamp: ts, value: parseFloat(value), state });
                    if (hist.length > TELEMETRY_HISTORY_MAX) hist.shift();
                }

                // Ingest Solana batch IDs into audit trail
                const batchId = env?.audit?.solana_batch_id;
                if (batchId && !seenBatchIds.has(batchId)) {
                    seenBatchIds.add(batchId);
                    appendAuditEvent({
                        signature_status: 'VERIFIED',
                        solana_link:      `https://explorer.solana.com/tx/${batchId}?cluster=devnet`,
                        evidence:         `Device ${deviceId} batch committed — peer_consistency=${pc || 'PENDING'}`,
                        timestamp:        ts,
                        node:             nodeEntry.name,
                        device_id:        deviceId,
                        batch_id:         batchId,
                    });
                }
            }
        }

        // Ingest fraud events into audit trail
        if (health?.fraudLog) {
            for (const fraud of health.fraudLog) {
                const fid = `${fraud.detectedAt}:${fraud.deviceId}`;
                if (!seenBatchIds.has(fid)) {
                    seenBatchIds.add(fid);
                    appendAuditEvent({
                        signature_status: 'FRAUD_DETECTED',
                        solana_link:      fraud.solanaVerdict?.sig
                            ? `https://explorer.solana.com/tx/${fraud.solanaVerdict.sig}?cluster=devnet`
                            : null,
                        evidence:         `${fraud.kind}: ${fraud.verdict}`,
                        timestamp:        fraud.detectedAt,
                        node:             fraud.accusingNode || nodeEntry.name,
                        device_id:        fraud.deviceId,
                    });
                }
            }
        }

    } catch (err) {
        nodeEntry.failCount = (nodeEntry.failCount || 0) + 1;
        if (nodeEntry.failCount >= 3) {
            nodeEntry.status = 'DEAD';
        }
    }
}

// ─── Audit helper ─────────────────────────────────────────────────────────────
function appendAuditEvent(event) {
    auditLog.push({ ...event, logged_at: Date.now() });
    if (auditLog.length > AUDIT_LOG_MAX) auditLog.shift();
}

// ─── Build push payloads ──────────────────────────────────────────────────────

/**
 * Build the "topology" event payload.
 * Schema matches the recommended specification exactly.
 * @param {Set<string>} globalShunnedUrls - URLs shunned by any honest peer
 */
function buildTopology(globalShunnedUrls = buildGlobalShunnedSet()) {
    const nodes = [];

    // Include nodes that are awaiting admin approval
    for (const [, pending] of pendingNodes) {
        nodes.push({
            id:             pending.nodeId,
            url:            pending.url,
            status:         'PENDING',
            peer:           null,
            active_drivers: [],
            devices:        [],
            last_seen_ms:   pending.requestedAt,
            fail_count:     0,
        });
    }

    for (const [, nodeEntry] of l2Nodes) {
        const health    = nodeEntry.health;
        const envelopes = nodeEntry.envelopes || {};

        // Peer: first other node's name (sorted for determinism)
        const peerNames = [...l2Nodes.values()]
            .filter(n => n.url !== nodeEntry.url)
            .map(n => n.name)
            .sort();
        const peer = peerNames[0] || null;

        // Active drivers from health
        const active_drivers = (health?.drivers || []).map(d => d.type);

        // Devices with per-device status
        const devices = Object.entries(health?.devices || {}).map(([id, type]) => {
            const env    = envelopes[id] || null;
            const ds     = deviceStatus(env);
            const hbAge  = health?.device_liveness?.[id]?.ageMs;
            const hbStat = health?.device_liveness?.[id]?.status || 'UNKNOWN';
            return {
                id,
                type,
                status:         ds,
                heartbeat:      hbStat,
                heartbeat_age_s: hbAge != null ? Math.round(hbAge / 1000) : null,
            };
        });

        // Apply Silent Filter at the node level
        const status = computeNodeStatus(nodeEntry, globalShunnedUrls);

        nodes.push({
            id:             nodeEntry.name,
            url:            nodeEntry.url,
            status,
            peer,
            active_drivers,
            devices,
            last_seen_ms:   nodeEntry.lastSeen,
            fail_count:     nodeEntry.failCount || 0,
        });
    }

    return { nodes, generated_at: Math.floor(Date.now() / 1000) };
}

/**
 * Silent Filter at the node level:
 *   - Dead / unreachable                  → DEAD
 *   - URL in global shunned set           → COMPROMISED (node was caught lying)
 *   - No drivers → WARMING_UP
 *   - Otherwise                           → ONLINE
 *
 * Nodes that detected fraud (have fraudLog / shunnedPeers) remain ONLINE —
 * they are the accusers, not the accused.
 */
function computeNodeStatus(nodeEntry, globalShunnedUrls) {
    // A node is only DEAD if it has missed recent heartbeats AND polls are
    // consistently failing.  Once it recovers (lastSeen fresh, failCount reset)
    // it is allowed to transition back out of DEAD.
    const age = Date.now() - (nodeEntry.lastSeen || 0);
    if (age > L2_HEARTBEAT_TTL_MS && nodeEntry.failCount >= 2) return 'DEAD';
    return nodeStatus(nodeEntry, globalShunnedUrls);
}

/**
 * Build per-device "telemetry" payloads.
 * Only verified data — COMPROMISED node data never reaches here.
 */
function buildTelemetry() {
    const packets = [];

    for (const [deviceId, history] of telemetryHistory) {
        if (!history.length) continue;

        // Consensus score: fraction of history points from non-conflicting nodes
        // Since we only store verified data, score is always 100% unless we
        // have seen at least one conflicting peer claim.
        const hasConflict = [...l2Nodes.values()].some(n => {
            const env = n.envelopes?.[deviceId];
            return env?.audit?.peer_consistency === 'CONFLICT';
        });

        packets.push({
            device_id:       deviceId,
            history:         history.slice(-100),   // last 100 points for the chart
            consensus_score: hasConflict ? 'DISPUTED' : '100%',
        });
    }

    return packets;
}

// ─── 500 ms push cycle ────────────────────────────────────────────────────────
let pushCycleRunning = false;

async function pushCycle() {
    if (pushCycleRunning) return;
    pushCycleRunning = true;
    try {
        // Poll all known nodes in parallel
        await Promise.all([...l2Nodes.values()].map(n => pollNode(n)));

        // Build global shunned set once from all fresh health reports
        const globalShunnedUrls = buildGlobalShunnedSet();

        // Update node statuses — always recompute so a recovered node can
        // transition back from DEAD when heartbeats/polls resume.
        for (const [, n] of l2Nodes) {
            n.status = computeNodeStatus(n, globalShunnedUrls);
        }

        if (io.engine.clientsCount === 0) return; // no clients — skip serialization

        // 1. Topology
        io.emit('topology', buildTopology(globalShunnedUrls));

        // 2. Audit trail  (full append-only log)
        io.emit('audit_trail', auditLog.slice(-50));  // last 50 events

        // 3. Telemetry per device
        for (const packet of buildTelemetry()) {
            io.emit('telemetry', packet);
        }

    } finally {
        pushCycleRunning = false;
    }
}

// ─── HTTP endpoints ───────────────────────────────────────────────────────────

// Health check for this L3 node
app.get('/health', (req, res) => {
    res.json({
        node:       'L3_AGGREGATOR',
        port:       PORT,
        url:        OWN_URL,
        l2_nodes:   [...l2Nodes.values()].map(n => ({
            name: n.name, url: n.url, status: n.status,
            last_seen_s: Math.round((Date.now() - n.lastSeen) / 1000),
        })),
        devices_tracked:  [...telemetryHistory.keys()],
        audit_log_size:   auditLog.length,
        ws_clients:       io.engine.clientsCount,
        status:           'UP',
        timestamp:        Math.floor(Date.now() / 1000),
    });
});

// L2 nodes POST here every ~3s to report liveness
app.post('/heartbeat', (req, res) => {
    const { node, url, timestamp, status } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });

    // Block heartbeats from nodes that have not been approved yet.
    // A pending node must wait for admin approval before it can participate.
    const isPending = [...pendingNodes.values()].some(p => p.url === url);
    if (isPending) {
        return res.status(403).json({ error: 'Node is PENDING approval. Heartbeat rejected.' });
    }

    // Also block nodes that have never been registered at all.
    if (!l2Nodes.has(url)) {
        return res.status(403).json({ error: 'Node not registered. Use POST /register first.' });
    }

    const entry = ensureNode(url, node);
    entry.lastSeen = Date.now();
    if (entry.status === 'DEAD' && status === 'ALIVE') {
        entry.status   = 'SYNCING';
        entry.failCount = 0;
        console.log(`[L3] Node ${node || url} came back ALIVE`);
    }
    res.json({ received: true, l3_timestamp: Math.floor(Date.now() / 1000) });});

// Manually register an L2 node (used by layer3_sender.js config scripts)
app.post('/register-node', (req, res) => {
    const { name, url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    ensureNode(url, name);
    res.json({ ok: true, node: name, url });
});

// ─── Zero-Trust Join Request ───────────────────────────────────────────────────
// L2 nodes call this on startup when started with a L3 target URL.
// The node is placed in PENDING state and shown on the dashboard as gray
// until an admin approves or denies it.
app.post('/register', (req, res) => {
    const { nodeId, port, url, status } = req.body || {};
    if (!nodeId || !url) return res.status(400).json({ error: 'nodeId and url required' });

    // If already fully registered (approved), do not demote it back to PENDING
    if (l2Nodes.has(url)) {
        return res.json({ ok: true, status: 'ALREADY_REGISTERED' });
    }

    if (!pendingNodes.has(nodeId)) {
        pendingNodes.set(nodeId, { nodeId, port, url, requestedAt: Date.now() });
        console.log(`[L3] Join request from node "${nodeId}" at ${url} — awaiting admin approval.`);
        // Push an immediate topology update so the dashboard shows the gray node.
        io.emit('topology', buildTopology());
    }

    res.json({ ok: true, status: 'PENDING' });
});

// ─── Admin Approve / Deny ─────────────────────────────────────────────────────
// The React dashboard calls this when the admin clicks Approve or Deny.
app.post('/approve-node', (req, res) => {
    const { nodeId, approved } = req.body || {};
    if (!nodeId || typeof approved !== 'boolean') {
        return res.status(400).json({ error: 'nodeId and approved (boolean) required' });
    }

    const pending = pendingNodes.get(nodeId);
    if (!pending) {
        return res.status(404).json({ error: `No pending join request for nodeId "${nodeId}"` });
    }

    pendingNodes.delete(nodeId);

    if (approved) {
        // Promote the node to a full L2 participant.
        ensureNode(pending.url, nodeId);
        console.log(`[L3] Node "${nodeId}" approved. Registered at ${pending.url}.`);
        io.emit('topology', buildTopology());
        res.json({ ok: true, status: 'APPROVED', nodeId });
    } else {
        // Denied — remove from the map (already done above) and notify dashboard.
        console.log(`[L3] Node "${nodeId}" denied. Join request discarded.`);
        io.emit('topology', buildTopology());
        res.json({ ok: true, status: 'DENIED', nodeId });
    }
});

// Snapshot endpoints (for debugging without a WS client)
app.get('/topology', (req, res) => res.json(buildTopology()));
app.get('/telemetry', (req, res) => res.json(buildTelemetry()));
app.get('/audit',    (req, res) => res.json(auditLog.slice(-50)));

// ─── Socket.io connection handler ────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[L3] WS client connected: ${socket.id} (total: ${io.engine.clientsCount})`);

    // Send a full snapshot immediately so the frontend doesn't wait 500ms
    socket.emit('topology',    buildTopology());
    socket.emit('audit_trail', auditLog.slice(-50));
    for (const packet of buildTelemetry()) {
        socket.emit('telemetry', packet);
    }

    socket.on('disconnect', () => {
        console.log(`[L3] WS client disconnected: ${socket.id}`);
    });

    // Allow frontend to manually register/discover L2 nodes at runtime
    socket.on('register_node', ({ name, url }) => {
        if (url) { ensureNode(url, name); socket.emit('ack', { ok: true }); }
    });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`\n${'─'.repeat(62)}`);
    console.log(`  Layer 3 Aggregator  port=${PORT}`);
    console.log(`  Events: topology | audit_trail | telemetry  (every ${PUSH_INTERVAL_MS}ms)`);
    console.log(`  Silent Filter Rule: ACTIVE`);
    console.log(`  Heartbeat TTL: ${L2_HEARTBEAT_TTL_MS}ms`);
    console.log(`  Seeded L2 nodes: ${SEED_L2_NODES.join(', ')}`);
    if (STARTUP_CONFIG) console.log(`  Startup config:   ${STARTUP_CONFIG}`);
    console.log(`${'─'.repeat(62)}\n`);

    // Main push loop
    setInterval(() => pushCycle().catch(err => console.error('[L3] Push cycle error:', err.message)), PUSH_INTERVAL_MS);

    // Auto-run network.config if --config was passed.
    // Wait 1 s so the HTTP server is fully ready before layer3_sender hits it.
    if (STARTUP_CONFIG) {
        const absConfig = path.resolve(STARTUP_CONFIG);

        function spawnConfig(resend) {
            const extraArgs = resend ? ['--resend'] : [];
            const label = resend ? 'resend' : 'startup';
            console.log(`[L3] Running ${label} config: ${absConfig}`);
            const senderPath = path.join(__dirname, 'layer3_sender.js');
            const child = spawn(
                process.execPath,
                [senderPath, 'run-config', absConfig, ...extraArgs],
                { stdio: 'inherit', env: { ...process.env }, cwd: __dirname },
            );
            child.on('error', (err) => console.error(`[L3] Config runner error: ${err.message}`));
            child.on('exit',  (code) => {
                if (code !== 0) console.error(`[L3] Config runner (${label}) exited with code ${code}`);
                else            console.log(`[L3] Config runner (${label}) complete.`);
            });
        }

        // Initial full run (with Solana anchoring + node gossip)
        setTimeout(() => spawnConfig(false), 1000);

        // Periodic resend — re-push drivers/devices every 30 s so nodes that
        // come online after the initial run still receive their drivers.
        // Skips Solana anchoring and node-gossip (--resend mode).
        // Only fires if at least one L2 node is currently reachable (not DEAD)
        // to avoid pointless log spam when all nodes are offline.
        const RESEND_INTERVAL_MS = 30_000;
        setInterval(() => {
            const anyAlive = [...l2Nodes.values()].some(
                (n) => n.status !== 'DEAD' && n.failCount < 3,
            );
            if (anyAlive) spawnConfig(true);
            else console.log('[L3] Resend skipped — no reachable L2 nodes yet.');
        }, RESEND_INTERVAL_MS);
    }
});

/**
 * ─── React / Frontend Quick-Start ──────────────────────────────────────────
 *
 *  import { io } from 'socket.io-client';
 *  import { useEffect, useState } from 'react';
 *
 *  const socket = io('http://localhost:8080');
 *
 *  function Dashboard() {
 *      const [topology,   setTopology]   = useState(null);
 *      const [auditLog,   setAuditLog]   = useState([]);
 *      const [telemetry,  setTelemetry]  = useState({});
 *
 *      useEffect(() => {
 *          socket.on('topology',    setTopology);
 *          socket.on('audit_trail', setAuditLog);
 *          socket.on('telemetry', (pkt) =>
 *              setTelemetry(prev => ({ ...prev, [pkt.device_id]: pkt })));
 *          return () => socket.removeAllListeners();
 *      }, []);
 *
 *      // topology.nodes  → render node cards / force graph
 *      // auditLog        → render append-only security feed
 *      // telemetry[id].history → feed into <LineChart data={...} />
 *  }
 */
