// Kick vs. ban semantics with raw ws clients (no browser):
//   1. kick is a one-time removal — the kicked peer can rejoin immediately,
//   2. ban sticks — the banned peer's rejoin is rejected with
//      join-error/banned and the socket is closed, for the session's lifetime,
//   3. a non-creator's 'ban' request is ignored server-side,
//   4. the creator token bypasses the IP gate — on localhost every client
//      shares one IP, so this test would deadlock itself without the bypass,
//      which is exactly the shared-NAT scenario the bypass exists for,
//   5. the ban is session-scoped: once the room empties (set dies with the
//      session), the same "IP" can join a lazily-recreated room again.
//
// Run with: npm run test:ban-sticky

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed dev cert

const PORT = process.env.TEST_PORT || 3117;
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
            setTimeout(() => rej(new Error(`timed out waiting for '${type}'; got: ${messages.map(m => m.type).join(',')}`)), timeoutMs);
        });
        resolve({ ws, messages, waitFor });
    });
}

async function main() {
    const server = await startServer();
    try {
        const createResp = await fetch(`${BASE_URL}/api/create-room`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ maxPeers: 6 }),
        });
        const { code, creatorToken } = await createResp.json();
        console.log('room:', code);

        const creator = await connectAndJoin(code, { creatorToken });
        const creatorInit = await creator.waitFor('init');

        // --- Kick does not stick ---
        const victim1 = await connectAndJoin(code);
        const victim1Init = await victim1.waitFor('init');
        await creator.waitFor('peer-joined');
        creator.ws.send(JSON.stringify({ type: 'kick', to: victim1Init.peerId }));
        await victim1.waitFor('kicked');
        await sleep(300);
        const victim1Back = await connectAndJoin(code);
        await victim1Back.waitFor('init');
        console.log('STEP 1 - kick is one-time, kicked peer can rejoin: PASS');

        // --- Non-creator ban attempts are ignored server-side ---
        victim1Back.ws.send(JSON.stringify({ type: 'ban', to: creatorInit.peerId }));
        await sleep(300);
        assert(creator.ws.readyState === WebSocket.OPEN, 'non-creator ban request is ignored (creator still connected)');

        // --- Ban sticks ---
        const victim2Init = victim1Back.messages.find(m => m.type === 'init');
        creator.ws.send(JSON.stringify({ type: 'ban', to: victim2Init.peerId }));
        await victim1Back.waitFor('banned');
        console.log('STEP 2 - banned peer received banned: PASS');
        await sleep(300);

        const banRetry = await connectAndJoin(code);
        const err = await banRetry.waitFor('join-error');
        assert(err.reason === 'banned', `rejoin after ban is rejected with reason banned, got "${err.reason}"`);
        await sleep(300);
        assert(banRetry.ws.readyState === WebSocket.CLOSED, 'rejected socket is closed by the server');

        // --- Creator token bypasses the shared-IP gate ---
        const creatorAgain = await connectAndJoin(code, { creatorToken });
        await creatorAgain.waitFor('init');
        console.log('STEP 3 - creator token bypasses the shared-IP ban: PASS');

        // --- Ban dies with the session ---
        creator.ws.close();
        creatorAgain.ws.close();
        await sleep(500);
        const fresh = await connectAndJoin(code);
        await fresh.waitFor('init');
        console.log('STEP 4 - ban dies with the session (lazy-recreated room is open again): PASS');
        fresh.ws.close();

        console.log('All kick/ban checks passed.');
    } finally {
        server.kill();
        await sleep(200);
    }
}

await main();
