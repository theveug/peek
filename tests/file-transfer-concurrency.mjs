// Verifies multiple files sent to the same peer in one batch (e.g. a caption +
// several staged attachments, or just two drops close together) don't corrupt
// each other in transit.
//
// Root cause this guards against: binary WebRTC data-channel messages carry no
// fileId of their own — the receive side (PeerManager.handleDataChannelMessage's
// binary branch) demuxes an incoming chunk to a transfer purely by matching
// `incomingTransfers[id].from === peerId`, assuming only one file is ever in
// flight per sender at a time. Once a caption+files send made concurrent
// multi-file transfers to the same peer commonplace, two accepted files' chunk
// loops interleaving on the same connection got demuxed into the wrong transfer,
// corrupting both and often tripping the declared-size guard — exactly what
// this test asserts against, with a real byte-for-byte comparison of what
// actually arrives, not just "did something arrive."
//
// Run with: npm run test:file-transfer-concurrency

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs/promises';

const PORT = process.env.TEST_PORT || 3116;
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

function assert(condition, message) {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// Distinguishable, non-trivial-size buffers so cross-contamination between
// concurrently in-flight chunk streams shows up as a size or content mismatch,
// not just a missing file.
function makeBuf(sizeKB, marker) {
    const buf = Buffer.alloc(sizeKB * 1024, marker.charCodeAt(0));
    buf.write(marker, 0);
    return buf;
}

const files = [
    { name: 'alpha.log', mimeType: 'text/plain', buffer: makeBuf(80, 'AAAA') },
    { name: 'bravo.log', mimeType: 'text/plain', buffer: makeBuf(65, 'BBBB') },
    { name: 'charlie.log', mimeType: 'text/plain', buffer: makeBuf(120, 'CCCC') },
    { name: 'delta.log', mimeType: 'text/plain', buffer: makeBuf(50, 'DDDD') },
];

async function main() {
    const server = await startServer();
    let browser;
    try {
        browser = await chromium.launch();
        const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
        const pageA = await ctxA.newPage();
        const resp = await pageA.request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: 6 } });
        const { code } = await resp.json();
        await pageA.goto(`${BASE_URL}/${code}`);

        const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        const consoleErrorsB = [];
        pageB.on('console', (msg) => { if (msg.type() === 'error') consoleErrorsB.push(msg.text()); });
        pageB.on('pageerror', (err) => consoleErrorsB.push(String(err)));
        await pageB.goto(`${BASE_URL}/${code}`);
        await pageA.waitForTimeout(2000);

        // Auto-accept on B so all 4 files' transfers actually race each other
        // instead of waiting on manual clicks.
        await pageB.click('#topbar-identity');
        await pageB.click('#topbar-identity-settings');
        await pageB.click('[data-settings-section="privacy"]');
        await pageB.check('#settings-auto-accept-files');
        await pageB.click('#close-settings');
        await pageB.waitForTimeout(300);

        await pageA.setInputFiles('#file-input', files);
        await pageA.fill('#message', 'lots of images');
        await pageA.press('#message', 'Enter');

        await pageB.waitForFunction(
            () => document.querySelectorAll('#chat-log .file-card, #chat-log .chat-image-preview').length >= 4,
            { timeout: 20_000 }
        );

        const blockedCount = await pageB.locator('.chat-system-message', { hasText: 'exceeded declared size' }).count();
        assert(blockedCount === 0, `no file should be falsely blocked for exceeding declared size, found ${blockedCount}`);

        // Byte-for-byte integrity via an actual download click — fetch()-ing the
        // blob: URL from inside the page is blocked by the app's own strict
        // connect-src CSP (a good sign, not a bug to work around differently).
        for (const f of files) {
            const card = pageB.locator('.file-card', { hasText: f.name });
            const [download] = await Promise.all([
                pageB.waitForEvent('download'),
                card.locator('a.file-card-download').click(),
            ]);
            const receivedBuf = await fs.readFile(await download.path());
            assert(receivedBuf.length === f.buffer.length, `${f.name}: size mismatch, expected ${f.buffer.length}, got ${receivedBuf.length}`);
            assert(receivedBuf.equals(f.buffer), `${f.name}: byte content does not match original (cross-contamination from another concurrent transfer)`);
        }

        assert(consoleErrorsB.length === 0, `receiver had console errors: ${consoleErrorsB.join('; ')}`);

        console.log('All file-transfer concurrency checks passed.');
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
