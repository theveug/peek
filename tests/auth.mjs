// Accounts Phase 1 (register/login/logout, SQLite-backed, opt-in via
// ACCOUNTS_ENABLED) — raw fetch, no browser:
//   1. register -> 201 + Set-Cookie, /api/auth/me with that cookie reflects
//      the username,
//   2. login (fresh request) -> 200 + Set-Cookie,
//   3. duplicate username -> rejected, original account's password still works,
//   4. wrong password -> 401, generic (doesn't distinguish user-not-found
//      from wrong-password),
//   5. logout -> real server-side revocation, not just a cleared cookie —
//      replaying the OLD raw token afterward still gets 401,
//   6. /api/auth/me with no cookie at all -> 401,
//   7. an accounts-DISABLED deployment: every /api/auth/* route 404s,
//      trust.accounts on the WS init payload is false, and the configured
//      ACCOUNTS_DB_PATH file never gets created on disk,
//   8. username validation edge cases -> 400.
//
// Run with: npm run test:auth

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed dev cert

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

function startServer(port, envOverrides = {}) {
    const proc = spawn(process.execPath, ['server.js'], {
        env: { ...process.env, PORT: String(port), DEBUG: '', NODE_ENV: 'test', ...envOverrides },
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

/** Extracts just the "name=value" pair off a Set-Cookie response header. */
function cookiePair(res) {
    const raw = res.headers.get('set-cookie');
    if (!raw) return null;
    return raw.split(';')[0];
}

async function main() {
    const scratchDir = mkdtempSync(path.join(tmpdir(), 'peek-auth-test-'));
    const dbPath = path.join(scratchDir, 'peek.db');
    const BASE = 'https://localhost:3129';

    // --- scenarios 1-6, 8: accounts enabled ---
    let server = await startServer(3129, { ACCOUNTS_ENABLED: '1', ACCOUNTS_DB_PATH: dbPath });
    try {
        // --- 1. register ---
        const registerRes = await fetch(`${BASE}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'alice', password: 'correct-horse-battery' }),
        });
        assert(registerRes.status === 201, 'register: 201 on success');
        const aliceCookie = cookiePair(registerRes);
        assert(!!aliceCookie, 'register: Set-Cookie present');

        const meRes = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: aliceCookie } });
        assert(meRes.status === 200, '/api/auth/me: 200 with a valid session cookie');
        const meBody = await meRes.json();
        assert(meBody.username === 'alice', '/api/auth/me reflects the registered username');
        assert(!('password_hash' in meBody) && !('password' in meBody), '/api/auth/me never leaks the password hash');

        // --- 2. login (fresh request) ---
        const loginRes = await fetch(`${BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'alice', password: 'correct-horse-battery' }),
        });
        assert(loginRes.status === 200, 'login: 200 on correct credentials');
        assert(!!cookiePair(loginRes), 'login: Set-Cookie present');

        // --- 3. duplicate username ---
        const dupeRes = await fetch(`${BASE}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'alice', password: 'a-different-password' }),
        });
        assert(dupeRes.status === 409, 'register: duplicate username rejected with 409');
        const stillWorksRes = await fetch(`${BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'alice', password: 'correct-horse-battery' }),
        });
        assert(stillWorksRes.status === 200, "original account's password still works after a rejected duplicate register");

        // --- 4. wrong password ---
        const wrongPwRes = await fetch(`${BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'alice', password: 'not-the-password' }),
        });
        assert(wrongPwRes.status === 401, 'login: wrong password -> 401');
        const noSuchUserRes = await fetch(`${BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'nobody-registered-this', password: 'whatever12345' }),
        });
        assert(noSuchUserRes.status === 401, 'login: nonexistent username -> 401');
        const wrongBody = await wrongPwRes.json();
        const noSuchBody = await noSuchUserRes.json();
        assert(wrongBody.error === noSuchBody.error, 'login: identical generic error for wrong-password vs no-such-user');

        // --- 5. logout is real revocation ---
        const logoutRes = await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { Cookie: aliceCookie } });
        assert(logoutRes.status === 204, 'logout: 204');
        const afterLogoutRes = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: aliceCookie } });
        assert(afterLogoutRes.status === 401, 'the OLD session token is rejected after logout (real revocation, not just a cleared cookie)');

        // --- 6. no cookie at all ---
        const noCookieRes = await fetch(`${BASE}/api/auth/me`);
        assert(noCookieRes.status === 401, '/api/auth/me with no cookie at all -> 401');

        // --- 8. username validation ---
        const tooShort = await fetch(`${BASE}/api/auth/register`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'ab', password: 'whatever12345' }),
        });
        assert(tooShort.status === 400, 'register: username too short -> 400');
        const badChars = await fetch(`${BASE}/api/auth/register`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'bad username!', password: 'whatever12345' }),
        });
        assert(badChars.status === 400, 'register: disallowed characters -> 400');
        const shortPw = await fetch(`${BASE}/api/auth/register`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'bob', password: 'short' }),
        });
        assert(shortPw.status === 400, 'register: password too short -> 400');
    } finally {
        server.kill();
        await sleep(200);
    }

    // --- 7. accounts-disabled deployment ---
    const disabledDbPath = path.join(scratchDir, 'should-never-exist.db');
    server = await startServer(3130, { ACCOUNTS_DB_PATH: disabledDbPath }); // ACCOUNTS_ENABLED left unset
    try {
        const BASE2 = 'https://localhost:3130';
        const regRes = await fetch(`${BASE2}/api/auth/register`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'carol', password: 'whatever12345' }),
        });
        assert(regRes.status === 404, 'accounts disabled: /api/auth/register is a plain 404');
        const meRes2 = await fetch(`${BASE2}/api/auth/me`);
        assert(meRes2.status === 404, 'accounts disabled: /api/auth/me is a plain 404');

        const ws = new WebSocket(`wss://localhost:3130`, { rejectUnauthorized: false });
        const init = await new Promise((resolve, reject) => {
            ws.on('error', reject);
            ws.on('open', () => ws.send(JSON.stringify({ type: 'join', sessionId: 'DDDDD' })));
            ws.on('message', (data) => {
                const msg = JSON.parse(data);
                if (msg.type === 'init') resolve(msg);
            });
            setTimeout(() => reject(new Error("timed out waiting for 'init'")), 5000);
        });
        assert(init.trust.accounts === false, "accounts disabled: trust.accounts is false on the WS 'init' payload");
        ws.close();

        assert(!existsSync(disabledDbPath), 'accounts disabled: no DB file was ever created on disk');
    } finally {
        server.kill();
        await sleep(200);
    }

    rmSync(scratchDir, { recursive: true, force: true });
    console.log('All auth checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
