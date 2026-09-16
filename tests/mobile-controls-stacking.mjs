// The bottom controls dock (mic/cam/share/deafen) is a DOM descendant of
// #videos, which carries its own `z-index: 61` (needed so .panel-tab can
// out-stack #videos's other children — see that rule's own comment in
// tailwind.css). Since #videos is position:relative with a non-auto
// z-index, it establishes a stacking context — and a position:fixed
// descendant's z-index is only ever compared against siblings *within* its
// nearest ancestor stacking context, never against elements outside it,
// regardless of how high that descendant's own z-index is set. On mobile,
// #controls becomes position:fixed with z-index:90 (tailwind.css's
// `@media (max-width: 767px)` block), but stayed trapped inside #videos's
// z-index:61 context — so the mobile chat/members drawers (true top-level
// siblings of #videos, z-index:80) always painted over it, swallowing
// clicks on the dock's own buttons and hiding its quick popovers (mic
// options, screen/cam quality) behind an open side panel.
//
// Fix: App.js's updateControlsRelocation() reparents #controls to be a
// direct child of `.room-shell` (a true sibling of #videos, escaping its
// stacking context) whenever the viewport is mobile-width — reusing the
// exact mechanism the desktop "hide the stage" toggle already relies on
// (relocateControlsForStage()), since #controls' own layout CSS doesn't
// depend on which of the two it's nested under. Covers:
//   1. Loading directly at mobile width: #controls escapes #videos, and a
//      dock button (and its popover) are reachable/visible with a side
//      panel open — not the actual repro from a z-index bump alone, since
//      the trap is structural, not a numeric ordering problem.
//   2. Resizing mobile -> desktop: #controls moves back inside #videos.
//   3. Resizing back to mobile: relocates out again.
//   4. Desktop stage-hide toggle (relocateControlsForStage's original
//      purpose) still works — updateControlsRelocation() is a pure
//      superset of the old direct call on desktop (isMobile() is false
//      there), so this should be an unaffected no-op refactor.
//
// Run with: npm run test:mobile-controls-stacking

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3132;
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

async function controlsInsideVideos(page) {
    return page.evaluate(() => {
        const controls = document.getElementById('controls');
        const videos = document.getElementById('videos');
        return !!(controls && videos && videos.contains(controls));
    });
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
            viewport: { width: 375, height: 700 },
        });
        const page = await ctx.newPage();
        const createResp = await page.request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: 6 } });
        const { code } = await createResp.json();
        await page.goto(`${BASE_URL}/${code}`);
        await page.waitForSelector('.participant-card[data-self]', { state: 'attached', timeout: 10000 });

        // --- Step 1: mobile from initial load ---
        assert(!(await controlsInsideVideos(page)), '#controls is relocated out of #videos on a fresh mobile-width load');
        const controlsPosition = await page.evaluate(() => getComputedStyle(document.getElementById('controls')).position);
        assert(controlsPosition === 'fixed', '#controls is position:fixed at mobile width');

        await page.click('.members-tab');
        await sleep(400);
        await page.click('#mic-options-caret');
        await sleep(300);
        const elAtPopoverCenter = await page.evaluate(() => {
            const pop = document.getElementById('mic-options-popover');
            const r = pop.getBoundingClientRect();
            const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return el ? (el.id || el.className) : null;
        });
        assert(elAtPopoverCenter !== 'participants', 'the mic-options popover is not buried under the open members drawer');
        console.log('STEP 1 - mobile load: #controls escapes #videos, its popover renders above an open drawer: PASS');

        // Close the popover/drawer before resizing, so the next steps start
        // clean. Re-clicking .members-tab won't do it — once the drawer is
        // open it occupies that same screen edge, same reason the popover
        // itself needed this fix in the first place; the backdrop is the
        // real close affordance while a mobile drawer is open.
        await page.click('#mic-options-caret');
        await page.evaluate(() => document.getElementById('mobile-backdrop')?.click());
        await sleep(300);

        // --- Step 2: resize to desktop ---
        await page.setViewportSize({ width: 1280, height: 800 });
        await sleep(300);
        assert(await controlsInsideVideos(page), 'resizing to desktop moves #controls back inside #videos');
        const desktopPosition = await page.evaluate(() => getComputedStyle(document.getElementById('controls')).position);
        assert(desktopPosition !== 'fixed', '#controls is no longer position:fixed at desktop width');
        console.log('STEP 2 - resize to desktop: #controls relocates back into #videos: PASS');

        // --- Step 3: resize back to mobile ---
        await page.setViewportSize({ width: 375, height: 700 });
        await sleep(300);
        assert(!(await controlsInsideVideos(page)), 'resizing back to mobile relocates #controls out of #videos again');
        console.log('STEP 3 - resize back to mobile: #controls relocates out again: PASS');

        // --- Step 4: desktop stage-hide toggle still works (unaffected refactor) ---
        await page.setViewportSize({ width: 1280, height: 800 });
        await sleep(300);
        await page.evaluate(() => document.getElementById('stage-close-btn')?.click());
        await sleep(300);
        assert(await page.evaluate(() => document.body.classList.contains('stage-hidden')), 'stage-close-btn still hides the stage on desktop');
        assert(!(await controlsInsideVideos(page)), 'hiding the stage still relocates #controls to .room-shell on desktop');
        await page.evaluate(() => document.getElementById('toggle-stage-tab')?.click());
        await sleep(300);
        assert(!(await page.evaluate(() => document.body.classList.contains('stage-hidden'))), 'toggle-stage-tab restores the stage');
        assert(await controlsInsideVideos(page), 'restoring the stage moves #controls back inside #videos on desktop');
        console.log('STEP 4 - desktop stage-hide toggle (relocateControlsForStage) still works: PASS');

        console.log('All mobile-controls-stacking checks passed.');
    } finally {
        await browser.close();
        server.kill();
        await sleep(200);
    }
}

await main();
