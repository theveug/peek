// Verifies Peek runs with zero external network dependencies (disconnected-LAN
// capability) and that the self-hosted vendor libs actually work end-to-end.
// Every request to a non-localhost host is BLOCKED (simulating no internet) and
// recorded as a failure. Also asserts the strict CSP header is present and that
// no CSP violations fire while driving the pages.
//
// This is the regression guard for the 2026-07-07 CDN-removal work — if anyone
// reintroduces a CDN <script>, a Google STUN hardcode, or any other external
// fetch, this test fails.
//
// Run with: npm run test:offline

// Load .env the same way the spawned server does, so the ICE assertion below
// knows which STUN/TURN entries are legitimately configured vs. hardcoded.
import 'dotenv/config';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = process.env.TEST_PORT || 3101;
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

async function main() {
    const server = await startServer();
    let browser;
    try {
        browser = await chromium.launch({
            args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        });
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            permissions: ['camera', 'microphone'],
        });

        // Simulate a disconnected LAN: anything not aimed at localhost is
        // blocked, and remembered so we can fail loudly at the end.
        const externalRequests = [];
        await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
                return route.continue();
            }
            externalRequests.push(route.request().url());
            return route.abort('internetdisconnected');
        });

        const page = await context.newPage();
        const cspViolations = [];
        const pageErrors = [];
        page.on('console', (msg) => {
            if (msg.text().includes('Content Security Policy')) cspViolations.push(msg.text());
        });
        page.on('pageerror', (err) => pageErrors.push(String(err)));

        // --- Lobby loads and is interactive with no internet ---
        const lobbyResp = await page.goto(`${BASE_URL}/`);
        const csp = lobbyResp.headers()['content-security-policy'] || '';
        assert(csp.includes("script-src 'self'"), `CSP header with script-src 'self' should be set (got: ${csp || 'none'})`);
        assert(await page.isVisible('#create-form'), 'lobby create form should render offline');

        // --- Room page: full vendor chain works from local files ---
        const resp = await page.request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: 6 } });
        const { code } = await resp.json();
        await page.goto(`${BASE_URL}/${code}`);
        await page.waitForSelector('#chat', { state: 'attached' });

        const libs = await page.evaluate(() => ({
            marked: typeof marked !== 'undefined',
            dompurify: typeof DOMPurify !== 'undefined',
            jszip: typeof JSZip !== 'undefined',
            hljs: typeof hljs !== 'undefined',
        }));
        for (const [name, loaded] of Object.entries(libs)) {
            assert(loaded, `${name} should load from the self-hosted vendor bundle`);
        }

        // Send a markdown message with a code block — exercises marked.parse,
        // DOMPurify.sanitize, and hljs.highlightElement together.
        await page.fill('#message', '**bold** and:\n```js\nconst x = 1;\n```');
        await page.press('#message', 'Enter');
        await page.waitForSelector('#chat-log .chat-markdown strong');
        assert(
            (await page.textContent('#chat-log .chat-markdown strong')) === 'bold',
            'markdown bold should render through marked + DOMPurify'
        );
        await page.waitForSelector('#chat-log .chat-markdown pre code.hljs');
        assert(
            (await page.$$eval('#chat-log .chat-markdown pre code.hljs span', (els) => els.length)) > 0,
            'code block should be syntax-highlighted by self-hosted hljs'
        );

        // --- ICE config contains no third-party servers by default ---
        // Read straight from the server's 'init' payload via a raw WS client
        // (the in-page PeerManager instance isn't exposed on window).
        const iceServers = await new Promise((resolve, reject) => {
            const wsClient = new WebSocket(`wss://localhost:${PORT}`, { rejectUnauthorized: false });
            const timer = setTimeout(() => { wsClient.close(); reject(new Error('init not received within 5s')); }, 5000);
            wsClient.on('open', () => wsClient.send(JSON.stringify({ type: 'join', sessionId: code })));
            wsClient.on('message', (data) => {
                const msg = JSON.parse(data);
                if (msg.type === 'init') {
                    clearTimeout(timer);
                    wsClient.close();
                    resolve(msg.iceServers);
                }
            });
            wsClient.on('error', (err) => { clearTimeout(timer); reject(err); });
        });
        assert(Array.isArray(iceServers), 'init should carry an iceServers array');
        // Entries deliberately configured via env (STUN_URL / TURN_URL) are fine;
        // anything else is a hardcoded third-party server sneaking back in.
        const allowedIce = [process.env.STUN_URL, process.env.TURN_URL].filter(Boolean);
        const iceUrls = iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
        const unexpectedIce = iceUrls.filter((u) => !allowedIce.some((a) => u.startsWith(a)));
        assert(
            unexpectedIce.length === 0,
            `iceServers must only contain env-configured entries — no hardcoded defaults (got: ${unexpectedIce.join(', ')})`
        );

        // --- The verdicts ---
        assert(
            externalRequests.length === 0,
            `no request should leave localhost, but saw:\n  ${externalRequests.join('\n  ')}`
        );
        assert(cspViolations.length === 0, `no CSP violations, but saw:\n  ${cspViolations.join('\n  ')}`);
        assert(pageErrors.length === 0, `no page errors, but saw:\n  ${pageErrors.join('\n  ')}`);

        console.log('All offline/self-host checks passed — zero external requests, CSP clean, vendor chain works.');
    } finally {
        if (browser) await browser.close();
        server.kill();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
