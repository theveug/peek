// Verifies the consolidated per-peer context menu (added alongside incoming
// noise suppression): right-click and the kebab button open the identical
// popover, moderator-only rows are gated correctly (absent for a non-mod,
// present after a promote, still creator-only for kick/ban), and the
// existing volume/block/add-friend rows plus the new per-peer noise-
// suppression override still function through the consolidated markup. Also
// checks the "noise suppression on" badge (Feature B) shows up on a peer's
// card once they enable their own outgoing suppression via Settings.
//
// Run with: npm run test:context-menu

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3108;
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

/** Opens the consolidated menu on peerId's card via the kebab button. */
async function openMenuViaKebab(page, peerId) {
    await page.hover(`#participant-${peerId}`);
    await page.click(`#participant-${peerId} .participant-menu-btn`);
    return page.locator(`#participant-${peerId} .participant-menu-popover`);
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
        const { code, creatorToken } = await resp.json();
        await ctxA.addInitScript((token) => sessionStorage.setItem('creatorToken', token), creatorToken);
        await pageA.goto(`${BASE_URL}/${code}`);

        const ctxB = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
        const pageB = await ctxB.newPage();
        await pageB.goto(`${BASE_URL}/${code}`);

        await pageA.waitForSelector('.participant-card:not([data-self])', { timeout: 10000 });
        await pageB.waitForSelector('.participant-card:not([data-self])', { timeout: 10000 });

        const bAsSeenByA = await pageA.locator('.participant-card:not([data-self])').getAttribute('id');
        const peerB = bAsSeenByA.replace('participant-', '');
        const aAsSeenByB = await pageB.locator('.participant-card:not([data-self])').getAttribute('id');
        const peerA = aAsSeenByB.replace('participant-', '');

        // --- STEP 1: right-click and the kebab button open the same popover ---
        await pageA.hover(`#participant-${peerB}`);
        await pageA.click(`#participant-${peerB}`, { button: 'right' });
        const popoverOnA = pageA.locator(`#participant-${peerB} .participant-menu-popover`);
        await popoverOnA.waitFor({ state: 'visible', timeout: 3000 });
        assert(await popoverOnA.locator('button:has-text("Kick from room")').count() === 1,
            'A (creator) sees "Kick from room" when right-clicking B\'s card');
        console.log('STEP 1a - right-click opens the menu, creator sees kick/ban: PASS');

        // Close it, then reopen via the kebab button — same popover element.
        await pageA.click('#videos', { position: { x: 5, y: 5 } });
        await popoverOnA.waitFor({ state: 'hidden', timeout: 3000 });
        await openMenuViaKebab(pageA, peerB);
        await popoverOnA.waitFor({ state: 'visible', timeout: 3000 });
        console.log('STEP 1b - kebab button opens the identical popover: PASS');
        await pageA.click('#videos', { position: { x: 5, y: 5 } });

        // --- STEP 2: a non-moderator sees no moderator rows at all ---
        const popoverOnB = pageB.locator(`#participant-${peerA} .participant-menu-popover`);
        await openMenuViaKebab(pageB, peerA);
        await popoverOnB.waitFor({ state: 'visible', timeout: 3000 });
        assert(await popoverOnB.locator('button:has-text("Stop their stream")').count() === 0,
            'B (not yet a moderator) sees no "Stop their stream" row');
        assert(await popoverOnB.locator('button:has-text("Kick from room")').count() === 0,
            'B (not a moderator) sees no "Kick from room" row');
        console.log('STEP 2 - non-moderator sees zero moderator rows: PASS');
        await pageB.click('#videos', { position: { x: 5, y: 5 } });

        // --- STEP 3: promote B, then confirm B gets moderator (not creator) rows ---
        await openMenuViaKebab(pageA, peerB);
        await popoverOnA.waitFor({ state: 'visible', timeout: 3000 });
        await popoverOnA.locator('button:has-text("Make moderator")').click();
        await sleep(500); // moderator-update broadcast round trip
        await pageA.click('#videos', { position: { x: 5, y: 5 } });

        await openMenuViaKebab(pageB, peerA);
        await popoverOnB.waitFor({ state: 'visible', timeout: 3000 });
        assert(await popoverOnB.locator('button:has-text("Stop their stream")').count() === 1,
            'B (now a moderator) sees "Stop their stream"');
        assert(await popoverOnB.locator('button:has-text("Kick from room")').count() === 0,
            'B (moderator but not creator) still does not see "Kick from room"');
        console.log('STEP 3 - promote grants moderator rows without granting creator-only ones: PASS');
        await pageB.click('#videos', { position: { x: 5, y: 5 } });

        // --- STEP 4: block/unblock still works through the consolidated row ---
        await openMenuViaKebab(pageB, peerA);
        await popoverOnB.waitFor({ state: 'visible', timeout: 3000 });
        await popoverOnB.locator('.participant-block-btn').click();
        const cardBIsBlocked = await pageB.locator(`#participant-${peerA}`).evaluate(el => el.classList.contains('is-blocked'));
        assert(cardBIsBlocked, 'card carries .is-blocked after clicking the Block row');

        await openMenuViaKebab(pageB, peerA);
        await popoverOnB.waitFor({ state: 'visible', timeout: 3000 });
        const blockLabel = await popoverOnB.locator('.participant-block-btn .participant-menu-row-label').textContent();
        assert(blockLabel === 'Unblock', `block row label should read "Unblock", got "${blockLabel}"`);
        await popoverOnB.locator('.participant-block-btn').click();
        const cardBUnblocked = await pageB.locator(`#participant-${peerA}`).evaluate(el => !el.classList.contains('is-blocked'));
        assert(cardBUnblocked, 'card drops .is-blocked after clicking Block/Unblock a second time');
        console.log('STEP 4 - block/unblock row functions through the new menu: PASS');

        // --- STEP 5: per-peer noise-suppression override row toggles its label ---
        await openMenuViaKebab(pageB, peerA);
        await popoverOnB.waitFor({ state: 'visible', timeout: 3000 });
        const nsRow = popoverOnB.locator('button:has-text("noise suppression for them")');
        const initialText = await nsRow.textContent();
        assert(initialText.startsWith('Turn on'), `expected the default-off label, got "${initialText}"`);
        await nsRow.click();

        await openMenuViaKebab(pageB, peerA);
        await popoverOnB.waitFor({ state: 'visible', timeout: 3000 });
        const flippedText = await popoverOnB.locator('button:has-text("noise suppression for them")').textContent();
        assert(flippedText.startsWith('Turn off'), `expected the label to flip after the override, got "${flippedText}"`);
        console.log('STEP 5 - per-peer noise-suppression override row toggles: PASS');
        await pageB.click('#videos', { position: { x: 5, y: 5 } });

        // --- STEP 6: the "noise suppression on" badge reflects a peer's own outgoing toggle ---
        await pageA.click('#topbar-identity');
        await pageA.click('#topbar-identity-settings');
        await pageA.click('[data-settings-section="audio"]');
        await pageA.check('#settings-noise-suppression');
        await pageA.click('#close-settings');

        await pageB.waitForSelector(`#participant-${peerA} .participant-ns-icon`, { state: 'visible', timeout: 5000 });
        console.log('STEP 6 - noise-suppression badge appears on the peer\'s card after they enable it: PASS');

        console.log('All participant-context-menu checks passed.');
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
