// Two-peer regression test: the focus view must not get stuck on your own
// camera. Owner-reported 2026-10-23 — watching a peer's camera, pressing
// Focus landed on your own stream instead. Covers both ways a stale self
// focus could arise:
//   1. you clicked your own tile once, went back to grid, then pressed Focus;
//   2. the peer's stream ended while focused (focus fell back to self) and
//      then came back.
//
// Run with: npm run test:focus-repick

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3113;
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

const focusCaption = async (page) => (await page.locator('#focus-caption-text').textContent()).trim();

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
        const peerA = (await pageB.locator('.participant-card:not([data-self])').getAttribute('id')).replace('participant-', '');

        await pageA.click('#cam-toggle');
        await pageB.click('#cam-toggle');
        await pageB.waitForSelector(`#grid-view [data-peer-id="${peerA}-cam"] video`, { timeout: 15000 });
        await pageB.waitForSelector('#grid-view [data-peer-id="me-cam"]', { timeout: 15000 });

        // --- Path 1: explicit self focus, back to grid, press Focus ---
        await pageB.click('#grid-view [data-peer-id="me-cam"]');
        await pageB.waitForSelector('#focused-view', { state: 'visible' });
        assert((await focusCaption(pageB)).includes('(you)'), 'clicking your own tile focuses yourself');
        await pageB.click('#stage-view-grid');
        await pageB.click('#stage-view-focus');
        await sleep(300);
        assert(!(await focusCaption(pageB)).includes('(you)'), 'pressing Focus after returning to grid lands on the peer, not yourself');

        // --- Path 2: peer's stream ends (fallback to self), then returns ---
        await pageA.click('#cam-toggle');
        // (With no remote stream left the stage shows the waiting spinner, but
        // focusedPeerId has silently fallen back to 'me-cam' underneath.)
        await sleep(1500);
        await pageA.click('#cam-toggle');
        await sleep(2500);
        assert(!(await focusCaption(pageB)).includes('(you)'), 'when the peer\'s camera comes back, focus moves to them');

        console.log('\nAll focus-self-repick checks passed.');
    } finally {
        await browser.close();
        server.kill();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
