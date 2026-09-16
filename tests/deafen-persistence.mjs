// Deafen state must survive a page reload without silently resurrecting a
// live, transmitting mic — see CLAUDE.md's "Deafen state survives a refresh"
// Key conventions entry for the real-incident writeup this guards against.
//
// Root cause: mediaStateStore.js's "resume mic/cam/screen-share after a
// refresh" memory never tracked `deafened` at all, and PeerManager.setDeafened()
// never updated it when hard-muting the mic. A reload while deafened restored
// the *stale, pre-deafen* micEnabled:true and turned the mic back on for real,
// with nothing to restore the deafen wrapper over it.
//
// Covers, in one room with two peers:
//   1. Deafening while the mic is on persists both `micEnabled` (the
//      underlying manual choice) and `deafened` (the hard-mute wrapper) to
//      mediaStateStore, keyed by room code.
//   2. Reloading the deafened peer's page restores deafened state — its own
//      deafen AND mic dock buttons both come back showing muted/deafened, not
//      a resurrected live mic — and the other peer's card shows the deafen
//      badge again once the post-reload broadcast lands.
//   3. Undeafening, then reloading, does NOT spuriously restore deafened —
//      guards against a fix that always re-applies deafened on restore.
//
// Run with: npm run test:deafen-persist

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3125;
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

const isMicOn = () => !document.getElementById('mic-on-icon').classList.contains('hidden');
const isMicMuted = () => document.getElementById('mic-toggle').classList.contains('dock-btn-active-red');
const isDeafened = () => document.getElementById('deafen-toggle').classList.contains('dock-btn-active-red');

async function readMediaState(page, roomCode) {
    return page.evaluate(async ({ roomCode }) => {
        const store = await import('/client/mediaStateStore.js');
        return store.getMediaState(roomCode);
    }, { roomCode });
}

async function main() {
    const server = await startServer();
    const browser = await chromium.launch({
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    try {
        const aCtx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
        const aPage = await aCtx.newPage();
        const createResp = await aPage.request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: 6 } });
        const { code } = await createResp.json();
        await aPage.goto(`${BASE_URL}/${code}`);
        await aPage.waitForSelector('.participant-card[data-self]', { state: 'attached', timeout: 10000 });

        const bCtx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
        const bPage = await bCtx.newPage();
        await bPage.goto(`${BASE_URL}/${code}`);
        await bPage.waitForSelector('.participant-card:not([data-self])', { timeout: 10000 });
        await aPage.waitForSelector('.participant-card:not([data-self])', { timeout: 10000 });
        console.log('both peers joined: PASS');

        // --- Peer A turns the mic on, then deafens ---
        await aPage.click('#mic-toggle');
        await aPage.waitForFunction(isMicOn, null, { timeout: 5000 });
        await aPage.click('#deafen-toggle');
        await aPage.waitForFunction(isDeafened, null, { timeout: 5000 });
        assert(await aPage.evaluate(isMicMuted), 'deafening hard-mutes the mic dock button too');

        const savedWhileDeafened = await readMediaState(aPage, code);
        assert(savedWhileDeafened?.deafened === true, 'deafened:true persisted to mediaStateStore on deafen');
        assert(savedWhileDeafened?.micEnabled === true, 'the underlying manual mic choice (on) is still persisted separately from the deafen wrapper');
        console.log('STEP 1 - deafen state persisted to mediaStateStore: PASS');

        // --- Reload while deafened: the actual regression ---
        await aPage.reload();
        await aPage.waitForSelector('.participant-card[data-self]', { state: 'attached', timeout: 10000 });
        await aPage.waitForFunction(isDeafened, null, { timeout: 10000 });
        assert(await aPage.evaluate(isMicMuted), 'REGRESSION: mic came back live/unmuted after a reload while deafened');
        console.log('STEP 2a - own dock buttons restore to deafened+muted after reload, not a resurrected live mic: PASS');

        // The other peer's card badge lags behind the post-reload broadcast by
        // design (see CLAUDE.md) but must land, not stay permanently wrong.
        await bPage.waitForSelector('.participant-card:not([data-self]) .participant-deafen-icon', { timeout: 10000 });
        console.log('STEP 2b - other peer\'s card shows the deafen badge again after reconnect: PASS');

        // --- Undeafen, reload again: must NOT spuriously restore deafened ---
        await aPage.click('#deafen-toggle');
        // Self-contained (not a closure over isDeafened above) — Playwright
        // serializes this function to run inside the page, where the outer
        // Node-scope helper doesn't exist.
        await aPage.waitForFunction(
            () => !document.getElementById('deafen-toggle').classList.contains('dock-btn-active-red'),
            null,
            { timeout: 5000 }
        );
        const savedAfterUndeafen = await readMediaState(aPage, code);
        assert(savedAfterUndeafen?.deafened === false, 'deafened:false persisted on undeafen');

        await aPage.reload();
        await aPage.waitForSelector('.participant-card[data-self]', { state: 'attached', timeout: 10000 });
        await aPage.waitForFunction(isMicOn, null, { timeout: 10000 });
        assert(!(await aPage.evaluate(isDeafened)), 'a reload after undeafening does not spuriously restore deafened');
        assert(!(await aPage.evaluate(isMicMuted)), 'mic correctly restores to live/unmuted when the last saved state was not deafened');
        console.log('STEP 3 - undeafen-then-reload does not resurrect a false deafened state: PASS');

        console.log('All deafen-persistence checks passed.');
    } finally {
        await browser.close();
        server.kill();
        await sleep(200);
    }
}

await main();
