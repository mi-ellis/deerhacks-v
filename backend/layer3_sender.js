require('dotenv').config();
require('cross-fetch/polyfill');
const { Connection, Keypair, Transaction, TransactionInstruction, PublicKey,
        sendAndConfirmTransaction, SendTransactionError, ComputeBudgetProgram } = require('@solana/web3.js');
const bs58   = require('bs58').default || require('bs58');
const fs     = require('fs');
const zlib   = require('zlib');
const crypto = require('crypto');

// ─── Utilities ─────────────────────────────────────────────────────────────────
function compress(str) { return zlib.deflateSync(Buffer.from(str, 'utf8')).toString('base64'); }
function sha256(str)   { return crypto.createHash('sha256').update(str).digest('hex'); }

// ─── Solana — only used to anchor driver hashes ────────────────────────────────
// The full driver *code* never touches the blockchain.
// Only a SHA-256 fingerprint is posted so nodes can later verify authenticity.
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const secretKey  = bs58.decode(process.env.SOLANA_PRIVATE_KEY);
const sender     = Keypair.fromSecretKey(secretKey);
const MEMO_ID    = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

async function postDriverHash(type, version, hash) {
    const memo = `DRIVER_HASH:${JSON.stringify({ type, version, hash })}`;
    const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    const ix   = new TransactionInstruction({
        keys: [{ pubkey: sender.publicKey, isSigner: true, isWritable: false }],
        programId: MEMO_ID,
        data: Buffer.from(memo),
    });
    const tx = new Transaction().add(cuIx, ix);
    try {
        const sig = await sendAndConfirmTransaction(connection, tx, [sender]);
        console.log(`  [OK] Hash anchored on Solana: ${sig}`);
        return sig;
    } catch (err) {
        if (err instanceof SendTransactionError) {
            console.error("  Solana error:", err.message);
        }
        throw err;
    }
}

// ─── Session peer map ──────────────────────────────────────────────────────────
// Built up as `register node` commands are processed in a config run.
// Maps node name → node URL.  Used to target HTTP commands correctly.
const sessionPeers = new Map();

// L3 aggregator URL — needed to pre-register nodes so L3 accepts their heartbeats.
const L3_URL = process.env.L3_URL || 'http://localhost:8080';

// --resend mode: skip Solana anchoring and L2 mesh gossip, but still
// register nodes with L3 (so heartbeats are accepted) and push drivers/devices.
const RESEND_MODE = process.argv.includes('--resend');
if (RESEND_MODE) console.log('[sender] --resend mode: skipping Solana + L2 gossip, re-registering with L3');

function bootstrapUrl() {
    const first = sessionPeers.values().next().value;
    return first || process.env.L2_BOOTSTRAP || 'http://localhost:5000';
}

// ─── HTTP helper ───────────────────────────────────────────────────────────────
async function httpPost(url, body, label) {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return true;
    } catch (e) {
        console.error(`  [ERR] ${label}: ${e.message}`);
        return false;
    }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * Register a node in the session AND gossip its existence through the mesh.
 * No Solana transaction — peers learn about each other via HTTP gossip.
 *
 * Usage: node layer3_sender.js register <name> <url>
 */
async function registerNode(name, url) {
    console.log(`Announcing node "${name}" at ${url} to mesh...`);

    // Always tell L3 about this node so it pre-registers it and accepts
    // the node's heartbeats.  This must happen before the node tries to
    // send its first heartbeat, otherwise L3 rejects it with 403.
    await httpPost(`${L3_URL}/register-node`, { name, url }, `L3 register ${name}`);

    // Tell every already-known node about the newcomer
    for (const [, peerUrl] of sessionPeers) {
        await httpPost(`${peerUrl}/gossip/peer`, { name, url },
                       `gossip ${name}→${peerUrl}`);
    }

    // Tell the newcomer about every already-known node
    for (const [peerName, peerUrl] of sessionPeers) {
        await httpPost(`${url}/gossip/peer`, { name: peerName, url: peerUrl },
                       `tell ${name} about ${peerName}`);
    }

    sessionPeers.set(name, url);
    console.log(`  Session peers: [${[...sessionPeers.keys()].join(', ')}]`);
}

/**
 * Push a driver to one node (defaults to the first/bootstrap node).
 * That node automatically gossips the code to all its peers.
 * Only the SHA-256 hash is anchored on Solana for integrity auditing.
 *
 * Usage: node layer3_sender.js push-driver <type> <version> <script_or_file>
 */
