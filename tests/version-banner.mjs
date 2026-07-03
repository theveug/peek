// Verifies the "new version available" banner: the server stamps a fresh buildId
// (based on process start time) into every 'init' message. A client that reconnects
// after the server restarts (i.e. a deploy) should see the buildId change and show
// the banner; a client that hasn't reconnected should never see it.
//
// Run with: npm run test:version-banner

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3104;
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

async function main() {
    let server = await startServer();
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await context.newPage();

        const resp = await page.request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: 6 } });
        const { code } = await resp.json();
        await page.goto(`${BASE_URL}/${code}`);
        await page.waitForSelector('#chat', { state: 'attached' });

        assert(!(await page.isVisible('#update-banner')), 'banner should be hidden right after connecting');

        // Simulate a deploy: restart the server process on the same port so it stamps
        // a new buildId, then let the client's existing auto-reconnect pick it up.
        server.kill();
        await sleep(500);
        server = await startServer();
        await page.waitForSelector('#update-banner:not(.hidden)', { timeout: 8000 });

        assert(await page.isVisible('#update-refresh-btn'), 'refresh button should be visible in the banner');

        await page.click('#update-dismiss-btn');
        assert(!(await page.isVisible('#update-banner')), 'banner should hide after dismiss');

        console.log('All version-banner checks passed.');
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
