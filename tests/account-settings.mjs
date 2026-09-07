// Accounts Phase 1c/1d (sync color scheme account-wide, camera/mic/speaker
// per-device) — raw fetch, no browser:
//   1. never-saved account -> GET /api/auth/settings returns 200 {},
//   2. PUT a full valid 3-key (color-scheme) blob -> GET reflects exactly
//      those keys, and a device key sent to this endpoint is silently
//      dropped (confirms the Phase 1d split actually happened server-side),
//   3. PUT with an unknown key and a non-string value for an allowed key ->
//      both are stripped/dropped, not stored,
//   4. GET/PUT with no cookie -> 401 for both,
//   5. logout, then replay the old cookie -> 401 for both (real revocation),
//   6. a second account's settings never leak into the first's GET,
//   7. an accounts-DISABLED deployment 404s all four routes,
//   8. two different deviceIds under the SAME account have independent
//      device-settings, missing/invalid deviceId -> 400 on both routes.
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

        // --- 2. PUT a full valid (color-scheme) blob, GET reflects it; a
        // device key sent here is silently dropped (Phase 1d split) ---
        const colorBlob = { theme: 'dark', accentHue: 'indigo', bgTint: 'ocean' };
        const putRes = await fetch(`${BASE}/api/auth/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Cookie: cookieA },
            body: JSON.stringify({ settings: { ...colorBlob, camDeviceId: 'should-be-dropped' } }),
        });
        assert(putRes.status === 200, 'PUT settings: 200 on a valid blob');
        const afterPutRes = await fetch(`${BASE}/api/auth/settings`, { headers: { Cookie: cookieA } });
        const afterPutBody = await afterPutRes.json();
        assert(JSON.stringify(afterPutBody) === JSON.stringify(colorBlob), 'GET settings: reflects only the 3 color-scheme keys');
        assert(!('camDeviceId' in afterPutBody), 'a device key sent to the global endpoint is silently dropped, not stored (Phase 1d split)');

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

        // --- 8. per-device settings: two devices, same account, independent values ---
        const phonePut = await fetch(`${BASE}/api/auth/device-settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Cookie: cookieB },
            body: JSON.stringify({ deviceId: 'phone-1', settings: { camDeviceId: 'phone-camera' } }),
        });
        assert(phonePut.status === 200, 'PUT device-settings: 200 for deviceId "phone-1"');
        const desktopPut = await fetch(`${BASE}/api/auth/device-settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Cookie: cookieB },
            body: JSON.stringify({ deviceId: 'desktop-1', settings: { camDeviceId: 'desktop-camera' } }),
        });
        assert(desktopPut.status === 200, 'PUT device-settings: 200 for deviceId "desktop-1"');

        const phoneGet = await fetch(`${BASE}/api/auth/device-settings?deviceId=phone-1`, { headers: { Cookie: cookieB } });
        const phoneBody = await phoneGet.json();
        assert(phoneBody.camDeviceId === 'phone-camera', "phone-1's own device-settings are unaffected by desktop-1's");

        const desktopGet = await fetch(`${BASE}/api/auth/device-settings?deviceId=desktop-1`, { headers: { Cookie: cookieB } });
        const desktopBody = await desktopGet.json();
        assert(desktopBody.camDeviceId === 'desktop-camera', "desktop-1's own device-settings are unaffected by phone-1's");

        const missingDeviceIdGet = await fetch(`${BASE}/api/auth/device-settings`, { headers: { Cookie: cookieB } });
        assert(missingDeviceIdGet.status === 400, 'GET device-settings: 400 with no deviceId query param');
        const missingDeviceIdPut = await fetch(`${BASE}/api/auth/device-settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Cookie: cookieB },
            body: JSON.stringify({ settings: { camDeviceId: 'x' } }),
        });
        assert(missingDeviceIdPut.status === 400, 'PUT device-settings: 400 with no deviceId in the body');

        const noCookieDeviceGet = await fetch(`${BASE}/api/auth/device-settings?deviceId=phone-1`);
        assert(noCookieDeviceGet.status === 401, 'GET device-settings: 401 with no cookie');
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

        const deviceGetRes = await fetch(`${BASE2}/api/auth/device-settings?deviceId=phone-1`);
        assert(deviceGetRes.status === 404, 'accounts disabled: GET /api/auth/device-settings is a plain 404');
        const devicePutRes = await fetch(`${BASE2}/api/auth/device-settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: 'phone-1', settings: { camDeviceId: 'x' } }),
        });
        assert(devicePutRes.status === 404, 'accounts disabled: PUT /api/auth/device-settings is a plain 404');
    } finally {
        server.kill();
        await sleep(200);
    }

    rmSync(scratchDir, { recursive: true, force: true });
    console.log('All account-settings checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
