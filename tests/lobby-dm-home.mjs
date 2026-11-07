// Lobby Friends & Messages "Home" view (2026-11-08, owner-reported: the
// lobby DM view was a narrow drawer, crammed to one side, with stray scroll
// bars). Browser test with two real accounts:
//   1. desktop: opening the panel shows the sidebar (Friends + DM list) and
//      the main pane side by side, full width beside the room rail,
//   2. clicking a DM row opens the thread in the main pane while the list
//      stays visible, with the row highlighted and the header showing the
//      friend's name,
//   3. the thread has no horizontal scroll bar, even with a very long word,
//   4. markdown renders on the lobby (vendor libs lazy-loaded) and the
//      Code block option exists,
//   5. sending from the composer adds the message to the thread,
//   6. phone width: list first, a row opens the thread full-screen, back
//      returns to the list.
//
// Run with: npm run test:lobby-dm-home
// Screenshots: set SHOT_DIR to a folder to save them.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const PORT = 3141;
const BASE = `https://localhost:${PORT}`;

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

function startServer(dbPath) {
    const proc = spawn(process.execPath, ['server.js'], {
        env: { ...process.env, PORT: String(PORT), DEBUG: '', NODE_ENV: 'test', ACCOUNTS_ENABLED: '1', ACCOUNTS_DB_PATH: dbPath },
        stdio: 'pipe',
    });
    return new Promise((resolve, reject) => {
        let out = '';
        proc.stdout.on('data', (c) => { out += c; if (out.includes('Server listening')) resolve(proc); });
        proc.on('error', reject);
        setTimeout(() => reject(new Error('server did not start within 10s')), 10_000);
    });
}

async function register(username) {
    const res = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'correct-horse-battery' }),
    });
    return res.headers.get('set-cookie').split(';')[0];
}

async function api(cookie, method, url, body) {
    const res = await fetch(`${BASE}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: body ? JSON.stringify(body) : undefined,
    });
    return res.json().catch(() => null);
}

async function main() {
    const dir = mkdtempSync(path.join(tmpdir(), 'peek-dm-home-'));
    const server = await startServer(path.join(dir, 'accounts.db'));
    let browser;
    try {
        const alice = await register('alice');
        const bob = await register('bob');
        await api(alice, 'POST', '/api/friends/request', { username: 'bob' });
        const { incoming } = await api(bob, 'GET', '/api/friends');
        await api(bob, 'POST', `/api/friends/${incoming[0].requestId}/accept`);
        await api(bob, 'POST', '/api/messages/alice', { body: 'hey, want to jump in a room later?' });
        await api(alice, 'POST', '/api/messages/bob', { body: 'yes! here is **bold** and `code`' });
        await api(bob, 'POST', '/api/messages/alice', { body: 'x'.repeat(300) });

        browser = await chromium.launch();
        const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
        const [name, value] = alice.split('=');
        await context.addCookies([{ name, value, url: BASE }]);
        const page = await context.newPage();
        await page.goto(BASE + '/');

        await page.locator('#social-button').waitFor({ state: 'visible' });
        await page.click('#social-button');
        await page.locator('.social-dm-row').first().waitFor();

        const sidebar = await page.locator('.social-home-sidebar').boundingBox();
        const main = await page.locator('.social-home-main').boundingBox();
        assert(sidebar && main && main.x >= sidebar.x + sidebar.width - 1, 'desktop: sidebar and main pane sit side by side');
        assert(main.x + main.width >= 1279, 'desktop: main pane reaches the right edge of the window');

        await page.locator('.social-dm-row', { hasText: 'bob' }).click();
        await page.locator('#messages-thread .chat-message').first().waitFor();
        assert(await page.locator('.social-dm-row', { hasText: 'bob' }).evaluate(el => el.classList.contains('active')), 'opened DM row is highlighted');
        assert(await page.locator('.social-home-sidebar').isVisible(), 'DM list stays visible while a thread is open');
        assert((await page.textContent('#messages-popover-title')).trim() === 'bob', 'header shows the friend name');

        const overflowX = await page.$eval('#messages-thread', el => el.scrollWidth - el.clientWidth);
        assert(overflowX <= 0, 'thread has no horizontal overflow even with a very long word');

        assert(await page.locator('#messages-thread strong', { hasText: 'bold' }).count() === 1, 'markdown renders in a lobby DM');
        assert(await page.locator('#messages-code-block-btn').count() === 1, 'Code block option is available on the lobby');

        if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, 'dm-desktop.png') });

        await page.fill('#messages-input', 'sent from the new view');
        await page.press('#messages-input', 'Enter');
        await page.locator('#messages-thread .chat-message', { hasText: 'sent from the new view' }).waitFor();
        assert(true, 'sending from the composer adds the message');

        await page.click('.social-home-nav-item[data-social-tab="friends"]');
        assert(await page.locator('[data-social-panel="friends"]').isVisible(), 'Friends nav item shows the friends pane');
        if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, 'friends-desktop.png') });

        // Phone width
        await page.setViewportSize({ width: 390, height: 780 });
        await page.keyboard.press('Escape');
        await page.click('#social-button');
        await page.locator('.social-home-sidebar').waitFor({ state: 'visible' });
        assert(!(await page.locator('.social-home-main').isVisible()), 'phone: opens on the list, main pane hidden');
        await page.locator('.social-dm-row', { hasText: 'bob' }).click();
        await page.locator('#messages-thread .chat-message').first().waitFor();
        assert(!(await page.locator('.social-home-sidebar').isVisible()), 'phone: opening a DM shows the thread full-screen');
        if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, 'dm-phone.png') });
        await page.click('#messages-back-btn');
        assert(await page.locator('.social-home-sidebar').isVisible(), 'phone: back returns to the list');

        console.log('\nAll lobby DM Home view checks passed.');
    } finally {
        await browser?.close();
        server.kill();
        await new Promise(r => setTimeout(r, 300));
        rmSync(dir, { recursive: true, force: true });
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
