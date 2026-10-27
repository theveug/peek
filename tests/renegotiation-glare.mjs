// Two-peer regression test for simultaneous renegotiation ("glare") and
// rapid mic double-presses. Owner-reported 2026-10-27: a peer who mutes and
// unmutes a lot (desktop hook, statuses that auto-mute) would every now and
// then stop hearing the other side until they rejoined. Covers:
//   1. both peers turning their camera on at the same instant — each must
//      still end up receiving the other's video;
//   2. both peers turning their mic on at the same instant — each must still
//      end up receiving the other's mic audio;
//   3. a fast double-press of the mic button is exactly two toggles (on then
//      off), not two overlapping "open the mic" calls.
//
// Run with: npm run test:glare

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3114;
const BASE_URL = `https://localhost:${PORT}`;

function startServer() {
    const proc = spawn(process.execPath, ['server.js'], {
        env: { ...process.env, PORT: String(PORT) },
        stdio: 'pipe',
    });
    return new Promise((resolve, reject) => {
        let out = '';
        const onData = (chunk) => {
            out += chunk.toString();
            if (out.includes('Server listening')) {
                proc.stdout.off('data', onData);
                resolve(proc);
            }
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', (chunk) => process.stderr.write(chunk));
        proc.on('error', reject);
        setTimeout(() => reject(new Error('server did not start within 10s')), 10_000);
    });
}

function assert(condition, message) {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
    console.log(`PASS: ${message}`);
}

const clickBoth = (pageA, pageB, id) => Promise.all([
    pageA.evaluate((i) => document.getElementById(i).click(), id),
    pageB.evaluate((i) => document.getElementById(i).click(), id),
]);

// True once the peer's mic <audio> element is playing a live track.
const hasLiveAudio = (page, peerId) => page.evaluate((p) => {
    const a = document.getElementById(`audio-${p}`);
    const t = a?.srcObject?.getAudioTracks?.()[0];
    return !!t && t.readyState === 'live';
}, peerId);

const hasVideo = (page, peerId) => page.evaluate((p) => {
    const v = document.querySelector(`#grid-view [data-peer-id="${p}-cam"] video`);
    return !!v && v.videoWidth > 0;
}, peerId);

async function waitFor(fn, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await fn()) return true;
        await sleep(250);
    }
    return false;
}

async function main() {
    const server = await startServer();
    const browser = await chromium.launch({
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    try {
        const ctxA = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
        const pageA = await ctxA.newPage();
        const resp = await pageA.request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: 6 } });
        const { code } = await resp.json();
        await pageA.goto(`${BASE_URL}/${code}`);

        const ctxB = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
        const pageB = await ctxB.newPage();
        await pageB.goto(`${BASE_URL}/${code}`);
        await pageB.waitForSelector('.participant-card:not([data-self])', { timeout: 10000 });
        await pageA.waitForSelector('.participant-card:not([data-self])', { timeout: 10000 });
        const peerA = (await pageB.locator('.participant-card:not([data-self])').getAttribute('id')).replace('participant-', '');
        const peerB = (await pageA.locator('.participant-card:not([data-self])').getAttribute('id')).replace('participant-', '');
        await sleep(1500); // let the initial connection settle

        // --- 1. simultaneous mic first-grant (both renegotiate at once) ---
        await clickBoth(pageA, pageB, 'mic-toggle');
        assert(await waitFor(() => hasLiveAudio(pageA, peerB)), 'A receives B\'s mic after both unmuted at the same instant');
        assert(await waitFor(() => hasLiveAudio(pageB, peerA)), 'B receives A\'s mic after both unmuted at the same instant');

        // --- 2. simultaneous camera on ---
        await clickBoth(pageA, pageB, 'cam-toggle');
        assert(await waitFor(() => hasVideo(pageA, peerB)), 'A receives B\'s camera after both turned it on at the same instant');
        assert(await waitFor(() => hasVideo(pageB, peerA)), 'B receives A\'s camera after both turned it on at the same instant');

        // --- 3. fast double-press from a fresh mic is exactly on-then-off ---
        const ctxC = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
        const pageC = await ctxC.newPage();
        await pageC.goto(`${BASE_URL}/${code}`);
        await pageC.waitForSelector('.participant-card:not([data-self])', { timeout: 10000 });
        await sleep(1000);
        await pageC.evaluate(() => {
            const b = document.getElementById('mic-toggle');
            b.click();
            b.click();
        });
        await sleep(2000);
        const muted = await pageC.evaluate(() => document.getElementById('mic-toggle').classList.contains('dock-btn-active-red'));
        assert(muted, 'a fast double-press on a fresh mic ends muted (two toggles, not two overlapping opens)');

        console.log('\nAll renegotiation-glare checks passed.');
    } finally {
        await browser.close();
        server.kill();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
