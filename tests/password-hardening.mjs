// Raw HTTP + ws server test (no browser) for the 2026-07-13 password-handling
// hardening:
//   1. crash guard: a non-string password (JSON can carry any type) stored via
//      /api/create-room or a lazy-create WS join used to reach Buffer.from()
//      inside validatePassword and throw — inside a ws 'message' listener
//      that's an uncaught exception that KILLED the whole server process.
//      Non-strings are now normalized to null at both intakes (and
//      validatePassword fails closed on a non-string stored password).
//   2. HTTP brute-force lockout: /api/validate-room used to allow 30 password
//      guesses/min/IP forever (a side door around the WS join throttle's 20
//      per 10 min) — after 20 wrong passwords the endpoint now 429s further
//      attempts against password-protected rooms from that IP.
//
// Run with: npm run test:password-hardening

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed dev cert

const PORT = process.env.TEST_PORT || 3123;
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

/** Opens a socket, sends a join (raw fields, no normalization), resolves with helpers. */
function connectAndJoin(code, joinExtras = {}) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
        const messages = [];
        const waiters = [];
        ws.on('message', (data) => {
            messages.push(JSON.parse(data));
            waiters.forEach(w => w());
        });
        ws.on('error', reject);
        ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'join', sessionId: code, ...joinExtras }));
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

async function createRoom(body) {
    const resp = await fetch(`${BASE_URL}/api/create-room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: resp.status, body: await resp.json() };
}

async function validateRoom(body) {
    const resp = await fetch(`${BASE_URL}/api/validate-room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: resp.status, body: resp.status === 200 ? await resp.json() : await resp.json().catch(() => null) };
}

const server = await startServer();
let exitCode = 0;

try {
    // --- 1a. Numeric password via the create-room API must not arm a crash ---
    const created = await createRoom({ password: 12345 });
    assert(created.status === 200, 'create-room with a numeric password still returns 200');
    const numericPwCode = created.body.code;

    // The room must be treated as passwordless (non-string normalized to null),
    // and — the actual regression — a join presenting a string password must
    // not kill the process (Buffer.from(12345) used to throw in the ws
    // 'message' listener).
    const joinA = await connectAndJoin(numericPwCode, { password: 'any-string-guess' });
    const initA = await joinA.waitFor('init');
    assert(!!initA.peerId, 'joining the numeric-password room with a string password yields init (no crash, room is passwordless)');
    joinA.ws.close();

    // --- 1b. Numeric password via a lazy-create WS join must not arm one either ---
    const lazyCode = 'Lzy' + String(PORT).slice(-2); // 5 chars, matches [A-Za-z0-9]{5}
    const joinB = await connectAndJoin(lazyCode, { password: 999 });
    await joinB.waitFor('init');
    // Second joiner presents a string password against the lazily-created room.
    const joinC = await connectAndJoin(lazyCode, { password: 'guess' });
    const initC = await joinC.waitFor('init');
    assert(!!initC.peerId, 'lazy-created room with a numeric password is passwordless, string-password join survives (no crash)');
    joinB.ws.close();
    joinC.ws.close();

    // Server is demonstrably still alive.
    const alive1 = await createRoom({});
    assert(alive1.status === 200, 'server process is still alive after both non-string-password paths');

    // --- 1c. Non-string password against a REAL password-protected room ---
    const protectedRoom = await createRoom({ password: 'hunter2' });
    const protectedCode = protectedRoom.body.code;
    const badType = await validateRoom({ code: protectedCode, password: { a: 1 } });
    assert(badType.status === 200 && badType.body.wrongPassword === true, 'an object password on validate-room is a clean wrong-password, not a 500');

    const joinD = await connectAndJoin(protectedCode, { password: 54321 });
    const errD = await joinD.waitFor('join-error');
    assert(errD.reason === 'invalid-password', 'a numeric password on a protected WS join is a clean invalid-password, not a crash');

    // --- 2. HTTP brute-force lockout ---
    // The counter is per-IP and session-global (the object-password validate
    // above already consumed one slot), so detect the boundary dynamically
    // rather than assuming a clean count. Every reply before the lockout must
    // be a normal wrong-password (never a 5xx), then a 429 must appear within
    // a sane number of guesses.
    let wrongReplies = 0;
    let lockedAt = -1;
    for (let i = 0; i < 30; i++) {
        const guess = await validateRoom({ code: protectedCode, password: `wrong-${i}` });
        if (guess.status === 429) { lockedAt = i; break; }
        if (guess.status !== 200 || guess.body.wrongPassword !== true) {
            throw new Error(`FAIL: guess ${i + 1} should be a wrong-password reply or a 429, got status ${guess.status}`);
        }
        wrongReplies++;
    }
    assert(wrongReplies > 0, 'wrong-password guesses get clean wrong-password replies (never a 5xx)');
    assert(lockedAt >= 0 && lockedAt <= 20, `the endpoint locks out within 20 guesses (locked after ${wrongReplies} wrong replies)`);

    const lockedCorrect = await validateRoom({ code: protectedCode, password: 'hunter2' });
    assert(lockedCorrect.status === 429, 'even the CORRECT password is locked out for that IP (no oracle left open)');

    // Passwordless rooms are untouched by the lockout (it only gates hasPassword rooms).
    const freeRoom = await createRoom({});
    const freeCheck = await validateRoom({ code: freeRoom.body.code });
    assert(freeCheck.status === 200 && freeCheck.body.valid === true, 'passwordless-room validation is unaffected by the lockout');

    console.log('\nAll password-hardening tests passed.');
} catch (err) {
    console.error(err.message || err);
    exitCode = 1;
} finally {
    server.kill();
    await sleep(200);
    process.exit(exitCode);
}
