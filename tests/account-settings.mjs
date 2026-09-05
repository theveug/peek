// Accounts Phase 1c (sync color scheme + device selection to account) — raw
// fetch, no browser:
//   1. never-saved account -> GET /api/auth/settings returns 200 {},
//   2. PUT a full valid 6-key blob -> GET reflects exactly those keys,
//   3. PUT with an unknown key and a non-string value for an allowed key ->
//      both are stripped/dropped, not stored,
//   4. GET/PUT with no cookie -> 401 for both,
//   5. logout, then replay the old cookie -> 401 for both (real revocation),
//   6. a second account's settings never leak into the first's GET,
//   7. an accounts-DISABLED deployment 404s both routes.
//
// Run with: npm run test:account-settings

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

async function main() {
    const scratchDir = mkdtempSync(path.join(tmpdir(), 'peek-account-settings-test-'));
    const dbPath = path.join(scratchDir, 'peek.db');
    const BASE = 'https://localhost:3131';

    // --- scenarios 1-6: accounts enabled ---
    let server = await startServer(3131, { ACCOUNTS_ENABLED: '1', ACCOUNTS_DB_PATH: dbPath });
    try {
        // --- 1. never-saved account ---
        const cookieA = await register(BASE, `alice_${Date.now()}`, 'correct-horse-battery');
        const initialRes = await fetch(`${BASE}/api/auth/settings`, { headers: { Cookie: cookieA } });
        assert(initialRes.status === 200, 'GET settings: 200 for a fresh account');
        const initialBody = await initialRes.json();
        assert(Object.keys(initialBody).length === 0, 'GET settings: {} when nothing has ever been saved');

        // --- 2. PUT a full valid blob, GET reflects it ---
        const fullBlob = {
            theme: 'dark', accentHue: 'indigo', bgTint: 'ocean',
            camDeviceId: 'cam-123', micDeviceId: 'mic-456', speakerDeviceId: 'spk-789',
        };
        const putRes = await fetch(`${BASE}/api/auth/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Cookie: cookieA },
            body: JSON.stringify({ settings: fullBlob }),
        });
        assert(putRes.status === 200, 'PUT settings: 200 on a valid full blob');
        const afterPutRes = await fetch(`${BASE}/api/auth/settings`, { headers: { Cookie: cookieA } });
        const afterPutBody = await afterPutRes.json();
        assert(JSON.stringify(afterPutBody) === JSON.stringify(fullBlob), 'GET settings: reflects exactly the 6 keys just saved');

        // --- 3. unknown key + non-string value are both stripped ---
        const dirtyRes = await fetch(`${BASE}/api/auth/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Cookie: cookieA },
            body: JSON.stringify({ settings: { theme: 123, accentHue: 'violet', evil: 'haxx0r' } }),
        });
        assert(dirtyRes.status === 200, 'PUT settings: 200 even with junk mixed in (silently filtered, not rejected)');
        const afterDirtyRes = await fetch(`${BASE}/api/auth/settings`, { headers: { Cookie: cookieA } });
        const afterDirtyBody = await afterDirtyRes.json();
        assert(!('evil' in afterDirtyBody), 'unknown key is stripped, never stored');
        assert(!('theme' in afterDirtyBody), 'non-string value for an allowed key is dropped, not coerced');
        assert(afterDirtyBody.accentHue === 'violet', 'a valid key in the same request is still saved');

        // --- 4. no cookie at all ---
        const noCookieGet = await fetch(`${BASE}/api/auth/settings`);
        assert(noCookieGet.status === 401, 'GET settings: 401 with no cookie');
        const noCookiePut = await fetch(`${BASE}/api/auth/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { theme: 'dark' } }),
        });
        assert(noCookiePut.status === 401, 'PUT settings: 401 with no cookie');

        // --- 5. logout revokes the session for these routes too ---
        await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookieA } });
        const afterLogoutGet = await fetch(`${BASE}/api/auth/settings`, { headers: { Cookie: cookieA } });
        assert(afterLogoutGet.status === 401, 'GET settings: 401 after logout, replaying the old cookie');
        const afterLogoutPut = await fetch(`${BASE}/api/auth/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Cookie: cookieA },
            body: JSON.stringify({ settings: { theme: 'light' } }),
        });
        assert(afterLogoutPut.status === 401, 'PUT settings: 401 after logout, replaying the old cookie');

        // --- 6. no cross-user leakage ---
        const cookieB = await register(BASE, `bob_${Date.now()}`, 'another-horse-battery');
        const bResRes = await fetch(`${BASE}/api/auth/settings`, { headers: { Cookie: cookieB } });
        const bBody = await bResRes.json();
        assert(Object.keys(bBody).length === 0, "a second account's settings start empty, unaffected by the first account's saved data");
    } finally {
        server.kill();
        await sleep(200);
    }

    // --- 7. accounts-disabled deployment ---
    server = await startServer(3132); // ACCOUNTS_ENABLED left unset
    try {
        const BASE2 = 'https://localhost:3132';
        const getRes = await fetch(`${BASE2}/api/auth/settings`);
        assert(getRes.status === 404, 'accounts disabled: GET /api/auth/settings is a plain 404');
        const putRes = await fetch(`${BASE2}/api/auth/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { theme: 'dark' } }),
        });
        assert(putRes.status === 404, 'accounts disabled: PUT /api/auth/settings is a plain 404');
    } finally {
        server.kill();
        await sleep(200);
    }

    rmSync(scratchDir, { recursive: true, force: true });
    console.log('All account-settings checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
