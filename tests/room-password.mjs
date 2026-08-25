// Live room-password rotation (creator-only) with raw ws clients (no browser):
//   1. the creator's set-password broadcasts 'password-update' to every peer
//      in the room (including the creator), and a later /api/validate-room
//      check reflects the new password immediately,
//   2. a peer already connected when the password changes is NOT kicked —
//      their socket stays open and keeps receiving messages,
//   3. a non-creator's set-password is silently ignored (no broadcast, and
//      the old password still validates afterward),
//   4. the creator can remove password protection entirely (falsy value),
//      after which /api/validate-room needs no password at all,
//   5. the old password stops validating once it's been rotated away.
//
// Enforcement (creator-only, server-side) mirrors mic-policy.mjs's test
// shape for the analogous room-rule feature. Only-affects-future-joins is a
// deliberate design choice (see SessionManager.setPassword's doc comment) —
// this test's point 2 is exactly what guards that choice from regressing
// into an accidental mass-kick.
//
// Run with: npm run test:room-password

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed dev cert

const PORT = process.env.TEST_PORT || 3122;
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
function connectAndJoin(code, { creatorToken, password } = {}) {
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
            if (password) join.password = password;
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

async function validateRoom(code, password) {
    const res = await fetch(`${BASE_URL}/api/validate-room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, password }),
    });
    return res.json();
}

async function main() {
    const server = await startServer();
    try {
        const PW1 = 'first-pw';
        const PW2 = 'rotated-pw';
        const { code, creatorToken } = await createRoom({ password: PW1 });

        const creator = await connectAndJoin(code, { creatorToken, password: PW1 });
        const peerB = await connectAndJoin(code, { password: PW1 });

        // --- 3. non-creator's set-password is ignored ---
        peerB.ws.send(JSON.stringify({ type: 'set-password', payload: { password: 'hijacked' } }));
        await sleep(400);
        assert(!creator.messages.some(m => m.type === 'password-update'),
            "non-creator's set-password produced no broadcast");
        const stillPw1 = await validateRoom(code, PW1);
        assert(stillPw1.valid === true, 'old password still validates after the forged non-creator attempt');

        // --- 1. creator's change broadcasts to everyone and updates validation ---
        creator.ws.send(JSON.stringify({ type: 'set-password', payload: { password: PW2 } }));
        const updCreator = await creator.waitFor('password-update');
        const updB = await peerB.waitFor('password-update');
        assert(updCreator.payload?.password === PW2, 'creator received their own password-update with the new value');
        assert(updB.payload?.password === PW2, 'other peer received the password-update with the new value');
        assert(updCreator.payload?.hasPassword === true && updB.payload?.hasPassword === true, 'hasPassword flag is true on both');

        const newValidates = await validateRoom(code, PW2);
        assert(newValidates.valid === true, '/api/validate-room accepts the new password immediately');

        // --- 5. the old password no longer works for a fresh join ---
        const oldFails = await validateRoom(code, PW1);
        assert(oldFails.valid === false, 'the old password no longer validates after rotation');

        // --- 2. peers already connected are NOT kicked ---
        assert(creator.ws.readyState === WebSocket.OPEN, "creator's socket stays open after the password change");
        assert(peerB.ws.readyState === WebSocket.OPEN, "peer B's socket stays open after the password change");
        // Prove the connection is still live, not just technically un-closed.
        creator.ws.send(JSON.stringify({ type: 'list-bans' }));
        const banList = await creator.waitFor('ban-list');
        assert(Array.isArray(banList.bans), 'creator socket still processes requests normally after the rotation');

        // --- 4. creator removes password protection entirely ---
        creator.ws.send(JSON.stringify({ type: 'set-password', payload: { password: null } }));
        // waitFor() would resolve against the FIRST 'password-update' already in
        // messages (the rotation from step 1) — just wait, then read the latest.
        await sleep(300);
        const removalMsg = creator.messages.filter(m => m.type === 'password-update').pop();
        assert(removalMsg.payload?.hasPassword === false && removalMsg.payload?.password === null,
            'removal broadcast carries hasPassword:false and password:null');

        const noPwNeeded = await validateRoom(code, null);
        assert(noPwNeeded.valid === true, '/api/validate-room needs no password at all after removal');

        creator.ws.close();
        peerB.ws.close();
        await sleep(200);
        console.log('All room-password checks passed.');
    } finally {
        server.kill();
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
