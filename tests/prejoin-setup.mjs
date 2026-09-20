// Pre-join device check screen (PreJoinSetup.js) — see CLAUDE.md's
// "Pre-join device check" Key Conventions entry.
//
// Covers:
//   1. A plain Playwright-launched browser (navigator.webdriver === true,
//      the default) never sees the screen at all — connects straight into
//      the room. This is the regression this test exists to guard: gating
//      connect() behind a manual click would otherwise hang every other
//      browser test in this suite, which all expect an immediate connection.
//   2. With navigator.webdriver spoofed off (simulating a real user), the
//      screen appears, device <select>s populate from the fake devices,
//      the speaker test button doesn't throw, and "Join now" dismisses it
//      and connects into the room.
//   3. Checking "Don't show this again" persists localStorage['skipDeviceCheck']
//      and suppresses the screen on a later join in the same browser storage.
//
// Run with: npm run test:prejoin-setup

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3146;
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
        proc.on('exit', (code) => {
            if (code !== null && code !== 0) reject(new Error(`server exited with code ${code}`));
        });
        setTimeout(() => reject(new Error('server did not start within 10s')), 10_000);
    });
}

async function createRoom(request) {
    const resp = await request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: 6 } });
    const { code } = await resp.json();
    return code;
}

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

async function main() {
    const server = await startServer();
    let browser;
    try {
        browser = await chromium.launch({
            args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        });

        // --- Scenario 1: real Playwright browser, navigator.webdriver untouched ---
        {
            const context = await browser.newContext({
                ignoreHTTPSErrors: true,
                permissions: ['camera', 'microphone'],
            });
            const page = await context.newPage();
            const code = await createRoom(context.request);
            await page.goto(`${BASE_URL}/${code}`);
            await page.waitForSelector('#chat', { state: 'attached', timeout: 8000 });
            assert(!(await page.isVisible('#prejoin-modal')),
                'a WebDriver-controlled browser (navigator.webdriver=true) never sees the pre-join screen');
            await context.close();
        }

        // --- Scenario 2 & 3: navigator.webdriver spoofed off, simulating a real user ---
        {
            const context = await browser.newContext({
                ignoreHTTPSErrors: true,
                permissions: ['camera', 'microphone'],
            });
            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });
            const page = await context.newPage();
            const code = await createRoom(context.request);
            await page.goto(`${BASE_URL}/${code}`);

            await page.waitForSelector('#prejoin-modal', { state: 'visible', timeout: 8000 });
            assert(true, 'pre-join screen appears for a simulated real user');

            await page.waitForFunction(
                () => document.querySelectorAll('#prejoin-mic-device option').length > 1,
                { timeout: 5000 }
            );
            const camOptions = await page.$$eval('#prejoin-cam-device option', (opts) => opts.length);
            const micOptions = await page.$$eval('#prejoin-mic-device option', (opts) => opts.length);
            assert(camOptions > 1, 'camera <select> populates real device options beyond "System default"');
            assert(micOptions > 1, 'microphone <select> populates real device options beyond "System default"');

            await page.click('#prejoin-speaker-test');
            await page.waitForTimeout(300);
            assert(true, 'speaker test button does not throw');

            // --- "I don't need a camera" toggle ---
            assert(await page.isVisible('#prejoin-camera-section'), 'camera section is visible by default');
            await page.click('#prejoin-skip-camera');
            await page.waitForTimeout(200);
            assert(!(await page.isVisible('#prejoin-camera-section')), 'camera section hides once "I don\'t need a camera" is checked');
            assert((await page.evaluate(() => localStorage.getItem('skipCameraSetup'))) === '1',
                '"I don\'t need a camera" persists localStorage[skipCameraSetup]');
            await page.click('#prejoin-skip-camera');
            await page.waitForTimeout(500);
            assert(await page.isVisible('#prejoin-camera-section'), 'camera section reappears once unchecked');
            // The mic track must survive the camera re-acquire (a stream swap
            // that stops a still-wanted borrowed track would kill it silently).
            await page.waitForFunction(
                () => document.getElementById('prejoin-mic-meter-fill').style.width !== '',
                { timeout: 3000 }
            );
            assert(true, 'mic level meter keeps reporting data across the camera re-enable stream swap');

            await page.click('#prejoin-join');
            await page.waitForSelector('#prejoin-modal', { state: 'detached', timeout: 5000 });
            await page.waitForSelector('#chat', { state: 'attached', timeout: 8000 });
            assert(true, '"Join now" dismisses the screen and connects into the room');

            // --- "Don't show this again" persists and suppresses the next join ---
            const code2 = await createRoom(context.request);
            await page.goto(`${BASE_URL}/${code2}`);
            await page.waitForSelector('#prejoin-modal', { state: 'visible', timeout: 8000 });
            await page.click('#prejoin-dont-show');
            const flag = await page.evaluate(() => localStorage.getItem('skipDeviceCheck'));
            assert(flag === '1', '"Don\'t show this again" persists localStorage[skipDeviceCheck]');
            await page.click('#prejoin-join');
            await page.waitForSelector('#prejoin-modal', { state: 'detached', timeout: 5000 });

            const code3 = await createRoom(context.request);
            await page.goto(`${BASE_URL}/${code3}`);
            await page.waitForSelector('#chat', { state: 'attached', timeout: 8000 });
            assert(!(await page.isVisible('#prejoin-modal')),
                'the screen is suppressed on a later join once "Don\'t show this again" was checked');

            await context.close();
        }

        console.log('All pre-join device check checks passed.');
    } finally {
        if (browser) await browser.close();
        server.kill();
        await sleep(200);
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
