// Playwright smoke test for the room UI. Spawns its own server instance on a
// dedicated port so it doesn't collide with a dev server you might have running,
// creates a room via the API, and drives the room page like a real user would.
//
// Run with: npm run test:ui

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3101;
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

async function createRoom(page) {
    const resp = await page.request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: 6 } });
    const { code } = await resp.json();
    return code;
}

function assert(condition, message) {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
    const server = await startServer();
    let browser;
    try {
        browser = await chromium.launch({
            args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        });
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            permissions: ['camera', 'microphone'],
        });
        const page = await context.newPage();

        const code = await createRoom(page);
        await page.goto(`${BASE_URL}/${code}`);
        await page.waitForSelector('#chat', { state: 'attached' });

        // --- Panel toggle tabs: attached to panel edges, vertically centered ---
        assert(await page.isVisible('#togglechat'), 'chat tab should be visible');
        assert(await page.isVisible('#toggle-members'), 'members tab should be visible');

        await page.click('#togglechat');
        assert(!(await page.isVisible('#chat-log')), 'chat panel should hide after clicking its tab');
        await page.click('#togglechat');
        assert(await page.isVisible('#chat-log'), 'chat panel should reopen after clicking its tab again');

        await page.click('#toggle-members');
        assert(
            await page.$eval('#members-sidebar', (el) => el.classList.contains('collapsed')),
            'members panel should collapse after clicking its tab'
        );
        await page.click('#toggle-members');
        assert(
            !(await page.$eval('#members-sidebar', (el) => el.classList.contains('collapsed'))),
            'members panel should reopen after clicking its tab again'
        );

        // --- Screen share button: monitor icon, stop button appears once sharing ---
        assert(!(await page.isVisible('#stop-share-button')), 'stop button should be hidden before sharing starts');
        await page.hover('#videos');
        await page.click('#share-toggle');
        await page.waitForSelector('#stop-share-button', { state: 'visible', timeout: 5000 });
        assert(await page.isVisible('#stop-share-button'), 'stop button should appear once sharing starts');

        await page.click('#stop-share-button');
        await page.waitForSelector('#stop-share-button', { state: 'hidden', timeout: 5000 });

        console.log('All UI smoke checks passed.');
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
