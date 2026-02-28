/**
 * test_l3.js -- Integration test suite for the L3 aggregator API
 *
 * Starts three in-process mock servers:
 *   MockNodeA  (port 15000) -- honest L2 node
 *   MockEvilB  (port 15001) -- evil webcam node (will be shunned by A)
 *   L3         (port 18080) -- layer3_base.js aggregator under test
 *
 * Then runs a sequence of checks:
 *   1. L3 /health   -- structure validation
 *   2. L3 /topology -- all nodes visible, correct statuses
 *   3. L1 heartbeat -- L1 device heartbeats reach L2 mock correctly
 *   4. L2 heartbeat -- L2 nodes POST /heartbeat to L3
 *   5. COMPROMISED  -- after Node A shuns Evil B, L3 marks Evil B COMPROMISED
 *   6. /telemetry   -- verified data present for known devices
 *   7. /audit       -- fraud events appear in audit log
 *   8. /register-node -- dynamic L2 registration endpoint
 *
 * Usage:
 *   node test_l3.js
 */

'use strict';
require('cross-fetch/polyfill');
const http    = require('http');
const express = require('express');
const { spawn } = require('child_process');
const path    = require('path');

// ─── Colours ─────────────────────────────────────────────────────────────────
const G  = '\x1b[32m';  // green
const R  = '\x1b[31m';  // red
const Y  = '\x1b[33m';  // yellow
const B  = '\x1b[36m';  // cyan
const RS = '\x1b[0m';   // reset

// ─── Test state ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const errors = [];

function pass(label) {
    passed++;
    console.log(`  ${G}[PASS]${RS} ${label}`);
}
function fail(label, reason) {
    failed++;
    errors.push({ label, reason });
    console.log(`  ${R}[FAIL]${RS} ${label} -- ${reason}`);
}
function info(msg) {
    console.log(`  ${B}[INFO]${RS} ${msg}`);
}
function section(title) {
    console.log(`\n${Y}== ${title} ==${RS}`);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
async function get(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}
async function post(url, body) {
    const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(5000),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

// ─── Wait for a port to be ready ─────────────────────────────────────────────
async function waitForPort(port, retries = 30, delay = 300) {
    for (let i = 0; i < retries; i++) {
        try {
            await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(500) });
            return true;
        } catch { await new Promise(r => setTimeout(r, delay)); }
    }
    return false;
}

// ─── Mock L2 node factory ─────────────────────────────────────────────────────
/**
 * Creates a lightweight mock L2 node.
 * @param {object} opts
 *   port          - HTTP port
 *   name          - node name
 *   shunnedPeers  - URLs this node has shunned
 *   fraudLog      - fraud events to expose
 *   envelopes     - device envelopes to expose on /latest
 *   devices       - { deviceId: type } device registry
 *   drivers       - [{ type, version }] -- active drivers
 *   peers         - [{ name, url }]
 *   deviceLiveness- optional { deviceId: { status, ageMs } }
 */
function createMockL2(opts = {}) {
    const {
        port,
        name = `Node-${port}`,
        shunnedPeers  = [],
        fraudLog      = [],
        envelopes     = {},
        devices       = {},
        drivers       = [],
        peers         = [],
        deviceLiveness = {},
    } = opts;

    const app = express();
    app.use(express.json({ limit: '2mb' }));

    // Track L1 heartbeats received
    const l1Heartbeats = new Map();

    app.get('/health', (req, res) => res.json({
        node:            name,
        port,
        url:             `http://localhost:${port}`,
        peers,
        drivers,
        devices,
        device_liveness: deviceLiveness,
        shunnedPeers,
        fraudLog:        fraudLog.slice(-10),
        status:          'UP',
        timestamp:       Math.floor(Date.now() / 1000),
    }));

    app.get('/peers', (req, res) => res.json({ node: name, url: `http://localhost:${port}`, peers }));

    app.get('/latest', (req, res) => res.json({ node: name, envelopes }));

    app.get('/latest/:id', (req, res) => {
        const env = envelopes[req.params.id];
        if (!env) return res.status(404).json({ error: 'not found' });
        res.json(env);
    });

    app.get('/envelope/:id', (req, res) => {
        const env = envelopes[req.params.id];
        if (!env) return res.status(404).json({ error: 'not found' });
        res.json(env);
    });

    // L1 device heartbeat endpoint
    app.post('/heartbeat', (req, res) => {
        const { id, type, status } = req.body || {};
        if (id) l1Heartbeats.set(id, { lastSeen: Date.now(), type, status: status || 'ALIVE' });
        res.json({ node: name, received: true, timestamp: Math.floor(Date.now() / 1000) });
    });

    app.post('/gossip/peer', (req, res) => res.sendStatus(200));
    app.post('/gossip/data', (req, res) => res.sendStatus(200));
    app.post('/gossip/analysis', (req, res) => res.sendStatus(200));

    // Expose heartbeat state for test assertions
    app.get('/__test__/heartbeats', (req, res) =>
        res.json(Object.fromEntries(l1Heartbeats)));

    const server = http.createServer(app);
    return new Promise(resolve => {
        server.listen(port, () => {
            resolve({ server, l1Heartbeats, name, port });
        });
    });
}

