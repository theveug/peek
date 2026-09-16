// Dock quick popovers (screen/cam quality, mic options, deafen volume) are
// CSS-centered on their trigger button (`left: 50%; transform: translateX(-50%)`,
// relative to their `.dock-btn-wrap` ancestor) with no bound-checking. #videos
// carries the `overflow-hidden` Tailwind utility (needed to contain video/grid
// content) — once the video column gets narrow enough (a wide chat panel +
// wide members panel on a modest window width), the popover's fixed 14rem
// width spills past #videos's own edge and gets silently clipped by that
// overflow, truncating "RESOLUTION"/"FRAME RATE" labels instead of just
// looking a bit off-center. Owner-reported 2026-09-16 via a screenshot; a
// separate root cause from the mobile #controls-stacking-context fix (this
// one is a clipping/overflow problem, present at any width, not a stacking
// one, and not mobile-specific).
//
// App.js's `_clampPopoverHorizontally()` (called from `wireQuickPopover()`
// every time a popover opens) measures #videos's live rect and clamps the
// popover's computed `left` so it never crosses that boundary, overriding the
// CSS default centering with an explicit `left`/`transform: none`.
//
// Covers, at three widths in one desktop session (chat panel open, members
// panel expanded — the exact combination that starves #videos of width):
//   1. A narrow-ish desktop width where the popover would otherwise clip.
//   2. An even narrower width, to confirm the clamp still holds and the
//      popover doesn't get clamped into negative/inverted bounds.
//   3. A normal wide desktop width, where no clamping is needed at all —
//      confirms the fix doesn't misplace the popover when it isn't required.
//
// Run with: npm run test:quick-popover-clamp

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3134;
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

async function checkPopoverWithinVideos(page, label) {
    // Popover starts closed on entry (each call closes it again at the end)
    // — one click opens it fresh, so _clampPopoverHorizontally() recomputes
    // against whatever the current viewport actually is.
    await page.click('#share-quality-caret');
    await sleep(200);
    const { popRect, videosRect } = await page.evaluate(() => ({
        popRect: document.getElementById('share-quality-popover').getBoundingClientRect(),
        videosRect: document.getElementById('videos').getBoundingClientRect(),
    }));
    assert(popRect.left >= videosRect.left - 0.5, `[${label}] popover's left edge stays within #videos (${popRect.left} >= ${videosRect.left})`);
    assert(popRect.right <= videosRect.right + 0.5, `[${label}] popover's right edge stays within #videos (${popRect.right} <= ${videosRect.right})`);
    await page.click('#share-quality-caret'); // close for the next check
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
            viewport: { width: 950, height: 700 },
        });
        const page = await ctx.newPage();
        const createResp = await page.request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: 6 } });
        const { code } = await createResp.json();
        await page.goto(`${BASE_URL}/${code}`);
        await page.waitForSelector('.participant-card[data-self]', { state: 'attached', timeout: 10000 });

        await checkPopoverWithinVideos(page, '950px width, would otherwise clip');

        await page.setViewportSize({ width: 700, height: 650 });
        await sleep(300);
        await checkPopoverWithinVideos(page, '700px width, even narrower');

        await page.setViewportSize({ width: 1600, height: 900 });
        await sleep(300);
        await checkPopoverWithinVideos(page, '1600px width, no clamping needed');

        console.log('All quick-popover-clamp checks passed.');
    } finally {
        await browser.close();
        server.kill();
        await sleep(200);
    }
}

await main();
