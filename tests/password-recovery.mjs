// Password recovery (2026-10-12) — raw fetch, no browser:
//   1. register returns 8 one-time recovery codes,
//   2. recover with a code + new password signs in, old password stops
//      working, every pre-existing session is revoked,
//   3. a spent code can't be reused; codes are case/dash-insensitive,
//   4. wrong code and nonexistent username fail with the identical error,
//   5. change-password needs the current password, keeps the caller's own
//      session and revokes the others,
//   6. regenerating codes needs the current password and invalidates the
//      old set; GET reports the remaining count,
//   7. all new routes 401 without a session (except /recover) and 404 on an
//      accounts-disabled deployment.
//
// Run with: npm run test:password-recovery

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
    return raw ? raw.split(';')[0] : null;
}

async function main() {
    const scratchDir = mkdtempSync(path.join(tmpdir(), 'peek-recovery-test-'));
    const dbPath = path.join(scratchDir, 'peek.db');
    const BASE = 'https://localhost:3139';
    const post = (route, body, cookie) => fetch(`${BASE}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(body),
    });
    const get = (route, cookie) => fetch(`${BASE}${route}`, { headers: cookie ? { Cookie: cookie } : {} });

    let server = await startServer(3139, { ACCOUNTS_ENABLED: '1', ACCOUNTS_DB_PATH: dbPath });
    try {
        // --- 1. register returns codes ---
        const reg = await post('/api/auth/register', { username: 'dave', password: 'original-pass-1' });
        assert(reg.status === 201, 'register: 201');
        const regCookie = cookiePair(reg);
        const { recoveryCodes } = await reg.json();
        assert(Array.isArray(recoveryCodes) && recoveryCodes.length === 8, 'register: returns 8 recovery codes');
        assert(recoveryCodes.every(c => /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(c)), 'recovery codes are XXXX-XXXX-XXXX-XXXX');
        assert(new Set(recoveryCodes).size === 8, 'recovery codes are distinct');

        const otherLogin = await post('/api/auth/login', { username: 'dave', password: 'original-pass-1' });
        const otherCookie = cookiePair(otherLogin);

        // --- 4. wrong code vs no such user ---
        const wrongCode = await post('/api/auth/recover', { username: 'dave', code: 'AAAA-AAAA-AAAA-AAAA', newPassword: 'new-pass-12345' });
        const noUser = await post('/api/auth/recover', { username: 'nobody-here', code: recoveryCodes[0], newPassword: 'new-pass-12345' });
        assert(wrongCode.status === 401 && noUser.status === 401, 'recover: wrong code and nonexistent user both 401');
        assert((await wrongCode.json()).error === (await noUser.json()).error, 'recover: identical error for wrong code vs no such user');

        const shortPw = await post('/api/auth/recover', { username: 'dave', code: recoveryCodes[0], newPassword: 'short' });
        assert(shortPw.status === 400, 'recover: too-short new password -> 400 (code not spent)');

        // --- 2. recover (lowercase, no dashes — normalization) ---
        const sloppy = recoveryCodes[0].toLowerCase().replace(/-/g, ' ');
        const rec = await post('/api/auth/recover', { username: 'DAVE', code: sloppy, newPassword: 'recovered-pass-1' });
        assert(rec.status === 200, 'recover: 200 with a valid code (case/dash-insensitive, case-insensitive username)');
        const recBody = await rec.json();
        assert(recBody.username === 'dave' && recBody.remainingCodes === 7, 'recover: returns canonical username and 7 remaining');
        const recCookie = cookiePair(rec);
        assert((await get('/api/auth/me', recCookie)).status === 200, 'recover: signs the caller in');
        assert((await get('/api/auth/me', regCookie)).status === 401, 'recover: pre-existing session #1 revoked');
        assert((await get('/api/auth/me', otherCookie)).status === 401, 'recover: pre-existing session #2 revoked');
        assert((await post('/api/auth/login', { username: 'dave', password: 'original-pass-1' })).status === 401, 'recover: old password no longer works');
        assert((await post('/api/auth/login', { username: 'dave', password: 'recovered-pass-1' })).status === 200, 'recover: new password works');

        // --- 3. spent code ---
        const reuse = await post('/api/auth/recover', { username: 'dave', code: recoveryCodes[0], newPassword: 'another-pass-1' });
        assert(reuse.status === 401, 'recover: a spent code cannot be reused');

        // --- 5. change password ---
        const second = cookiePair(await post('/api/auth/login', { username: 'dave', password: 'recovered-pass-1' }));
        const badCurrent = await post('/api/auth/change-password', { currentPassword: 'nope-nope-nope', newPassword: 'changed-pass-1' }, recCookie);
        assert(badCurrent.status === 403, 'change-password: wrong current password -> 403');
        const changed = await post('/api/auth/change-password', { currentPassword: 'recovered-pass-1', newPassword: 'changed-pass-1' }, recCookie);
        assert(changed.status === 200, 'change-password: 200 with correct current password');
        assert((await get('/api/auth/me', recCookie)).status === 200, "change-password: caller's own session survives");
        assert((await get('/api/auth/me', second)).status === 401, 'change-password: other sessions revoked');
        assert((await post('/api/auth/login', { username: 'dave', password: 'changed-pass-1' })).status === 200, 'change-password: new password works');

        // --- 6. regenerate ---
        const count = await (await get('/api/auth/recovery-codes', recCookie)).json();
        assert(count.remaining === 7, 'GET recovery-codes: reports 7 remaining');
        const regenBad = await post('/api/auth/recovery-codes', { currentPassword: 'wrong-wrong' }, recCookie);
        assert(regenBad.status === 403, 'regenerate: wrong current password -> 403');
        const regen = await post('/api/auth/recovery-codes', { currentPassword: 'changed-pass-1' }, recCookie);
        assert(regen.status === 200, 'regenerate: 200');
        const newCodes = (await regen.json()).recoveryCodes;
        assert(newCodes.length === 8, 'regenerate: 8 fresh codes');
        assert((await (await get('/api/auth/recovery-codes', recCookie)).json()).remaining === 8, 'regenerate: count back to 8');
        const oldCode = await post('/api/auth/recover', { username: 'dave', code: recoveryCodes[1], newPassword: 'x-pass-12345' });
        assert(oldCode.status === 401, 'regenerate: old unused codes are invalidated');

        // --- 7. no session ---
        assert((await post('/api/auth/change-password', { currentPassword: 'a', newPassword: 'abcdefgh1' })).status === 401, 'change-password: 401 without session');
        assert((await get('/api/auth/recovery-codes')).status === 401, 'GET recovery-codes: 401 without session');
        assert((await post('/api/auth/recovery-codes', { currentPassword: 'a' })).status === 401, 'POST recovery-codes: 401 without session');
    } finally {
        server.kill();
        await sleep(200);
    }

    server = await startServer(3139);
    try {
        assert((await post('/api/auth/recover', { username: 'a', code: 'b', newPassword: 'cccccccc' })).status === 404, 'accounts disabled: /recover is a plain 404');
        assert((await post('/api/auth/change-password', {})).status === 404, 'accounts disabled: /change-password is a plain 404');
        assert((await get('/api/auth/recovery-codes')).status === 404, 'accounts disabled: /recovery-codes is a plain 404');
    } finally {
        server.kill();
        await sleep(200);
    }

    rmSync(scratchDir, { recursive: true, force: true });
    console.log('All password-recovery checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
