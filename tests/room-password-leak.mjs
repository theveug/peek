// Regression test for a real bug: sessionStorage['roomPassword'] is a flat,
// non-room-scoped key. Creating/joining a passwordless room used to leave a
// PREVIOUS room's password sitting in that key untouched (only set when
// truthy, never cleared) — which then got silently sent on the next join and,
// via the server's lazy-recreate-adopts-joiner's-password path, permanently
// attached to a brand-new room that was created with no password at all.
//
// Run with: npm run test:password-leak

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3110;
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

function assert(cond, msg) {
    if (!cond) throw new Error('Assertion failed: ' + msg);
}

async function createRoom(page, { name, password }) {
    await page.fill('#create-name', name);
    await page.fill('#create-password', password || '');
    await page.click('#create-form button[type="submit"]');
    await page.waitForFunction(() => /^\/[A-Za-z0-9]{5}$/.test(location.pathname), { timeout: 10_000 });
    await page.waitForSelector('#chat', { state: 'attached' });
    return new URL(page.url()).pathname.slice(1);
}

async function leaveRoom(page) {
    await page.mouse.move(400, 400); // controls dock only shows on hover
    await sleep(300);
    // `force: true` because the dock's visibility is driven by a CSS :hover
    // rule, which Playwright's normal actionability check doesn't reliably
    // treat as "stable" in headless mode. Races the click against the full
    // page navigation it triggers (window.location.href, not SPA routing).
    await Promise.all([
        page.waitForNavigation({ timeout: 10_000 }),
        page.click('#leave-room-button', { force: true }),
    ]);
    assert(page.url() === `${BASE_URL}/`, `expected to land back on the lobby after leaving, got ${page.url()}`);
}

async function main() {
    const server = await startServer();
    let browser;
    try {
        browser = await chromium.launch({
            args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        });
        const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
        const page = await context.newPage();

        await page.goto(`${BASE_URL}/`);
        await createRoom(page, { name: 'Room A', password: 'secretA' });
        assert(
            (await page.evaluate(() => sessionStorage.getItem('roomPassword'))) === 'secretA',
            'roomPassword should be set after creating a password-protected room'
        );

        await leaveRoom(page);
        assert(
            (await page.evaluate(() => sessionStorage.getItem('roomPassword'))) === null,
            'roomPassword should be cleared after leaving a room'
        );

        const codeB = await createRoom(page, { name: 'Room B', password: '' });
        assert(
            (await page.evaluate(() => sessionStorage.getItem('roomPassword'))) === null,
            "creating a passwordless room must not inherit the previous room's password"
        );

        await leaveRoom(page);

        // Rejoin Room B (its session was deleted server-side when the last
        // peer left, so this exercises the lazy-recreate path) via the manual
        // join form, simulating a bookmark/direct link.
        await page.fill('#join-code', codeB);
        await page.click('#join-form button[type="submit"]');
        await sleep(1500);

        assert(
            page.url().endsWith('/' + codeB),
            `expected to land back in Room B without a password prompt, got ${page.url()}`
        );

        console.log('Room password did not leak across rooms.');
    } finally {
        server.kill();
        if (browser) await browser.close();
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
