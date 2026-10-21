// Two-peer test for the unified stream label + per-viewer frame-rate cap:
// the grid tile badge and the focus view badge both read "<H>p · <N>fps",
// the focus view uses the grid's name pill ("Name · Cam"), and picking a cap
// from the sender's card menu actually lowers the frame rate the viewer
// receives — then "Max" lifts it again.
//
// Run with: npm run test:receive-fps

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3112;
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

const BADGE_RE = /^(\d+)p · (\d+)fps$/;

/** Reads the badge's fps a few seconds after a change, once it has settled. */
async function settledFps(page, selector) {
    await sleep(4000);
    const text = (await page.locator(selector).textContent()).trim();
    const m = text.match(BADGE_RE);
    if (!m) throw new Error(`badge text "${text}" doesn't match "<H>p · <N>fps"`);
    return Number(m[2]);
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
        const peerA = (await pageB.locator('.participant-card:not([data-self])').getAttribute('id')).replace('participant-', '');

        await pageA.click('#cam-toggle');
        const tileBadge = `#grid-view [data-peer-id="${peerA}-cam"] .grid-tile-badge span:last-child`;
        await pageB.waitForSelector(tileBadge, { timeout: 15000 });
        const uncapped = await settledFps(pageB, tileBadge);
        assert(uncapped >= 10, `grid badge reads "<H>p · <N>fps" (uncapped ${uncapped}fps)`);

        // Cap to 5fps from A's card menu on B.
        await pageB.hover(`#participant-${peerA}`);
        await pageB.click(`#participant-${peerA} .participant-menu-btn`);
        const row = pageB.locator(`#participant-${peerA} .participant-fps-row`, { hasText: 'Camera fps' });
        assert(await row.count() === 1, 'card menu shows a Camera fps row while their camera is on');
        assert(await pageB.locator(`#participant-${peerA} .participant-fps-row`, { hasText: 'Screen fps' }).count() === 0,
            'no Screen fps row while they are not screen sharing');
        await row.locator('button', { hasText: /^5$/ }).click();
        const capped = await settledFps(pageB, tileBadge);
        assert(capped <= 7, `cap to 5fps lowers what B receives (now ${capped}fps)`);

        // Focus view uses the same pill + badge.
        await pageB.keyboard.press('Escape');
        await pageB.click(`#grid-view [data-peer-id="${peerA}-cam"]`);
        await pageB.waitForSelector('#focused-view', { state: 'visible' });
        const caption = (await pageB.locator('#focus-caption-text').textContent()).trim();
        assert(caption.endsWith('· Cam'), `focus name pill matches the grid label ("${caption}")`);
        const focusFps = await settledFps(pageB, '#focus-badge-text');
        assert(focusFps <= 7, `focus badge reads "<H>p · <N>fps" and reflects the cap (${focusFps}fps)`);

        // Lift the cap.
        await pageB.hover(`#participant-${peerA}`);
        await pageB.click(`#participant-${peerA} .participant-menu-btn`);
        await pageB.locator(`#participant-${peerA} .participant-fps-row`, { hasText: 'Camera fps' })
            .locator('button', { hasText: 'Max' }).click();
        const restored = await settledFps(pageB, '#focus-badge-text');
        assert(restored >= 10, `"Max" lifts the cap (back to ${restored}fps)`);

        console.log('\nAll receive-fps-cap checks passed.');
    } finally {
        await browser.close();
        server.kill();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
