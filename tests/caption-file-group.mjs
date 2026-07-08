// Verifies the caption+files merge (2026-07-09): a caption typed alongside one or
// more staged attachments renders as ONE chat bubble (one avatar/sender/timestamp
// header, the caption, then a file slot per attachment) instead of a separate text
// message immediately followed by standalone file messages. Each file still
// negotiates its own independent offer/accept/decline — this only checks the
// combined rendering, not the transfer mechanics already covered by
// tests/file-consent.mjs.
//
// Run with: npm run test:caption-file-group

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3112;
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

async function stageTwoFiles(page) {
    await page.setInputFiles('#file-input', [
        { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello from the sender') },
    ]);
}

async function main() {
    const server = await startServer();
    const browser = await chromium.launch();
    try {
        const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
        const pageA = await ctxA.newPage();
        const resp = await pageA.request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: 6 } });
        const { code } = await resp.json();
        await pageA.goto(`${BASE_URL}/${code}`);

        const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        await pageB.goto(`${BASE_URL}/${code}`);
        await pageA.waitForTimeout(2000);

        // --- Caption + 2 files: one bubble on both sides, not three messages ---
        await stageTwoFiles(pageA);
        await pageA.fill('#message', 'check these out');
        await pageA.press('#message', 'Enter');

        // Sender's own echo: one message container, one header, two file slots.
        await pageA.waitForSelector('.chat-file-slot', { timeout: 5000 });
        const senderContainers = await pageA.locator('#chat-log > div:has(.chat-file-group)').count();
        assert(senderContainers === 1, `sender should have exactly one grouped bubble, found ${senderContainers}`);
        const senderSlots = await pageA.locator('#chat-log > div:has(.chat-file-group) .chat-file-slot').count();
        assert(senderSlots === 2, `sender's bubble should have 2 file slots, found ${senderSlots}`);
        const senderCaptionCount = await pageA.locator('#chat-log > div:has(.chat-file-group) .chat-markdown', { hasText: 'check these out' }).count();
        assert(senderCaptionCount === 1, 'sender bubble should contain the caption text');
        console.log('SENDER - one bubble with caption + 2 file slots: PASS');

        // Receiver: one bubble with the caption and two pending offers before either is resolved.
        await pageB.waitForSelector('.file-offer', { timeout: 5000 });
        const receiverContainers = await pageB.locator('#chat-log > div:has(.chat-file-group)').count();
        assert(receiverContainers === 1, `receiver should have exactly one grouped bubble, found ${receiverContainers}`);
        const receiverCaptionCount = await pageB.locator('#chat-log > div:has(.chat-file-group) .chat-markdown', { hasText: 'check these out' }).count();
        assert(receiverCaptionCount === 1, 'receiver bubble should contain the caption text');
        const offerCount = await pageB.locator('.file-offer').count();
        assert(offerCount === 2, `receiver should see 2 pending file offers, found ${offerCount}`);
        console.log('RECEIVER - one bubble with caption + 2 pending offers: PASS');

        // Accept the first, decline the second — both resolve independently within the same bubble.
        const offers = pageB.locator('.file-offer');
        await offers.nth(0).locator('.file-offer-accept').click();
        await offers.nth(0).locator('.file-offer-decline').click(); // now targets the remaining (2nd) offer

        await pageB.waitForSelector('.file-card, .chat-image-preview', { timeout: 5000 });
        await pageB.waitForSelector('.file-offer-declined', { timeout: 5000 });
        const stillOneContainer = await pageB.locator('#chat-log > div:has(.chat-file-group)').count();
        assert(stillOneContainer === 1, 'accept/decline should not split the bubble into separate messages');
        const acceptedCards = await pageB.locator('#chat-log > div:has(.chat-file-group) .file-card, #chat-log > div:has(.chat-file-group) .chat-image-preview').count();
        assert(acceptedCards === 1, `exactly one file should have been delivered, found ${acceptedCards}`);
        console.log('RECEIVER - mixed accept/decline resolves in place within one bubble: PASS');

        // --- Files with no caption: still one bubble (header only, no caption text), not three ---
        await stageTwoFiles(pageA);
        await pageA.press('#message', 'Enter');
        await pageB.waitForSelector('.file-offer', { timeout: 5000 });
        const noCaptionContainers = await pageB.locator('#chat-log > div:has(.chat-file-group)').count();
        assert(noCaptionContainers === 2, `expected 2 total grouped bubbles by now (1 from the captioned send + 1 new), found ${noCaptionContainers}`);
        console.log('NO-CAPTION SEND - still grouped into one bubble: PASS');

        console.log('All caption+file-group checks passed.');
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
