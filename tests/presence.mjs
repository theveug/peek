// Accounts Phase 3 (presence) — raw fetch, no browser:
//   1. a friend who has never polled shows offline (last_seen_at is NULL),
//   2. polling GET /api/friends/presence is itself the heartbeat — the
//      poller's own account then shows online in a friend's presence list,
//   3. presence only reports accepted friends, not incoming/outgoing/blocked,
//   4. no cookie -> 401,
//   5. accounts-disabled deployment -> 404.
//
// Run with: npm run test:presence

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed dev cert

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

function startServer(port, envOverrides = {}) {
    const proc = spawn(process.execPath, ['server.js'], {
        env: { ...process.env, PORT: String(port), DEBUG: '', NODE_ENV: 'test', ACCOUNTS_ENABLED: '', ACCOUNTS_DB_PATH: '', ...envOverrides },
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

function cookiePair(res) {
    const raw = res.headers.get('set-cookie');
    if (!raw) return null;
    return raw.split(';')[0];
}

async function register(base, username, password) {
    const res = await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    return cookiePair(res);
}

async function sendRequest(base, cookie, username) {
    const res = await fetch(`${base}/api/friends/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ username }),
    });
    return { status: res.status, body: await res.json() };
}

async function getFriends(base, cookie) {
    const res = await fetch(`${base}/api/friends`, { headers: { Cookie: cookie } });
    return { status: res.status, body: await res.json() };
}

async function accept(base, cookie, requestId) {
    const res = await fetch(`${base}/api/friends/${requestId}/accept`, { method: 'POST', headers: { Cookie: cookie } });
    return { status: res.status, body: await res.json() };
}

async function presence(base, cookie) {
    const res = await fetch(`${base}/api/friends/presence`, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: res.status, body: res.ok ? await res.json() : await res.json().catch(() => null) };
}

async function main() {
    const scratchDir = mkdtempSync(path.join(tmpdir(), 'peek-presence-test-'));
    const dbPath = path.join(scratchDir, 'peek.db');
    const BASE = 'https://localhost:3135';

    let server = await startServer(3135, { ACCOUNTS_ENABLED: '1', ACCOUNTS_DB_PATH: dbPath });
    try {
        const aliceName = `alice_${Date.now()}`;
        const bobName = `bob_${Date.now()}`;
        const cookieA = await register(BASE, aliceName, 'correct-horse-battery');
        const cookieB = await register(BASE, bobName, 'another-horse-battery');

        await sendRequest(BASE, cookieA, bobName);
        const bobView = await getFriends(BASE, cookieB);
        await accept(BASE, cookieB, bobView.body.incoming[0].requestId);

        // --- 1. Bob has never polled -> Alice sees him offline ---
        const aliceSeesBob1 = await presence(BASE, cookieA);
        assert(aliceSeesBob1.status === 200, 'GET /api/friends/presence: 200 for a logged-in user');
        const bobEntry1 = aliceSeesBob1.body.presence.find(p => p.username === bobName);
        assert(bobEntry1 && bobEntry1.online === false, 'a friend who has never polled shows offline');

        // --- 2. Bob polls (his own heartbeat) -> Alice now sees him online ---
        const bobPoll = await presence(BASE, cookieB);
        assert(bobPoll.status === 200, "Bob's own poll succeeds");
        const aliceSeesBob2 = await presence(BASE, cookieA);
        const bobEntry2 = aliceSeesBob2.body.presence.find(p => p.username === bobName);
        assert(bobEntry2 && bobEntry2.online === true, "polling is itself the heartbeat — Bob now shows online to Alice");

        // --- 3. only accepted friends appear, not incoming/outgoing/blocked ---
        const carolName = `carol_${Date.now()}`;
        const cookieC = await register(BASE, carolName, 'correct-horse-battery');
        await sendRequest(BASE, cookieA, carolName); // still pending, not accepted
        const aliceSeesCarol = await presence(BASE, cookieA);
        assert(!aliceSeesCarol.body.presence.some(p => p.username === carolName), 'a pending (not-yet-accepted) request does not appear in presence');

        // --- 4. no cookie ---
        const noCookie = await presence(BASE, null);
        assert(noCookie.status === 401, 'GET /api/friends/presence: 401 with no cookie');
    } finally {
        server.kill();
        await sleep(200);
    }

    // --- 5. accounts-disabled deployment ---
    server = await startServer(3136); // ACCOUNTS_ENABLED left unset
    try {
        const BASE2 = 'https://localhost:3136';
        assert((await fetch(`${BASE2}/api/friends/presence`)).status === 404, 'accounts disabled: GET /api/friends/presence is a plain 404');
    } finally {
        server.kill();
        await sleep(200);
    }

    rmSync(scratchDir, { recursive: true, force: true });
    console.log('All presence checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