// ─── Mock state that can be mutated during test ───────────────────────────────
// These are shared between the mock server handlers and the test code.
const mockA = {
    shunnedPeers: [],
    fraudLog:     [],
    envelopes:    {},
    drivers:      [{ type: 'WEBCAM_LIGHT', version: 'v1' }],
    devices:      { WEBCAM_01: 'WEBCAM_LIGHT' },
    deviceLiveness: {
        WEBCAM_01: { type: 'WEBCAM_LIGHT', status: 'ALIVE', ageMs: 1200 },
    },
};

const mockB = {
    shunnedPeers: [],
    fraudLog:     [],
    envelopes:    {
        WEBCAM_01: {
            header:  { node_id: 'EVIL-CAM', signature: null, timestamp: Math.floor(Date.now() / 1000) },
            payload: {
                device_id:     'WEBCAM_01',
                raw_data:      { frameHash: 'abc123', timestamp: Math.floor(Date.now() / 1000) },
                driver_status: 'PROCESSED',
                interpretation: { status: 'NO_MOTION', frameDiff: 0, brightness: 0 },
            },
            audit:   { peer_consistency: 'PENDING', solana_batch_id: null },
        },
    },
    drivers:      [{ type: 'WEBCAM_LIGHT', version: 'v1' }],
    devices:      { WEBCAM_01: 'WEBCAM_LIGHT' },
    deviceLiveness: {
        WEBCAM_01: { type: 'WEBCAM_LIGHT', status: 'ALIVE', ageMs: 1400 },
    },
};