async function pushDriver(type, version, scriptOrFile, targetUrl = null) {
    let script = scriptOrFile;
    if (fs.existsSync(scriptOrFile)) {
        script = fs.readFileSync(scriptOrFile, 'utf8');
        console.log(`  Loaded: ${scriptOrFile}`);
    }
    const hash       = sha256(script);
    const compressed = compress(script);

    // Determine destination(s):
    //   - If a specific targetUrl is given, use only that.
    //   - Otherwise fan out to EVERY known session peer so all nodes receive
    //     the driver even when gossip is unavailable (e.g. nodes are isolated).
    const targets = targetUrl
        ? [targetUrl]
        : (sessionPeers.size > 0 ? [...sessionPeers.values()] : [bootstrapUrl()]);

    let anchored = false;
    for (const dest of targets) {
        console.log(`  Pushing "${type}" v${version} → ${dest} (${script.length}B raw / ${compressed.length}B compressed)`);
        const ok = await httpPost(`${dest}/driver`,
            { type, version, script: compressed, gz: true, hash },
            `driver push`);

        if (ok) {
            if (RESEND_MODE) {
                console.log(`  Delivered to ${dest} (Solana skipped in resend mode).`);
            } else if (!anchored) {
                // Only anchor once per driver push, regardless of how many nodes
                console.log(`  Delivered. Anchoring hash on Solana...`);
                await postDriverHash(type, version, hash);
                anchored = true;
            } else {
                console.log(`  Delivered to ${dest} (hash already anchored).`);
            }
        }
    }
}

/**
 * Push a driver to ONE specific named node only (A/B test, targeted hotfix).
 * Hash is still anchored on Solana.
 *
 * Usage: node layer3_sender.js push-driver-target <node> <type> <version> <file>
 */
async function pushDriverTarget(nodeName, type, version, scriptOrFile) {
    const url = sessionPeers.get(nodeName);
    if (!url) {
        console.error(`  Unknown node "${nodeName}". Register it first.`); return;
    }
    console.log(`  Targeted push: "${type}" v${version} → ${nodeName} only`);
    await pushDriver(type, version, scriptOrFile, url);
}

/**
 * Map a device ID to a type on a specific node via HTTP.
 * No Solana transaction needed — the node stores this locally.
 *
 * Usage: node layer3_sender.js register-device <node> <device_id> <device_type>
 */
async function registerDevice(nodeName, deviceId, deviceType) {
    const url = sessionPeers.get(nodeName);
    if (!url) { console.error(`  Unknown node "${nodeName}".`); return; }
    console.log(`  Registering device "${deviceId}" (${deviceType}) on ${nodeName}...`);
    await httpPost(`${url}/device`, { devices: [{ id: deviceId, type: deviceType }] },
                   `device register`);
}

/**
 * Auto-detect DEVICE_ID / DEVICE_TYPE from a Python source file, then register.
 *
 * Usage: node layer3_sender.js register-device-file <file> <node>
 */
