// Kick vs. ban semantics with raw ws clients (no browser):
//   1. kick is a one-time removal — the kicked peer can rejoin immediately,
//   2. ban sticks — the banned peer's rejoin is rejected with
//      join-error/banned and the socket is closed, for the session's lifetime,
//   3. a non-creator's 'ban' request is ignored server-side,
//   4. list-bans returns the banned entry with its display nickname and never
//      the raw IP; a non-creator's list-bans/unban requests get no response
//      and don't lift the ban,
//   5. the real unban (creator-only) lifts the IP gate and the peer can rejoin,
//   6. the creator token bypasses the IP gate — on localhost every client
//      shares one IP, so this test would deadlock itself without the bypass,
//      which is exactly the shared-NAT scenario the bypass exists for,
//   7. ban state is session-scoped: once the room empties (dies with the
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

/**
 * waitFor() (below) resolves to the *first* message of a type ever seen, so
 * it can't distinguish a fresh 'ban-list' reply from a stale one already in
 * the buffer — every test elsewhere only awaits each type once per
 * connection, so this never mattered until list-bans/unban need two. Polls
 * the raw messages array for the Nth occurrence instead.
 */
async function waitForNth(conn, type, n, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const matches = conn.messages.filter(m => m.type === type);
        if (matches.length >= n) return matches[n - 1];
        await sleep(50);
    }
    throw new Error(`timed out waiting for '${type}' occurrence #${n}`);
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

        // A persistent non-creator peer, connected before any ban happens on
        // this test's shared IP (every raw-ws client here is localhost) — used
        // later for the "non-creator can't manage the ban list" check, since
        // once the IP is banned no *new* non-creator connection could join at
        // all to test that with.
        const member = await connectAndJoin(code);
        await member.waitFor('init');

        // --- Kick does not stick ---
        const victim1 = await connectAndJoin(code);
        const victim1Init = await victim1.waitFor('init');
        creator.ws.send(JSON.stringify({ type: 'kick', to: victim1Init.peerId }));
        await victim1.waitFor('kicked');
        await sleep(300);
        const victim1Back = await connectAndJoin(code);
        const victim1BackInit = await victim1Back.waitFor('init');
        console.log('STEP 1 - kick is one-time, kicked peer can rejoin: PASS');

        // --- Non-creator ban attempts are ignored server-side ---
        victim1Back.ws.send(JSON.stringify({ type: 'ban', to: creatorInit.peerId }));
        await sleep(300);
        assert(creator.ws.readyState === WebSocket.OPEN, 'non-creator ban request is ignored (creator still connected)');

        // --- Ban sticks (and records a display nickname for the list below) ---
        creator.ws.send(JSON.stringify({ type: 'ban', to: victim1BackInit.peerId, payload: { nickname: 'RowdyRaccoon' } }));
        await victim1Back.waitFor('banned');
        console.log('STEP 2 - banned peer received banned: PASS');
        await sleep(300);

        const banRetry = await connectAndJoin(code);
        const err = await banRetry.waitFor('join-error');
        assert(err.reason === 'banned', `rejoin after ban is rejected with reason banned, got "${err.reason}"`);
        await sleep(300);
        assert(banRetry.ws.readyState === WebSocket.CLOSED, 'rejected socket is closed by the server');

        // --- Ban list: shows the entry with its display nickname, never the IP ---
        creator.ws.send(JSON.stringify({ type: 'list-bans' }));
        const listMsg = await waitForNth(creator, 'ban-list', 1);
        const entry = listMsg.bans.find(b => b.nickname === 'RowdyRaccoon');
        assert(!!entry, 'ban list includes the banned peer with the display nickname sent at ban time');
        assert(listMsg.bans.every(b => !('ip' in b)), 'ban list entries never expose the raw IP to the client');
        console.log('STEP 2b - list-bans returns the entry with nickname, no IP: PASS');

        // --- Non-creator list-bans/unban requests get no response at all ---
        member.ws.send(JSON.stringify({ type: 'list-bans' }));
        member.ws.send(JSON.stringify({ type: 'unban', payload: { banId: entry.banId } }));
        await sleep(300);
        assert(member.messages.filter(m => m.type === 'ban-list').length === 0,
            'non-creator list-bans/unban requests get no response');
        // ...and the ban is provably still in effect (the unban attempt above didn't work).
        creator.ws.send(JSON.stringify({ type: 'list-bans' }));
        const stillBanned = await waitForNth(creator, 'ban-list', 2);
        assert(stillBanned.bans.some(b => b.banId === entry.banId), 'forged non-creator unban did not lift the ban');

        // --- Creator token bypasses the shared-IP gate (ban still active) ---
        // Presenting the token again reclaims creator status onto this NEW
        // connection (claimModerator reassigns session.creatorPeerId) and
        // demotes the original `creator` socket — so every creator-privileged
        // action from here on must go through `creatorAgain`, not `creator`.
        const creatorAgain = await connectAndJoin(code, { creatorToken });
        await creatorAgain.waitFor('init');
        console.log('STEP 3 - creator token bypasses the shared-IP ban: PASS');

        // --- The real unban lifts the IP gate ---
        creatorAgain.ws.send(JSON.stringify({ type: 'unban', payload: { banId: entry.banId } }));
        const afterUnban = await waitForNth(creatorAgain, 'ban-list', 1);
        assert(!afterUnban.bans.some(b => b.banId === entry.banId), 'unban removes the entry from the list');

        const rejoinAfterUnban = await connectAndJoin(code);
        await rejoinAfterUnban.waitFor('init');
        console.log('STEP 4 - unban lifts the IP gate, peer can rejoin: PASS');
        rejoinAfterUnban.ws.close();

        // --- Ban dies with the session regardless (belt-and-suspenders) ---
        member.ws.close();
        creator.ws.close();
        creatorAgain.ws.close();
        await sleep(500);
        const fresh = await connectAndJoin(code);
        await fresh.waitFor('init');
        console.log('STEP 5 - ban state dies with the session (lazy-recreated room is open again): PASS');
        fresh.ws.close();

        console.log('All kick/ban checks passed.');
    } finally {
        server.kill();
        await sleep(200);
    }
}

await main();
