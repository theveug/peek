// Verifies the file-transfer consent flow: by default an incoming file must be
// explicitly accepted or declined; a receiver who's turned on "auto-accept files"
// gets it without a prompt; a declined file is never actually streamed.
//
// Run with: npm run test:file-consent

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3105;
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

async function sendTestFile(page, name = 'note.txt') {
    await page.setInputFiles('#file-input', {
        name,
        mimeType: 'text/plain',
        buffer: Buffer.from('hello from the sender'),
    });
    await page.press('#message', 'Enter'); // flush the staged attachment (no caption)
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

        // --- Case 1: default — B must accept/decline, file isn't delivered until accepted ---
        await sendTestFile(pageA, 'default-flow.txt');
        await pageB.waitForSelector('.file-offer', { timeout: 5000 });
        const filesBeforeAccept = await pageB.locator('.file-card, .chat-image-preview').count();
        assert(filesBeforeAccept === 0, 'file should not be delivered before B accepts');

        await pageB.click('.file-offer-accept');
        await pageB.waitForSelector('.file-card, .chat-image-preview', { timeout: 5000 });
        console.log('CASE 1 - default flow requires accept, then delivers: PASS');

        // --- Case 2: decline — file never arrives ---
        await sendTestFile(pageA, 'declined.txt');
        await pageB.waitForSelector('.file-offer', { timeout: 5000 });
        await pageB.click('.file-offer-decline');
        await pageA.waitForTimeout(1500);
        const declinedFileCount = await pageB.locator('.file-card, .chat-image-preview', { hasText: 'declined.txt' }).count();
        assert(declinedFileCount === 0, 'declined file should never be delivered');
        console.log('CASE 2 - decline blocks delivery: PASS');

        // --- Case 3: auto-accept toggle — no prompt, file arrives directly ---
        await pageB.click('#settings-button');
        await pageB.check('#settings-auto-accept-files');
        await pageB.click('#settings-form button[type="submit"]');
        await pageB.waitForTimeout(300);

        await sendTestFile(pageA, 'auto-accepted.txt');
        await pageB.waitForSelector('.file-card, .chat-image-preview', { timeout: 5000 });
        const offerPromptShown = await pageB.isVisible('.file-offer');
        assert(!offerPromptShown, 'auto-accept should skip the offer prompt entirely');
        console.log('CASE 3 - auto-accept skips prompt and delivers: PASS');

        console.log('All file-consent checks passed.');
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