async function registerDeviceFile(filePath, nodeName) {
    if (!fs.existsSync(filePath)) { console.error(`File not found: ${filePath}`); return; }
    const src = fs.readFileSync(filePath, 'utf8');

    // Support both new SolanaIoTDevice(...) constructor and old DEVICE_ID constant
    const ctorMatch = src.match(/SolanaIoTDevice\(\s*["'](.+?)["']\s*,\s*["'](.+?)["']/);
    let deviceId, deviceType;
    if (ctorMatch) {
        deviceId = ctorMatch[1]; deviceType = ctorMatch[2];
    } else {
        const idM   = src.match(/^DEVICE_ID\s*=\s*["'](.+?)["']/m);
        const typeM = src.match(/^DEVICE_TYPE\s*=\s*["'](.+?)["']/m);
        if (!idM || !typeM) { console.error(`Cannot detect device info from ${filePath}`); return; }
        deviceId = idM[1]; deviceType = typeM[1];
    }
    console.log(`  Auto-detected from ${filePath}: id="${deviceId}" type="${deviceType}"`);
    await registerDevice(nodeName, deviceId, deviceType);
}

/**
 * Set the watcher check interval on ALL known session peers via HTTP.
 *
 * Usage: node layer3_sender.js set-interval <ms>
 */
async function setCheckInterval(ms) {
    const targets = sessionPeers.size
        ? [...sessionPeers.entries()]
        : [['bootstrap', bootstrapUrl()]];
    console.log(`  Setting check interval to ${ms}ms on ${targets.length} node(s)...`);
    for (const [name, url] of targets) {
        await httpPost(`${url}/config`, { interval: Number(ms) }, `config ${name}`);
    }
}

// ─── BFT: Solana Dispute Submission ───────────────────────────────────────────
// Submits a Memo transaction to Solana recording the fraud evidence permanently.
// Fraud is proven locally by HMAC-SHA256 mismatch; Solana anchors the record.

/**
 * Submit a BFT fraud dispute to Solana.
 *
 * Records the fraud report as a Memo transaction — permanently on-chain.
 *
 * Usage: node layer3_sender.js submit-dispute <fraud_log.json | node_url>
 */
async function submitDispute(fraudEntry) {
    const { deviceId, tamperedValue, timestamp, publicKey,
            lyingPeer, accusingNode, signature } = fraudEntry;

    console.log(`\n[BFT] Submitting BFT Dispute to Solana...`);
    console.log(`   Device       : ${deviceId}`);
    console.log(`   Lying Peer   : ${lyingPeer}`);
    console.log(`   Tampered Val : ${tamperedValue}`);
    console.log(`   Timestamp    : ${timestamp}`);

    // Memo with full fraud evidence (permanent record)
    const memoTxt = JSON.stringify({
        event:         'BFT_FRAUD_DISPUTE',
        deviceId,      lyingPeer,      accusingNode,
        tamperedValue, timestamp,
        verdict:       'HMAC-SHA256 FAIL — data tampered',
    });
    const memoIx = new TransactionInstruction({
        keys:      [{ pubkey: sender.publicKey, isSigner: true, isWritable: false }],
        programId: MEMO_ID,
        data:      Buffer.from(memoTxt),
    });

    const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        memoIx,
    );

    try {
        const txSig = await sendAndConfirmTransaction(connection, tx, [sender]);
        console.log('\n================================================');
        console.log('[BFT] SOLANA VERDICT: FRAUD EVIDENCE RECORDED');
        console.log(`   HMAC-SHA256 mismatch proven locally`);
        console.log(`   value=${tamperedValue} does NOT match HMAC tag for ${deviceId}`);
        console.log(`   ${lyingPeer || 'Unknown peer'} sent TAMPERED data.`);
        console.log(`   TX: ${txSig}`);
        console.log('   Solana is the unbiased cryptographic referee.');
        console.log('================================================\n');
        return txSig;
    } catch (err) {
        console.error(`Solana error: ${err.message}`);
        throw err;
    }
}

/**
 * Fetch and submit all unresolved fraud events from a node's /fraud-log endpoint.
 *
 * Usage: node layer3_sender.js submit-fraud-log [node_url]
 */
async function submitFraudLog(nodeUrl) {
    const url = nodeUrl || bootstrapUrl();
    console.log(`Fetching fraud log from ${url}...`);
    try {
        const res = await fetch(`${url}/fraud-log`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) { console.error(`HTTP ${res.status}`); return; }
        const data = await res.json();
        const events = data.fraudEvents || [];
        console.log(`Found ${events.length} fraud event(s).\n`);
        for (const entry of events) {
            await submitDispute(entry);
        }
        if (!events.length) console.log('No fraud events to submit.');
    } catch (e) {
        console.error(`Could not fetch fraud log: ${e.message}`);
    }
}

// ─── Config file runner ────────────────────────────────────────────────────────
async function runConfig(configPath) {
    if (!fs.existsSync(configPath)) {
        console.error(`Config file not found: ${configPath}`); process.exit(1);
    }
    const lines = fs.readFileSync(configPath, 'utf8')
        .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    console.log(`Running config: ${configPath} (${lines.length} command(s))\n`);
    for (const line of lines) {
        const [verb, noun, ...rest] = line.split(/\s+/);
        console.log(`► ${line}`);

        if (verb === 'register') {
            if (noun === 'node') {
                const [name, port] = rest;
                if (RESEND_MODE) {
                    // In resend mode skip L2 mesh gossip, but still register
                    // with L3 so it accepts the node's heartbeats if it restarted.
                    sessionPeers.set(name, `http://localhost:${port}`);
                    await httpPost(
                        `${L3_URL}/register-node`,
                        { name, url: `http://localhost:${port}` },
                        `L3 re-register ${name}`,
                    );
                } else {
                    await registerNode(name, `http://localhost:${port}`);
                }

            } else if (noun === 'driver') {
                const [type, fileArg] = rest;
                const file    = fileArg || `drivers/${type}.py`;
                const version = `v${new Date().toISOString().slice(0, 10)}`;
                await pushDriver(type, version, file);

            } else if (noun === 'driver-target') {
                const [nodeName, type, fileArg] = rest;
                const file    = fileArg || `drivers/${type}.py`;
                const version = `v${new Date().toISOString().slice(0, 10)}`;
                await pushDriverTarget(nodeName, type, version, file);

            } else if (noun === 'device-file') {
                const [file, nodeName] = rest;
                if (!file || !nodeName) { console.warn('  register device-file needs <file> <node>'); continue; }
                await registerDeviceFile(file, nodeName);

            } else if (noun === 'device') {
                const [deviceId, deviceType, nodeName] = rest;
                await registerDevice(nodeName, deviceId, deviceType);

            } else {
                console.warn(`  Unknown register target: "${noun}" — skipping.`);
            }

        } else if (verb === 'set-interval') {
            await setCheckInterval(rest[0]);

        } else {
            console.warn(`  Unknown command: "${verb}" — skipping.`);
        }
        console.log('');
    }
    console.log('Config complete.');
}

// ─── CLI dispatch ─────────────────────────────────────────────────────────────
const [,, cmd, ...args] = process.argv;

(async () => {
    switch (cmd) {
        case 'run-config':
            if (!args[0]) { console.error('Usage: node layer3_sender.js run-config <file>'); process.exit(1); }
            await runConfig(args[0]);
            break;

        case 'register':
            if (args.length < 2) { console.error('Usage: node layer3_sender.js register <name> <url>'); process.exit(1); }
            await registerNode(args[0], args[1]);
            break;

        case 'push-driver':
            if (args.length < 3) { console.error('Usage: node layer3_sender.js push-driver <type> <version> <file>'); process.exit(1); }
            await pushDriver(args[0], args[1], args.slice(2).join(' '));
            break;

        case 'push-driver-target':
            if (args.length < 4) { console.error('Usage: node layer3_sender.js push-driver-target <node> <type> <version> <file>'); process.exit(1); }
            // First register the target node so the session knows its URL
            // (caller must pass url as 5th arg, or rely on L2_BOOTSTRAP)
            await pushDriverTarget(args[0], args[1], args[2], args.slice(3).join(' '));
            break;

        case 'register-device':
            if (args.length < 3) { console.error('Usage: node layer3_sender.js register-device <node> <url> <id> <type>'); process.exit(1); }
            // When called standalone: args[0]=name, args[1]=url, args[2]=id, args[3]=type
            if (args.length >= 4) {
                sessionPeers.set(args[0], args[1]);
                await registerDevice(args[0], args[2], args[3]);
            } else {
                console.error('Usage: node layer3_sender.js register-device <name> <url> <device_id> <device_type>');
            }
            break;

        case 'register-device-file':
            if (args.length < 2) { console.error('Usage: node layer3_sender.js register-device-file <file> <node> <url>'); process.exit(1); }
            if (args.length >= 3) sessionPeers.set(args[1], args[2]);
            await registerDeviceFile(args[0], args[1]);
            break;

        case 'set-interval':
            if (!args[0]) { console.error('Usage: node layer3_sender.js set-interval <ms> [node-url...]'); process.exit(1); }
            // Allow passing node URLs directly: set-interval 5000 http://host:5000 http://host:5001
            args.slice(1).forEach((url, i) => sessionPeers.set(`node${i}`, url));
            await setCheckInterval(args[0]);
            break;

        case 'submit-dispute': {
            // Submit a single fraud event from a JSON file or stdin
            // Usage: node layer3_sender.js submit-dispute fraud_log.json
            const src = args[0];
            if (!src) { console.error('Usage: node layer3_sender.js submit-dispute <fraud_entry.json>'); process.exit(1); }
            const raw = fs.readFileSync(src, 'utf8');
            const parsed = JSON.parse(raw);
            const entries = Array.isArray(parsed) ? parsed : [parsed];
            for (const entry of entries) await submitDispute(entry);
            break;
        }

        case 'submit-fraud-log':
            // Fetch all fraud events from a node and submit each to Solana
            // Usage: node layer3_sender.js submit-fraud-log [http://localhost:5000]
            await submitFraudLog(args[0] || null);
            break;

        default:
            console.log("Available commands:");
            console.log("  run-config           <file>                        Run a network config script");
            console.log("  register             <name> <url>                  Gossip a node into the mesh");
            console.log("  push-driver          <type> <ver> <file>           Push driver code (P2P gossip) + hash to Solana");
            console.log("  push-driver-target   <node> <type> <ver> <file>    Push driver to one named node only");
            console.log("  register-device      <name> <url> <id> <type>      Map device to type on a node");
            console.log("  register-device-file <file> <node> <url>           Auto-register device from .py file");
            console.log("  set-interval         <ms> [url...]                 Set watcher interval on nodes");
            console.log("  submit-dispute       <fraud_entry.json>            Submit BFT fraud proof to Solana");
            console.log("  submit-fraud-log     [node_url]                    Fetch & submit all fraud events from a node");
    }
})();
