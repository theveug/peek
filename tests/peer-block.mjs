// Verifies per-peer local block/mute: A shares their screen and chats, B blocks
// A and confirms the video tile + chat message stop arriving, then unblocks and
// confirms both resume without a reload. Also checks A sees no errors from being
// blocked (block is meant to be entirely invisible to the blocked peer).
//
// Run with: npm run test:peer-block

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3107;
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
}

async function sendChat(page, text) {
    await page.fill('#message', text);
    await page.press('#message', 'Enter');
}

async function main() {
    const server = await startServer();
    const browser = await chromium.launch({
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    const consoleErrorsA = [];
    try {
        const ctxA = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
        const pageA = await ctxA.newPage();
        pageA.on('console', (msg) => { if (msg.type() === 'error') consoleErrorsA.push(msg.text()); });
        pageA.on('pageerror', (err) => consoleErrorsA.push(String(err)));

        const resp = await pageA.request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: 6 } });
        const { code } = await resp.json();
        await pageA.goto(`${BASE_URL}/${code}`);

        const ctxB = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
        const pageB = await ctxB.newPage();
        await pageB.goto(`${BASE_URL}/${code}`);

        await pageA.waitForSelector('.participant-card:not([data-self])', { timeout: 10000 });
        await pageB.waitForSelector('.participant-card:not([data-self])', { timeout: 10000 });

        // A shares their screen (fake device auto-approves under the launch flags).
        await pageA.hover('#videos');
        await pageA.click('#share-toggle');
        await pageA.waitForSelector('#stop-share-button', { state: 'visible', timeout: 5000 });

        // B should see A's grid tile appear.
        const remoteCardId = await pageB.locator('.participant-card:not([data-self])').getAttribute('id');
        const remotePeerId = remoteCardId.replace('participant-', '');
        console.log('remote peerId (from B\'s view of A):', remotePeerId);

        await pageB.waitForSelector(`#grid-view [data-peer-id="${remotePeerId}"]`, { timeout: 8000 });
        console.log('STEP 1 - grid tile for A appears on B before block: PASS');

        // Baseline chat message before block should show up.
        await sendChat(pageA, 'hello before block');
        await pageB.waitForSelector('.chat-message:has-text("hello before block")', { timeout: 5000 });
        console.log('STEP 2 - pre-block chat message delivered: PASS');

        // --- Block ---
        // The action buttons are hover-revealed (.participant-actions), so the
        // card must be hovered before the block button is clickable.
        const blockBtn = pageB.locator(`#participant-${remotePeerId} .participant-block-btn`);
        await pageB.hover(`#participant-${remotePeerId}`);
        await blockBtn.click();

        // With only 2 participants, blocking the sole remote peer drops remoteStreams
        // to 0, so updateLayout() takes its "nobody visible yet" branch and hides the
        // whole #grid-view container (spinner shown instead) rather than rebuilding
        // the grid — the stale cell is left in the DOM but invisible until the next
        // buildGrid() call (on unblock). Assert invisibility, not DOM removal.
        await pageB.waitForSelector(`#grid-view [data-peer-id="${remotePeerId}"]`, { state: 'hidden', timeout: 5000 });
        console.log('STEP 3 - A\'s grid tile becomes invisible on B after block: PASS');

        const cardIsBlocked = await pageB.locator(`#participant-${remotePeerId}`).evaluate(el => el.classList.contains('is-blocked'));
        assert(cardIsBlocked, 'card should carry .is-blocked after blocking');
        const btnTitle = await blockBtn.getAttribute('title');
        assert(btnTitle === 'Unblock', `block button title should flip to Unblock, got "${btnTitle}"`);
        console.log('STEP 4 - card + button reflect blocked state: PASS');

        // Chat sent while blocked must not show up on B.
        await sendChat(pageA, 'hello during block');
        await pageA.waitForTimeout(1500);
        const duringBlockCount = await pageB.locator('.chat-message:has-text("hello during block")').count();
        assert(duringBlockCount === 0, 'chat sent while blocked should not appear on B');
        console.log('STEP 5 - chat suppressed while blocked: PASS');

        // Audio element (if present) should be forced to 0 while blocked.
        const audioVolume = await pageB.evaluate((pid) => {
            const el = document.getElementById(`audio-${pid}`);
            return el ? el.volume : null;
        }, remotePeerId);
        console.log('audio volume while blocked (null = no audio element yet):', audioVolume);
        if (audioVolume !== null) assert(audioVolume === 0, `blocked peer's audio.volume should be 0, got ${audioVolume}`);

        // --- Unblock ---
        await pageB.hover(`#participant-${remotePeerId}`);
        await blockBtn.click();
        await pageB.waitForSelector(`#grid-view [data-peer-id="${remotePeerId}"]`, { timeout: 8000 });
        console.log('STEP 6 - A\'s grid tile reappears on B after unblock (no reload): PASS');

        const cardUnblocked = await pageB.locator(`#participant-${remotePeerId}`).evaluate(el => !el.classList.contains('is-blocked'));
        assert(cardUnblocked, 'card should drop .is-blocked after unblocking');

        await sendChat(pageA, 'hello after unblock');
        await pageB.waitForSelector('.chat-message:has-text("hello after unblock")', { timeout: 5000 });
        console.log('STEP 7 - chat resumes after unblock: PASS');

        // 🔍 probe: double-block (click twice fast) shouldn't throw or desync state.
        await pageB.hover(`#participant-${remotePeerId}`);
        await blockBtn.click();
        await blockBtn.click();
        await pageB.waitForTimeout(500);
        const finalTitle = await blockBtn.getAttribute('title');
        console.log('🔍 rapid double-toggle final title:', finalTitle);

        console.log('consoleErrors on A (blocked-peer side) during entire run:', consoleErrorsA);
        assert(consoleErrorsA.length === 0, `A's console should show no errors from being blocked, got: ${JSON.stringify(consoleErrorsA)}`);

        console.log('All peer-block checks passed.');
    } finally {
        await browser.close();
        server.kill();
        await sleep(200);
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
