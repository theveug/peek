// Ownership must survive a closed browser / restarted PC even when the room
// never emptied out (another peer kept it alive the whole time) — the
// scenario the lazy-room-owner fix does NOT cover, since that fix only kicks
// in when the session had actually died and got lazily recreated. Here the
// session stays alive throughout; only the owning browser's storage is lost.
//
// sessionStorage is what's actually lost on a closed browser/restarted PC —
// clearing it (rather than actually restarting the OS) is the faithful way
// to simulate that in a test. The fix under test is App.js falling back to
// the localStorage-backed ownerTokens store (keyed by room code) when
// sessionStorage has nothing.
//
// Run with: npm run test:owner-persist

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3121;
const BASE_URL = `https://localhost:${PORT}`;

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

const hasSelfCrown = () => {
    const crown = document.querySelector('.participant-card[data-self] .participant-crown');
    return !!crown && crown.style.display !== 'none';
};

async function main() {
    const server = await startServer();
    const browser = await chromium.launch({
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    try {
        // Owner creates the room via the normal lobby flow (not a lazy-join),
        // so this also proves the fix applies to explicitly-created rooms, not
        // just lazily-recreated ones.
        const ownerCtx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
        const ownerPage = await ownerCtx.newPage();
        const createResp = await ownerPage.request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: 6 } });
        const { code, creatorToken } = await createResp.json();
        await ownerCtx.addInitScript((token) => sessionStorage.setItem('creatorToken', token), creatorToken);
        await ownerPage.goto(`${BASE_URL}/${code}`);
        await ownerPage.waitForSelector('.participant-card[data-self]', { state: 'attached', timeout: 10000 });
        await ownerPage.waitForFunction(hasSelfCrown, null, { timeout: 5000 });
        console.log('owner joined, crown shown: PASS');

        // A second peer joins and stays — this is what keeps the session alive
        // across the owner's "restart" below, so the room is never lazily
        // recreated (the case the lazy-room-owner fix already covers).
        const otherCtx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
        const otherPage = await otherCtx.newPage();
        await otherPage.goto(`${BASE_URL}/${code}`);
        await otherPage.waitForSelector('.participant-card:not([data-self])', { timeout: 10000 });
        await ownerPage.waitForSelector('.participant-card:not([data-self])', { timeout: 10000 });
        console.log('second peer joined, keeping the room alive: PASS');

        // Sanity: without the fix, wiping sessionStorage alone would already
        // reproduce the reported bug on reload (below) — confirm the token is
        // actually localStorage-backed before we rely on that.
        const hasLocalBackup = await ownerPage.evaluate(() => !!localStorage.getItem('peek.ownerTokens'));
        assert(hasLocalBackup, 'creator token was mirrored into the localStorage-backed ownerTokens store');

        // Simulate "closed browser / restarted PC": sessionStorage is gone,
        // localStorage (a different, persistent storage area) is untouched.
        await ownerPage.evaluate(() => sessionStorage.clear());
        await ownerPage.reload();
        await ownerPage.waitForSelector('.participant-card[data-self]', { state: 'attached', timeout: 10000 });
        await ownerPage.waitForFunction(hasSelfCrown, null, { timeout: 5000 });
        console.log('STEP 1 - owner reclaims the crown after sessionStorage loss, room kept alive by another peer: PASS');

        // Reclaiming ownership must be a real, server-enforced fact — not just
        // a client-side crown icon — confirm a kick actually works post-reload.
        const otherCard = ownerPage.locator('.participant-card:not([data-self])').first();
        await otherCard.hover();
        await otherCard.locator('.participant-mod-btn').click();
        await ownerPage.waitForSelector('.participant-mod-popover:not(.hidden)', { timeout: 3000 });
        const kickBtn = ownerPage.locator('.participant-mod-popover:not(.hidden) button:has-text("Kick from room")');
        await kickBtn.click();
        await otherPage.waitForURL(/[?&]kicked=1/, { timeout: 5000 });
        console.log('STEP 2 - reclaimed ownership carries real kick power: PASS');

        console.log('All owner-token-persistence checks passed.');
    } finally {
        await browser.close();
        server.kill();
        await sleep(200);
    }
}

await main();
