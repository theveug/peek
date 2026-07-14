// Room mic rule (open mic vs push-to-talk) with raw ws clients (no browser):
//   1. /api/create-room with micPolicy 'ptt' → every joiner's 'init' carries it,
//   2. a junk micPolicy at creation (non-string/unknown value) stores 'open',
//   3. a lazily-created room (raw join to a dead code) defaults to 'open',
//   4. a non-creator's set-mic-policy is silently ignored (no broadcast,
//      later joiners still see the old value),
//   5. the creator's set-mic-policy broadcasts 'mic-policy-update' to every
//      peer in the room (including the creator) and sticks for later joiners,
//   6. an invalid policy value from the creator is rejected (allowlist).
//
// Client-side *enforcement* of the rule is deliberately UI-level only (P2P
// mesh — no media server to block packets), so this tests the authority and
// sync layer, which IS server-enforced.
//
// Run with: npm run test:mic-policy

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed dev cert

const PORT = process.env.TEST_PORT || 3121;
const BASE_URL = `https://localhost:${PORT}`;
const WS_URL = `wss://localhost:${PORT}`;

function startServer() {
    const proc = spawn(process.execPath, ['server.js'], {
        env: { ...process.env, PORT: String(PORT) },
        stdio: 'pipe',
    });
    return new Promise((resolve, reject) => {
        let out = '';
        proc.stdout.on('data', (chunk) => {
            out += chunk.toString();
            if (out.includes('Server listening')) resolve(proc);
        });
        proc.on('error', reject);
        setTimeout(() => reject(new Error('server did not start within 10s')), 10_000);
    });
}

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

/** Opens a socket, sends a join, and resolves with helpers around it. */
function connectAndJoin(code, { creatorToken } = {}) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
        const messages = [];
        const waiters = [];
        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            messages.push(msg);
            waiters.forEach(w => w());
        });
        ws.on('error', reject);
        ws.on('open', () => {
            const join = { type: 'join', sessionId: code };
            if (creatorToken) join.creatorToken = creatorToken;
            ws.send(JSON.stringify(join));
        });
        const waitFor = (type, timeoutMs = 5000) => new Promise((res, rej) => {
            const check = () => {
                const found = messages.find(m => m.type === type);
                if (found) res(found);
            };
            waiters.push(check);
            check();
            setTimeout(() => rej(new Error(`timed out waiting for '${type}'`)), timeoutMs);
        });
        waitFor('init').then(init => resolve({ ws, messages, waitFor, init })).catch(reject);
    });
}

async function createRoom(body) {
    const res = await fetch(`${BASE_URL}/api/create-room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return res.json();
}

async function main() {
    const server = await startServer();
    try {
        // --- 1. create-room micPolicy round-trips into init ---
        const { code: pttCode, creatorToken } = await createRoom({ micPolicy: 'ptt' });
        const creator = await connectAndJoin(pttCode, { creatorToken });
        assert(creator.init.micPolicy === 'ptt', "creator's init carries micPolicy 'ptt'");

        const peerB = await connectAndJoin(pttCode);
        assert(peerB.init.micPolicy === 'ptt', "second joiner's init carries micPolicy 'ptt'");

        // --- 4. non-creator's set-mic-policy is ignored ---
        peerB.ws.send(JSON.stringify({ type: 'set-mic-policy', payload: { policy: 'open' } }));
        await sleep(400);
        assert(!creator.messages.some(m => m.type === 'mic-policy-update'),
            "non-creator's set-mic-policy produced no broadcast");
        const peerC = await connectAndJoin(pttCode);
        assert(peerC.init.micPolicy === 'ptt', "policy unchanged ('ptt') for a joiner after the forged attempt");
        peerC.ws.close();

        // --- 6. invalid policy value from the creator is rejected ---
        creator.ws.send(JSON.stringify({ type: 'set-mic-policy', payload: { policy: 'everyone-muted-forever' } }));
        creator.ws.send(JSON.stringify({ type: 'set-mic-policy', payload: { policy: 42 } }));
        await sleep(400);
        assert(!creator.messages.some(m => m.type === 'mic-policy-update'),
            'invalid policy values produced no broadcast');

        // --- 5. creator's change broadcasts to everyone and sticks ---
        creator.ws.send(JSON.stringify({ type: 'set-mic-policy', payload: { policy: 'open' } }));
        const updCreator = await creator.waitFor('mic-policy-update');
        const updB = await peerB.waitFor('mic-policy-update');
        assert(updCreator.payload?.policy === 'open', 'creator received their own mic-policy-update');
        assert(updB.payload?.policy === 'open', 'other peer received the mic-policy-update');
        const peerD = await connectAndJoin(pttCode);
        assert(peerD.init.micPolicy === 'open', "later joiner's init reflects the changed policy");
        peerD.ws.close();
        creator.ws.close();
        peerB.ws.close();

        // --- 2. junk micPolicy at creation stores 'open' ---
        const { code: junkCode } = await createRoom({ micPolicy: { evil: true } });
        const junkJoin = await connectAndJoin(junkCode);
        assert(junkJoin.init.micPolicy === 'open', "junk create-room micPolicy defaults to 'open'");
        junkJoin.ws.close();

        // --- 3. lazily-created room defaults to 'open' ---
        const lazy = await connectAndJoin('Lzy77');
        assert(lazy.init.micPolicy === 'open', "lazily-created room defaults to 'open'");
        lazy.ws.close();

        await sleep(200);
        console.log('All mic-policy checks passed.');
    } finally {
        server.kill();
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
