// Chat auto-scroll regression test.
//
// Root cause this guards: chatAutoScroll.js's isAtBottom() uses a small fixed
// threshold to forgive the gap between "was the user at the bottom before
// this message" and "is the log's scrollHeight now, after the message was
// already appended". That threshold only covers a single short line's worth
// of height — it used to be checked *after* the new message's DOM was
// already inserted, so anything taller (several rapid messages that group
// into one headerless block, or a single message containing a multi-line
// fenced code block) pushed scrollHeight up by more than the threshold could
// absorb, and the check silently read as "user scrolled away", skipping the
// auto-scroll even though the user was genuinely at the bottom. Fixed by
// capturing "was at bottom" in each ChatUI.js render method *before* it
// mutates the DOM, not after (see CLAUDE.md's autoscroll entry).
//
// Run with: npm run test:chat-autoscroll

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 3145;
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

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

async function sendChat(page, text) {
    await page.fill('#message', text);
    await page.press('#message', 'Enter');
}

async function scrollState(page) {
    return page.evaluate(() => {
        const el = document.getElementById('chat-log');
        return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
    });
}

function isAtBottom({ scrollTop, clientHeight, scrollHeight }) {
    // Generous epsilon vs. the app's own threshold — this test only cares
    // whether the log genuinely settled at its bottom, not the exact fudge
    // factor chatAutoScroll.js uses internally.
    return scrollTop + clientHeight >= scrollHeight - 5;
}

async function main() {
    const server = await startServer();
    const browser = await chromium.launch({
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    const consoleErrors = [];
    try {
        // A small viewport keeps #chat-log's visible height modest, so a
        // handful of messages reliably overflow it without needing hundreds
        // of sends.
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 500, height: 500 } });
        const page = await ctx.newPage();
        page.on('pageerror', (err) => consoleErrors.push(String(err)));

        const resp = await page.request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: 6 } });
        const { code } = await resp.json();
        await page.goto(`${BASE_URL}/${code}`);
        await page.waitForSelector('#message', { state: 'visible' });

        // --- Prime the log so it's actually scrollable, and land at the bottom ---
        for (let i = 0; i < 12; i++) {
            await sendChat(page, `priming line ${i}`);
        }
        await sleep(800);
        let s = await scrollState(page);
        assert(s.scrollHeight > s.clientHeight, 'priming messages actually overflow the panel');
        assert(isAtBottom(s), 'log is pinned to bottom after priming messages');

        // --- Scenario 1: several rapid consecutive messages from the same
        // sender group into one headerless visual block, and the log still
        // ends up pinned to the bottom once they've all landed. ---
        for (let i = 0; i < 6; i++) {
            await sendChat(page, `consecutive line ${i}`);
        }
        await sleep(800);
        s = await scrollState(page);
        assert(isAtBottom(s), 'log auto-scrolls to bottom after a burst of rapid same-author messages');

        const groupedCount = await page.locator('.chat-message-grouped').count();
        assert(groupedCount >= 5, `consecutive messages actually grouped into one block (grouped rows: ${groupedCount})`);

        // --- Scenario 2: a message containing a multi-line fenced code
        // block — the exact case that used to get silently skipped. ---
        const codeBlock = '```js\nfunction hello() {\n  console.log("a");\n  console.log("b");\n  console.log("c");\n  console.log("d");\n  console.log("e");\n}\n```';
        await sendChat(page, 'here is some code:');
        await sendChat(page, codeBlock);
        await sleep(1000);
        s = await scrollState(page);
        assert(isAtBottom(s), 'log auto-scrolls to bottom after a message containing a fenced code block');
        assert((await page.locator('pre code.hljs').count()) >= 1, 'the code block actually rendered as a highlighted fence');

        // --- Scenario 3: reading history (scrolled up) must NOT be yanked
        // down by a new message — the flip side of the bug above. ---
        await page.evaluate(() => { document.getElementById('chat-log').scrollTop = 0; });
        await sleep(200);
        const scrolledUp = await scrollState(page);
        assert(!isAtBottom(scrolledUp), 'test setup: scrolled up away from the bottom');
        await sendChat(page, 'this should not yank the view back down');
        await sleep(800);
        const stillUp = await scrollState(page);
        assert(!isAtBottom(stillUp), 'a new message does not auto-scroll a user who scrolled up to read history');

        assert(consoleErrors.length === 0, `no page errors during run, got: ${JSON.stringify(consoleErrors)}`);
        console.log('All chat auto-scroll checks passed.');
    } finally {
        await browser.close();
        server.kill();
        await sleep(200);
    }
}

await main();