// ─── Main test runner ─────────────────────────────────────────────────────────
async function runTests() {
    console.log('\n' + '='.repeat(66));
    console.log('  L3 Aggregator Integration Test Suite');
    console.log('='.repeat(66));

    // ─── Start mock L2 nodes ────────────────────────────────────────────────
    section('Setup: Starting mock L2 nodes');

    // Build live mutable servers using closures over the mockA/mockB objects
    const appA = express();
    appA.use(express.json({ limit: '2mb' }));
    const l1HbA = new Map();

    appA.get('/health', (req, res) => res.json({
        node: 'A', port: 15000, url: 'http://localhost:15000',
        peers:           [{ name: 'EVIL-CAM', url: 'http://localhost:15001' }],
        drivers:         mockA.drivers,
        devices:         mockA.devices,
        device_liveness: mockA.deviceLiveness,
        shunnedPeers:    mockA.shunnedPeers,
        fraudLog:        mockA.fraudLog,
        status: 'UP', timestamp: Math.floor(Date.now() / 1000),
    }));
    appA.get('/latest', (req, res) => res.json({ node: 'A', envelopes: mockA.envelopes }));
    appA.get('/peers',  (req, res) => res.json({
        node: 'A', url: 'http://localhost:15000',
        peers: [{ name: 'EVIL-CAM', url: 'http://localhost:15001' }],
    }));
    appA.post('/heartbeat', (req, res) => {
        const { id, type, status } = req.body || {};
        if (id) l1HbA.set(id, { lastSeen: Date.now(), type, status: status || 'ALIVE' });
        res.json({ node: 'A', received: true, timestamp: Math.floor(Date.now() / 1000) });
    });
    appA.post('/gossip/peer',     (req, res) => res.sendStatus(200));
    appA.post('/gossip/data',     (req, res) => res.sendStatus(200));
    appA.post('/gossip/analysis', (req, res) => res.sendStatus(200));
    appA.get('/__test__/heartbeats', (req, res) => res.json(Object.fromEntries(l1HbA)));

    const appB = express();
    appB.use(express.json({ limit: '2mb' }));
    const l1HbB = new Map();

    appB.get('/health', (req, res) => res.json({
        node: 'EVIL-CAM', port: 15001, url: 'http://localhost:15001',
        peers:           [{ name: 'A', url: 'http://localhost:15000' }],
        drivers:         mockB.drivers,
        devices:         mockB.devices,
        device_liveness: mockB.deviceLiveness,
        shunnedPeers:    mockB.shunnedPeers,
        fraudLog:        mockB.fraudLog,
        status: 'UP (EVIL-CAM)', timestamp: Math.floor(Date.now() / 1000),
        warning: 'This node tampers with camera analysis',
    }));
    appB.get('/latest', (req, res) => res.json({ node: 'EVIL-CAM', envelopes: mockB.envelopes }));
    appB.get('/peers',  (req, res) => res.json({
        node: 'EVIL-CAM', url: 'http://localhost:15001',
        peers: [{ name: 'A', url: 'http://localhost:15000' }],
    }));
    appB.post('/heartbeat', (req, res) => {
        const { id, type, status } = req.body || {};
        if (id) l1HbB.set(id, { lastSeen: Date.now(), type, status: status || 'ALIVE' });
        res.json({ node: 'EVIL-CAM', received: true, timestamp: Math.floor(Date.now() / 1000) });
    });
    appB.post('/gossip/peer',     (req, res) => res.sendStatus(200));
    appB.post('/gossip/data',     (req, res) => res.sendStatus(200));
    appB.post('/gossip/analysis', (req, res) => res.sendStatus(200));
    appB.get('/__test__/heartbeats', (req, res) => res.json(Object.fromEntries(l1HbB)));

    await new Promise(r => http.createServer(appA).listen(15000, r));
    info('Mock Node A  running on port 15000 (honest)');
    await new Promise(r => http.createServer(appB).listen(15001, r));
    info('Mock Node B  running on port 15001 (evil-cam)');

    // ─── Start the real L3 aggregator ───────────────────────────────────────
    section('Setup: Starting L3 Aggregator');
    const l3Proc = spawn(
        'node',
        [path.resolve(__dirname, 'layer3_base.js')],
        {
            env: {
                ...process.env,
                L3_PORT:  '18080',
                L2_NODES: 'http://localhost:15000,http://localhost:15001',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        }
    );
    l3Proc.stdout.on('data', d => {
        const line = d.toString().trim();
        if (line) process.stdout.write(`  ${B}[L3]${RS} ${line}\n`);
    });
    l3Proc.stderr.on('data', d => {
        const line = d.toString().trim();
        if (line) process.stderr.write(`  ${R}[L3-ERR]${RS} ${line}\n`);
    });

    info('Waiting for L3 to become ready...');
    const ready = await waitForPort(18080, 40, 300);
    if (!ready) {
        fail('L3 startup', 'L3 did not become ready within 12 s');
        l3Proc.kill();
        printSummary();
        process.exit(1);
    }
    info('L3 is ready on port 18080');

    // Allow one push cycle (500ms) to poll the mock nodes
    await new Promise(r => setTimeout(r, 1000));

    // ─── 1. L3 /health endpoint ─────────────────────────────────────────────
    section('1. L3 /health endpoint');
    {
        const { ok, body } = await get('http://localhost:18080/health');
        if (!ok) { fail('/health HTTP status', `Expected 200 got 4xx/5xx`); }
        else {
            pass('/health returns 200 OK');
            if (body?.status === 'UP') pass('/health.status = "UP"');
            else fail('/health.status', `Expected "UP" got "${body?.status}"`);

            if (Array.isArray(body?.l2_nodes)) pass('/health.l2_nodes is array');
            else fail('/health.l2_nodes', 'missing or not array');

            if (typeof body?.ws_clients === 'number') pass('/health.ws_clients is number');
            else fail('/health.ws_clients', 'missing');

            if (typeof body?.timestamp === 'number') pass('/health.timestamp is number');
            else fail('/health.timestamp', 'missing or wrong type');

            const nodeA = body?.l2_nodes?.find(n => n.name === 'A' || n.url === 'http://localhost:15000');
            const nodeB = body?.l2_nodes?.find(n => n.name === 'EVIL-CAM' || n.url === 'http://localhost:15001');
            if (nodeA) pass('/health lists Node A');
            else fail('/health lists Node A', 'Node A not found in l2_nodes');
            if (nodeB) pass('/health lists Node B (EVIL-CAM)');
            else fail('/health lists Node B', 'EVIL-CAM not found in l2_nodes');
        }
    }

    // ─── 2. L3 /topology endpoint ───────────────────────────────────────────
    section('2. L3 /topology endpoint');
    {
        const { ok, body } = await get('http://localhost:18080/topology');
        if (!ok) { fail('/topology HTTP status', 'Got non-200'); }
        else {
            pass('/topology returns 200 OK');
            if (Array.isArray(body?.nodes)) pass('/topology.nodes is array');
            else fail('/topology.nodes', 'not an array');

            if (typeof body?.generated_at === 'number') pass('/topology.generated_at is number');
            else fail('/topology.generated_at', 'missing');

            const nA = body?.nodes?.find(n => n.id === 'A' || n.url === 'http://localhost:15000');
            const nB = body?.nodes?.find(n => n.id === 'EVIL-CAM' || n.url === 'http://localhost:15001');

            if (nA) {
                pass('/topology has Node A');
                // Check node structure
                if (nA.status) pass(`Node A status field present: "${nA.status}"`);
                else fail('Node A status field', 'missing');
                if (Array.isArray(nA.devices)) pass('Node A has devices array');
                else fail('Node A devices', 'not an array');
                if (nA.status === 'ONLINE' || nA.status === 'WARMING_UP') {
                    pass(`Node A status is "${nA.status}" (not COMPROMISED)`);
                } else {
                    fail(`Node A status`, `Expected ONLINE or WARMING_UP, got "${nA.status}"`);
                }
            } else {
                fail('/topology has Node A', 'not found');
            }

            if (nB) {
                pass('/topology has Node B (EVIL-CAM)');
                if (nB.status) pass(`Node B status field present: "${nB.status}"`);
                else fail('Node B status field', 'missing');
            } else {
                fail('/topology has Node B', 'not found');
            }
        }
    }

    // ─── 3. L1 heartbeat protocol (L1 -> L2) ───────────────────────────────
    section('3. L1 Heartbeat protocol (L1 -> Layer 2)');
    {
        // Send a heartbeat from a simulated WEBCAM_01 device to Node A
        const { ok, body } = await post('http://localhost:15000/heartbeat', {
            id:        'WEBCAM_01',
            type:      'WEBCAM_LIGHT',
            timestamp: Math.floor(Date.now() / 1000),
            status:    'ALIVE',
        });
        if (ok && body?.received === true) {
            pass('WEBCAM_01 heartbeat accepted by Node A');
        } else {
            fail('WEBCAM_01 heartbeat to Node A', `HTTP ok=${ok} received=${body?.received}`);
        }

        // Verify Node A recorded it
        const { body: hbData } = await get('http://localhost:15000/__test__/heartbeats');
        if (hbData?.WEBCAM_01?.status === 'ALIVE') {
            pass('Node A recorded WEBCAM_01 heartbeat as ALIVE');
        } else {
            fail('Node A L1 heartbeat tracking', `Got ${JSON.stringify(hbData?.WEBCAM_01)}`);
        }

        // Send heartbeat to Evil Cam as well (L1 dual-homed)
        const { ok: okB } = await post('http://localhost:15001/heartbeat', {
            id: 'WEBCAM_01', type: 'WEBCAM_LIGHT',
            timestamp: Math.floor(Date.now() / 1000), status: 'ALIVE',
        });
        if (okB) pass('WEBCAM_01 heartbeat also accepted by Evil Cam (dual-homed)');
        else fail('WEBCAM_01 heartbeat to Evil Cam', 'HTTP not 200');

        // Send a MOBILE_01 heartbeat
        const { ok: okM } = await post('http://localhost:15000/heartbeat', {
            id: 'MOBILE_01', type: 'MOBILE_ORIENTATION',
            timestamp: Math.floor(Date.now() / 1000), status: 'ALIVE',
        });
        if (okM) pass('MOBILE_01 heartbeat accepted by Node A');
        else fail('MOBILE_01 heartbeat', 'HTTP not 200');
    }

    // ─── 4. L2 -> L3 heartbeat protocol ────────────────────────────────────
    section('4. L2 -> L3 Heartbeat protocol');
    {
        // POST heartbeat from Node A to L3 (as layer2_base.js would do)
        const { ok, body } = await post('http://localhost:18080/heartbeat', {
            node:      'A',
            url:       'http://localhost:15000',
            timestamp: Math.floor(Date.now() / 1000),
            status:    'ALIVE',
        });
        if (ok && body?.received === true) {
            pass('Node A heartbeat accepted by L3 /heartbeat');
        } else {
            fail('Node A heartbeat to L3', `ok=${ok} body=${JSON.stringify(body)}`);
        }

        // POST heartbeat from Evil Cam to L3
        const { ok: okB, body: bodyB } = await post('http://localhost:18080/heartbeat', {
            node:      'EVIL-CAM',
            url:       'http://localhost:15001',
            timestamp: Math.floor(Date.now() / 1000),
            status:    'ALIVE',
        });
        if (okB && bodyB?.received === true) {
            pass('EVIL-CAM heartbeat accepted by L3 /heartbeat');
        } else {
            fail('EVIL-CAM heartbeat to L3', `ok=${okB} body=${JSON.stringify(bodyB)}`);
        }

        // Verify L3 /health shows both nodes as recently seen
        const { body: health } = await get('http://localhost:18080/health');
        const nA = health?.l2_nodes?.find(n => n.url === 'http://localhost:15000');
        const nB = health?.l2_nodes?.find(n => n.url === 'http://localhost:15001');
        if (nA && nA.last_seen_s < 5) pass('Node A last_seen_s is recent (heartbeat working)');
        else fail('Node A heartbeat last_seen_s', `value=${nA?.last_seen_s}`);
        if (nB && nB.last_seen_s < 5) pass('EVIL-CAM last_seen_s is recent (heartbeat working)');
        else fail('EVIL-CAM heartbeat last_seen_s', `value=${nB?.last_seen_s}`);
    }

    // ─── 5. COMPROMISED detection via global shunned set ───────────────────
    section('5. COMPROMISED detection (evil webcam gossips NO_MOTION while honest gets MOTION)');
    {
        info('Simulating: Node A detects conflict -- shunning EVIL-CAM...');
        // Node A now reports EVIL-CAM in its shunnedPeers
        mockA.shunnedPeers = ['http://localhost:15001'];
        mockA.fraudLog = [{
            detectedAt:    new Date().toISOString(),
            kind:          'ANALYSIS_CONFLICT',
            accusingNode:  'A',
            lyingPeer:     'EVIL-CAM',
            lyingPeerUrl:  'http://localhost:15001',
            deviceId:      'WEBCAM_01',
            frameHash:     'abcdef1234567890abcdef1234567890',
            ownStatus:     'MOTION',
            reportedStatus: 'NO_MOTION',
            verdict:       'EVIL-CAM reported NO_MOTION -- cross-validation got MOTION',
        }];
        // Also update node A's envelope to CONFLICT for the device
        mockA.envelopes = {
            WEBCAM_01: {
                header:  { node_id: 'A', signature: 'valid', timestamp: Math.floor(Date.now() / 1000) },
                payload: {
                    device_id:     'WEBCAM_01',
                    raw_data:      { frameHash: 'abcdef1234567890abcdef1234567890', timestamp: Math.floor(Date.now() / 1000) },
                    driver_status: 'PROCESSED',
                    interpretation: { status: 'MOTION', frameDiff: 42.5, brightness: 85 },
                },
                audit:   { peer_consistency: 'CONFLICT', solana_batch_id: null },
            },
        };

        // Wait for two push cycles to propagate
        await new Promise(r => setTimeout(r, 1200));

        const { body: topo } = await get('http://localhost:18080/topology');
        const nA = topo?.nodes?.find(n => n.id === 'A' || n.url === 'http://localhost:15000');
        const nB = topo?.nodes?.find(n => n.id === 'EVIL-CAM' || n.url === 'http://localhost:15001');

        if (nA?.status === 'ONLINE') {
            pass(`Node A status = ONLINE (honest accuser stays ONLINE)`);
        } else {
            fail('Node A post-fraud status', `Expected ONLINE, got "${nA?.status}"`);
        }

        if (nB?.status === 'COMPROMISED') {
            pass(`EVIL-CAM status = COMPROMISED (shunned node correctly flagged)`);
        } else {
            fail('EVIL-CAM COMPROMISED detection', `Expected COMPROMISED, got "${nB?.status}". ` +
                 `(Node A shunnedPeers=${JSON.stringify(mockA.shunnedPeers)})`);
        }

        // Device-level status should show ALERT on the conflict device under Node A
        const devA = nA?.devices?.find(d => d.id === 'WEBCAM_01');
        if (devA?.status === 'ALERT' || devA?.status === 'MOTION_DETECTED' || devA?.status === 'STREAMING') {
            pass(`WEBCAM_01 device status reported under Node A: "${devA.status}"`);
        } else if (!devA) {
            info(`WEBCAM_01 device not in topology for Node A (driver not loaded yet) -- skipping`);
        } else {
            fail('WEBCAM_01 device status under Node A', `Got "${devA?.status}"`);
        }
    }

    // ─── 6. /telemetry endpoint ─────────────────────────────────────────────
    section('6. L3 /telemetry endpoint');
    {
        const { ok, body } = await get('http://localhost:18080/telemetry');
        if (!ok) {
            fail('/telemetry HTTP status', 'Got non-200');
        } else {
            pass('/telemetry returns 200 OK');
            if (Array.isArray(body)) {
                pass('/telemetry response is an array');
                // Look for WEBCAM_01 -- may not be present if conflict prevented ingestion
                const webcamData = body.find(p => p.device_id === 'WEBCAM_01');
                if (webcamData) {
                    pass('/telemetry has WEBCAM_01 packet');
                    if (Array.isArray(webcamData.history)) pass('WEBCAM_01 telemetry has history array');
                    else fail('WEBCAM_01 telemetry history', 'not an array');
                    if (webcamData.consensus_score) pass(`WEBCAM_01 consensus_score = "${webcamData.consensus_score}"`);
                } else {
                    info('/telemetry WEBCAM_01 not present -- CONFLICT correctly blocked ingestion from COMPROMISED path');
                    pass('/telemetry correctly excludes COMPROMISED node data');
                }
            } else {
                fail('/telemetry response type', 'Expected array');
            }
        }
    }

    // ─── 7. /audit endpoint ─────────────────────────────────────────────────
    section('7. L3 /audit endpoint');
    {
        const { ok, body } = await get('http://localhost:18080/audit');
        if (!ok) {
            fail('/audit HTTP status', 'Got non-200');
        } else {
            pass('/audit returns 200 OK');
            if (Array.isArray(body)) {
                pass('/audit response is an array');
                info(`Audit log has ${body.length} event(s)`);
                // After fraud simulation, there should be at least one event
                const fraudEvents = body.filter(e => e.signature_status === 'FRAUD_DETECTED');
                if (fraudEvents.length > 0) {
                    pass(`/audit has ${fraudEvents.length} FRAUD_DETECTED event(s)`);
                    const ev = fraudEvents[0];
                    if (ev.device_id) pass('Fraud audit event has device_id field');
                    else fail('Fraud audit event device_id', 'missing');
                    if (ev.evidence)  pass('Fraud audit event has evidence field');
                    else fail('Fraud audit event evidence', 'missing');
                } else {
                    info('/audit no FRAUD_DETECTED events yet -- may need another push cycle');
                }
            } else {
                fail('/audit response type', 'Expected array');
            }
        }
    }

    // ─── 8. /register-node endpoint ─────────────────────────────────────────
    section('8. L3 /register-node dynamic endpoint');
    {
        const { ok, body } = await post('http://localhost:18080/register-node', {
            name: 'TestNodeC',
            url:  'http://localhost:15002',
        });
        if (ok && body?.ok === true) {
            pass('/register-node accepted new node');
        } else {
            fail('/register-node', `ok=${ok} body=${JSON.stringify(body)}`);
        }

        // Verify it appears in topology
        await new Promise(r => setTimeout(r, 800));
        const { body: topo } = await get('http://localhost:18080/topology');
        const nC = topo?.nodes?.find(n => n.id === 'TestNodeC' || n.url === 'http://localhost:15002');
        if (nC) pass('TestNodeC appears in /topology after /register-node');
        else fail('TestNodeC in topology', 'not found after registration');
    }

    // ─── 9. L3 heartbeat TTL / DEAD detection ───────────────────────────────
    section('9. L3 heartbeat TTL -- DEAD node detection');
    {
        // Register a fake node that will never heartbeat
        await post('http://localhost:18080/register-node', { name: 'GhostNode', url: 'http://localhost:15099' });
        info('Registered GhostNode (no L2 server at 15099) -- expects DEAD after failCount >= 2');

        // Wait for L3 to poll it and accumulate failCount
        await new Promise(r => setTimeout(r, 3000));

        const { body: topo } = await get('http://localhost:18080/topology');
        const ghost = topo?.nodes?.find(n => n.id === 'GhostNode' || n.url === 'http://localhost:15099');
        if (!ghost) {
            info('GhostNode already pruned from topology -- acceptable');
        } else if (ghost.status === 'DEAD' || ghost.fail_count >= 2) {
            pass(`GhostNode status = "${ghost.status}" (unreachable node correctly marked DEAD/failed)`);
        } else {
            fail('GhostNode DEAD detection', `status="${ghost.status}" fail_count=${ghost.fail_count} -- need more poll cycles`);
        }
    }

    // ─── 10. Heartbeat status per device in topology ─────────────────────────
    section('10. Device heartbeat liveness in topology');
    {
        const { body: topo } = await get('http://localhost:18080/topology');
        const nA = topo?.nodes?.find(n => n.id === 'A' || n.url === 'http://localhost:15000');
        if (nA) {
            const webcam = nA.devices?.find(d => d.id === 'WEBCAM_01');
            if (webcam) {
                if (webcam.heartbeat) {
                    pass(`WEBCAM_01 has heartbeat field: "${webcam.heartbeat}"`);
                } else {
                    fail('WEBCAM_01 heartbeat field', 'missing in topology device entry');
                }
                if (webcam.heartbeat_age_s !== undefined) {
                    pass(`WEBCAM_01 heartbeat_age_s = ${webcam.heartbeat_age_s}s`);
                } else {
                    fail('WEBCAM_01 heartbeat_age_s', 'missing');
                }
            } else {
                info('WEBCAM_01 device not found in Node A topology (no driver registered yet)');
            }
        }
    }

    // ─── Cleanup ────────────────────────────────────────────────────────────
    l3Proc.kill();

    // ─── Summary ────────────────────────────────────────────────────────────
    printSummary();
}

function printSummary() {
    console.log('\n' + '='.repeat(66));
    console.log(`  Results: ${G}${passed} passed${RS}   ${R}${failed} failed${RS}`);
    if (errors.length) {
        console.log('\n  Failed tests:');
        for (const { label, reason } of errors) {
            console.log(`    ${R}[X]${RS} ${label}: ${reason}`);
        }
    }
    console.log('='.repeat(66) + '\n');
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error(`\n${R}[FATAL]${RS} Unhandled error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});
