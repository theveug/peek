// Screen/cam quality: Settings panel = saved default (localStorage), in-room
// quick pickers (dock carets) = session-only override that a reload drops.
// Owner-requested 2026-11-06. See public/client/qualityOverrides.js.
//
// Run with: npm run test:quality-overrides

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3141;
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

const activeDockFps = (page) => page.evaluate(() =>
    document.querySelector('#share-quality-fps-picker button.active')?.dataset.value ?? null);
const storedFps = (page) => page.evaluate(() => localStorage.getItem('screenShareFps'));

async function openDockPopover(page) {
    await page.click('#share-quality-caret');
    await sleep(150);
}

async function main() {
    const server = await startServer();
    const browser = await chromium.launch({
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    try {
        const ctx = await browser.newContext({
            ignoreHTTPSErrors: true,
            permissions: ['camera', 'microphone'],
            viewport: { width: 1400, height: 900 },
        });
        const page = await ctx.newPage();
        const { code } = await (await page.request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: 6 } })).json();
        await page.goto(`${BASE_URL}/${code}`);
        await page.waitForSelector('.participant-card[data-self]', { state: 'attached', timeout: 10000 });

        assert(await storedFps(page) === '30', 'saved default starts at 30fps');

        // Dock picker = temp override.
        await openDockPopover(page);
        await page.click('#share-quality-fps-picker button[data-value="60"]');
        await sleep(100);
        assert(await activeDockFps(page) === '60', 'dock picker shows the 60fps override');
        assert(await storedFps(page) === '30', 'dock picker does not touch the saved default');

        // Reopen the popover: still shows the override this session.
        await page.click('#share-quality-caret');
        await sleep(100);
        await openDockPopover(page);
        assert(await activeDockFps(page) === '60', 'override sticks for the rest of the session');
        await page.click('#share-quality-caret');

        // Reload = new session: saved default comes back.
        await page.reload();
        await page.waitForSelector('.participant-card[data-self]', { state: 'attached', timeout: 10000 });
        await openDockPopover(page);
        assert(await activeDockFps(page) === '30', 'after reload the dock picker is back to the saved default');
        await page.click('#share-quality-fps-picker button[data-value="10"]'); // new override
        await page.click('#share-quality-caret');
        await sleep(100);

        // Settings panel = saved default, and clears the override.
        await page.click('#topbar-identity');
        await page.click('#topbar-identity-settings');
        await page.click('.settings-nav-item[data-settings-section="screen-sharing"]');
        await page.click('#settings-fps-picker button[data-value="15"]');
        await sleep(100);
        assert(await storedFps(page) === '15', 'Settings panel writes the saved default');
        await page.keyboard.press('Escape');
        await sleep(150);
        await openDockPopover(page);
        assert(await activeDockFps(page) === '15', 'changing the default in Settings replaces the in-call override');

        console.log('All quality-override checks passed.');
    } finally {
        await browser.close();
        server.kill();
        await sleep(200);
    }
}

await main();
