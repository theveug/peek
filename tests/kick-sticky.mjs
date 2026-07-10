// Sticky-kick coverage with raw ws clients (no browser):
//   1. the creator kicks a peer → that peer's rejoin attempt is rejected with
//      join-error/kicked and the socket is closed (the kick actually sticks),
//   2. the creator token bypasses the IP gate — on localhost every client
//      shares one IP, so this test would deadlock itself without the bypass,
//      which is exactly the shared-NAT scenario the bypass exists for,
//   3. the ban is session-scoped: once the room empties (set dies with the
//      session), the same "IP" can join a lazily-recreated room again.
//
// Run with: npm run test:kick-sticky

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

        // Creator + victim join.
        const creator = await connectAndJoin(code, { creatorToken });
        const creatorInit = await creator.waitFor('init');
        const victim = await connectAndJoin(code);
        const victimInit = await victim.waitFor('init');
        await creator.waitFor('peer-joined');

        // Creator kicks the victim.
        creator.ws.send(JSON.stringify({ type: 'kick', to: victimInit.peerId }));
        await victim.waitFor('kicked');
        console.log('STEP 1 - victim received kicked: PASS');
        await sleep(300);

        // Victim rejoins from the same IP → rejected and closed.
        const victimRetry = await connectAndJoin(code);
        const err = await victimRetry.waitFor('join-error');
        assert(err.reason === 'kicked', `rejoin after kick is rejected with reason kicked, got "${err.reason}"`);
        await sleep(300);
        assert(victimRetry.ws.readyState === WebSocket.CLOSED, 'rejected socket is closed by the server');

        // Creator token bypasses the IP gate (localhost = same IP as the victim,
        // i.e. the shared-NAT case): a second creator socket still gets in.
        const creatorAgain = await connectAndJoin(code, { creatorToken });
        await creatorAgain.waitFor('init');
        console.log('STEP 2 - creator token bypasses the shared-IP ban: PASS');

        // A plain joiner (no token, same IP) is still banned while the session lives.
        const bystander = await connectAndJoin(code);
        const err2 = await bystander.waitFor('join-error');
        assert(err2.reason === 'kicked', 'tokenless join from the kicked IP stays banned while the session lives');

        // Session-scoped: empty the room, let the session die, rejoin freely.
        creator.ws.close();
        creatorAgain.ws.close();
        await sleep(500);
        const fresh = await connectAndJoin(code);
        await fresh.waitFor('init');
        console.log('STEP 3 - ban dies with the session (lazy-recreated room is open again): PASS');
        fresh.ws.close();

        console.log('All sticky-kick checks passed.');
    } finally {
        server.kill();
        await sleep(200);
    }
}

await main();
