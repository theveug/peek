// Verifies PeerManager._qualityTier()'s room-size-based resolution/fps caps
// actually take effect on a live cam stream, and restore once the room shrinks
// back down.
//
// _qualityTier() keys entirely off Object.keys(this.peers).length — the number
// of negotiated RTCPeerConnections — not who's actually streaming (see
// createPeerConnection() in PeerManager.js, which registers `this.peers[id]`
// for every joined peer regardless of whether they ever send media). So this
// doesn't need N tabs each running a real screen/cam capture: one "observer"
// tab holds a real (fake-device) webcam stream, and every other tab just joins
// the room with no media at all. That's why this can run as a single
// automated, headless pass instead of the "7+ tabs each streaming, watched by
// hand" version originally scoped in TODO.md.
//
// Chromium's fake video device defaults to 640x480@20fps and only reports a
// different format when a constraint actually forces it lower (it does not
// upscale toward an unconstrained "max"). That means the 7-8 peer tier
// (1280x720/24fps cap) is never observably different from uncapped with this
// device — both tiers land on the same 640x480@20fps default — so this test
// only asserts at the two tiers whose caps fall below that default (9-10
// peers: frameRate; 11-12 peers: resolution), plus the restore-on-leave case.
// It still logs every transition so a human can eyeball the 7-8 tier too.
//
// Run with: npm run test:quality-tiers

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3111;
const BASE_URL = `https://localhost:${PORT}`;
const MAX_PEERS = 12;

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
    const resp = await page.request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: MAX_PEERS } });
    const { code } = await resp.json();
    return code;
}

function assert(condition, message) {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function getCamSettings(page) {
    return page.evaluate(() => {
        const video = document.getElementById('self-cam-view');
        const track = video?.srcObject?.getVideoTracks?.()[0];
        return track ? track.getSettings() : null;
    });
}

async function waitForPeerCardCount(page, count) {
    await page.waitForFunction(
        (n) => document.querySelectorAll('[id^="participant-"]').length >= n,
        count,
        { timeout: 10_000 }
    );
}

// Polls getCamSettings() until `predicate` passes or the timeout elapses,
// returning the last-seen settings either way so the caller can log/assert
// on it (rather than masking a real failure as a timeout with no context).
async function waitForCamSettings(page, predicate, timeoutMs = 5000) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
        last = await getCamSettings(page);
        if (last && predicate(last)) return last;
        await sleep(150);
    }
    return last;
}

async function main() {
    const server = await startServer();
    let browser;
    const fillers = [];
    try {
        browser = await chromium.launch({
            args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        });

        const observerCtx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
        // Records every applyConstraints() call/result so a failed assertion below
        // can dump exactly what PeerManager actually requested, instead of just
        // "wrong value" with no way to tell whether the call happened at all.
        await observerCtx.addInitScript(() => {
            window.__acLog = [];
            const orig = MediaStreamTrack.prototype.applyConstraints;
            MediaStreamTrack.prototype.applyConstraints = function (constraints) {
                const entry = { constraints, kind: this.kind, t: Date.now() };
                window.__acLog.push(entry);
                return orig.call(this, constraints).then(
                    () => { entry.ok = true; },
                    (err) => { entry.ok = false; entry.err = String(err); throw err; }
                );
            };
        });
        const observer = await observerCtx.newPage();
        const observerErrors = [];
        observer.on('console', (msg) => { if (msg.type() === 'error') observerErrors.push(msg.text()); });
        observer.on('pageerror', (err) => observerErrors.push(String(err)));

        const code = await createRoom(observer);
        await observer.goto(`${BASE_URL}/${code}`);
        await observer.waitForSelector('#chat', { state: 'attached' });

        await observer.hover('#videos');
        await observer.click('#cam-toggle');
        await observer.waitForSelector('#self-cam-view', { state: 'visible', timeout: 5000 });

        let settings = await getCamSettings(observer);
        assert(settings, 'observer should have a live cam track after enabling the camera');
        console.log(`peers=1  settings=${JSON.stringify(settings)}  (baseline, uncapped)`);
        assert(settings.height <= 480, 'baseline should be at or below the fake device default of 640x480');

        for (let i = 2; i <= MAX_PEERS; i++) {
            const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
            const page = await ctx.newPage();
            await page.goto(`${BASE_URL}/${code}`);
            await page.waitForSelector('#chat', { state: 'attached' });
            fillers.push({ ctx, page });

            // +1 because the observer's own self-card also matches [id^="participant-"].
            await waitForPeerCardCount(observer, i);

            if (i <= 8) {
                // Uncapped or 7-8 tier (1280x720/24fps) — both indistinguishable
                // from the fake device's own 640x480@20fps default. Log only.
                settings = await getCamSettings(observer);
                console.log(`peers=${i}  settings=${JSON.stringify(settings)}  (no observable cap expected yet)`);
            } else if (i <= 10) {
                // 9-10 tier: camFps caps to 15, below the device's 20fps default.
                settings = await waitForCamSettings(observer, (s) => s.frameRate <= 15, 8000);
                console.log(`peers=${i}  settings=${JSON.stringify(settings)}  (expect frameRate<=15)`);
                if (!settings || settings.frameRate > 15) {
                    console.log(`  applyConstraints log: ${JSON.stringify(await observer.evaluate(() => window.__acLog), null, 2)}`);
                }
                assert(settings && settings.frameRate <= 15, `peers=${i}: frameRate ${settings?.frameRate} should be capped to <=15`);
            } else {
                // 11-12 tier: camRes caps to 640x360, below the device's 480 default.
                settings = await waitForCamSettings(observer, (s) => s.height <= 360, 8000);
                console.log(`peers=${i}  settings=${JSON.stringify(settings)}  (expect height<=360, frameRate<=15)`);
                if (!settings || settings.height > 360) {
                    console.log(`  applyConstraints log: ${JSON.stringify(await observer.evaluate(() => window.__acLog), null, 2)}`);
                }
                assert(settings && settings.height <= 360, `peers=${i}: height ${settings?.height} should be capped to <=360`);
                assert(settings && settings.frameRate <= 15, `peers=${i}: frameRate ${settings?.frameRate} should stay capped to <=15`);
            }
        }

        // Release fillers one at a time and confirm the cap relaxes back down.
        while (fillers.length > 0) {
            const { ctx } = fillers.pop();
            await ctx.close();
            await waitForPeerCardCount(observer, fillers.length + 1);
        }

        settings = await waitForCamSettings(observer, (s) => s.height > 360, 8000);
        console.log(`peers=1  settings=${JSON.stringify(settings)}  (after all left, expect restored to uncapped)`);
        if (!settings || settings.height <= 360) {
            console.log(`  applyConstraints log: ${JSON.stringify(await observer.evaluate(() => window.__acLog), null, 2)}`);
        }
        assert(settings && settings.height > 360, 'quality should restore to uncapped once the room shrinks back to <=6');

        assert(observerErrors.length === 0, `observer had console errors: ${observerErrors.join('; ')}`);

        console.log('All quality-tier checks passed.');
    } finally {
        for (const { ctx } of fillers) await ctx.close().catch(() => {});
        if (browser) await browser.close();
        server.kill();
        await sleep(200);
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
