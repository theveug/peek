// Local chat-history retention (opt-in, client-only — see chatHistoryStore.js and CLAUDE.md's
// "Local chat history retention" Key conventions entry). Needs a real browser context since the
// feature is backed by IndexedDB, not something a pure-logic unit test can exercise.
//
// Covers, in one room with a single peer (history is a personal local feature, not a P2P one):
//   1. Enable the setting, send a message, reload into the same room — it reappears above a
//      "today" divider, styled read-only (.chat-message-history, no hover action bar).
//   2. Edit a message while live, reload — the persisted copy reflects the edit, not the original.
//   3. Delete a message while live, reload — it's gone from history too.
//   4. Toggle the setting off, send a message, reload — nothing persisted, nothing renders.
//   5. Retention window: a backdated entry written directly to the store is excluded once the
//      retention setting no longer covers it (pruned on read).
//   6. "Clear all local data" wipes chat history too, not just localStorage keys.
//
// Run with: npm run test:chat-history

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

const { chromium } = await import('playwright');

const PORT = process.env.TEST_PORT || 3116;
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

async function sendChat(page, text) {
    await page.fill('#message', text);
    await page.press('#message', 'Enter');
}

async function readStore(page, roomCode) {
    return page.evaluate(async ({ roomCode }) => {
        const store = await import('/client/chatHistoryStore.js');
        return store.getHistory(roomCode, 90);
    }, { roomCode });
}

// ChatUI.js's appendMessage/updateMessage/deleteMessage calls are deliberately
// fire-and-forget (a chat render path can't block on a background IndexedDB
// write) — the DOM updating is not proof the write has landed yet. Reloading
// immediately after a UI action would race that in-flight write, same as a
// real user hitting refresh a moment too soon; poll the store itself instead
// of a fixed sleep, so the test reflects "eventually persisted", not "persisted
// synchronously with the DOM".
async function waitForStore(page, roomCode, predicate, timeoutMs = 3000) {
    const start = Date.now();
    let last;
    while (Date.now() - start < timeoutMs) {
        last = await readStore(page, roomCode);
        if (predicate(last)) return last;
        await sleep(50);
    }
    throw new Error('timed out waiting for chatHistoryStore state, last read: ' + JSON.stringify(last));
}

async function enableHistory(page, days = '7') {
    await page.click('#topbar-identity');
    await page.click('#topbar-identity-settings');
    await page.click('[data-settings-section="privacy"]');
    await page.check('#settings-chat-history-enabled');
    await page.selectOption('#settings-chat-history-days', days);
    await page.click('#close-settings');
    await page.waitForTimeout(200);
}

async function main() {
    const server = await startServer();
    const browser = await chromium.launch({
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    const consoleErrors = [];
    try {
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
        const page = await ctx.newPage();
        page.on('pageerror', (err) => consoleErrors.push(String(err)));

        const resp = await page.request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: 6 } });
        const { code } = await resp.json();
        await page.goto(`${BASE_URL}/${code}`);
        await page.waitForSelector('.participant-card[data-self]', { timeout: 10000 });

        // --- Step 1: enable, send, reload, confirm reappearance as read-only history ---
        await enableHistory(page, '7');
        await sendChat(page, 'link to keep: https://example.com/keep');
        await page.waitForSelector('.chat-message:has-text("link to keep")', { timeout: 5000 });
        await waitForStore(page, code, (entries) => entries.some(e => e.text.includes('link to keep')));

        await page.reload();
        await page.waitForSelector('.participant-card[data-self]', { timeout: 10000 });
        const historicalMsg = page.locator('.chat-message-history:has-text("link to keep")');
        await historicalMsg.waitFor({ timeout: 5000 });
        assert(await historicalMsg.count() === 1, 'sent message reappears as read-only history after reload');
        assert(await page.locator('.chat-history-divider').count() === 1, 'a one-time divider is rendered above live traffic');
        const hoverActionsOnHistory = await historicalMsg.locator('.msg-action-bar').count();
        assert(hoverActionsOnHistory === 0, 'historical entries render with no hover action bar');
        console.log('STEP 1 - persisted message reappears read-only on rejoin: PASS');

        // --- Step 2: edit while live, reload, confirm the persisted copy is the edited text ---
        await sendChat(page, 'original edit-me text');
        await page.waitForSelector('.chat-message:has-text("original edit-me text")', { timeout: 5000 });
        const editTarget = page.locator('.chat-message:has-text("original edit-me text")').last();
        await editTarget.hover();
        await editTarget.locator('.msg-action-btn[data-tip="Edit"]').click();
        await page.waitForSelector('.chat-edit-input', { timeout: 3000 });
        await page.fill('.chat-edit-input', 'edited text, persisted');
        await page.press('.chat-edit-input', 'Enter');
        await page.waitForSelector('.chat-message:has-text("edited text, persisted")', { timeout: 3000 });
        await waitForStore(page, code, (entries) => entries.some(e => e.text === 'edited text, persisted'));

        await page.reload();
        await page.waitForSelector('.participant-card[data-self]', { timeout: 10000 });
        assert(await page.locator('.chat-message-history:has-text("edited text, persisted")').count() === 1, 'reloaded history reflects the edit');
        assert(await page.locator('.chat-message:has-text("original edit-me text")').count() === 0, 'the pre-edit text is not what got persisted');
        console.log('STEP 2 - edit propagates into persisted history: PASS');

        // --- Step 3: delete while live, reload, confirm it's gone from history ---
        await sendChat(page, 'doomed history message');
        await page.waitForSelector('.chat-message:has-text("doomed history message")', { timeout: 5000 });
        await waitForStore(page, code, (entries) => entries.some(e => e.text === 'doomed history message'));
        const doomed = page.locator('.chat-message:has-text("doomed history message")').last();
        await doomed.hover();
        const delBtn = doomed.locator('.msg-action-danger');
        await delBtn.click();
        await delBtn.click(); // two-step confirm
        await page.waitForSelector('.chat-message:has-text("doomed history message")', { state: 'detached', timeout: 3000 });
        await waitForStore(page, code, (entries) => !entries.some(e => e.text === 'doomed history message'));

        await page.reload();
        await page.waitForSelector('.participant-card[data-self]', { timeout: 10000 });
        assert(await page.locator('.chat-message:has-text("doomed history message")').count() === 0, 'a deleted message never reappears from history');
        console.log('STEP 3 - delete removes the message from persisted history too: PASS');

        // --- Step 4: toggle off, send, reload — nothing persists ---
        await page.click('#topbar-identity');
        await page.click('#topbar-identity-settings');
        await page.click('[data-settings-section="privacy"]');
        await page.uncheck('#settings-chat-history-enabled');
        await page.click('#close-settings');
        await page.waitForTimeout(200);

        await sendChat(page, 'never persisted message');
        await page.waitForSelector('.chat-message:has-text("never persisted message")', { timeout: 5000 });

        await page.reload();
        await page.waitForSelector('.participant-card[data-self]', { timeout: 10000 });
        assert(await page.locator('.chat-message:has-text("never persisted message")').count() === 0, 'nothing persists while the setting is off');
        console.log('STEP 4 - disabled setting persists nothing: PASS');

        // --- Step 5: retention window prunes on read ---
        await page.evaluate(async ({ roomCode }) => {
            const store = await import('/client/chatHistoryStore.js');
            // Write with a generous retention setting so appendMessage's own
            // prune-on-write doesn't immediately delete this backdated entry.
            localStorage.setItem('chatHistoryDays', '90');
            const oldTs = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago
            await store.appendMessage(roomCode, { messageId: 'backdated-1', sender: 'Tester', text: 'ancient backdated message', ts: oldTs, isSelf: true });
        }, { roomCode: code });

        const stillThereAt90Days = await page.evaluate(async ({ roomCode }) => {
            const store = await import('/client/chatHistoryStore.js');
            const entries = await store.getHistory(roomCode, 90);
            return entries.some(e => e.messageId === 'backdated-1');
        }, { roomCode: code });
        assert(stillThereAt90Days, 'backdated entry is present under a retention window wide enough to cover it');

        const prunedAt1Day = await page.evaluate(async ({ roomCode }) => {
            const store = await import('/client/chatHistoryStore.js');
            const entries = await store.getHistory(roomCode, 1);
            return entries.some(e => e.messageId === 'backdated-1');
        }, { roomCode: code });
        assert(!prunedAt1Day, 'the same backdated entry is excluded (pruned on read) once retention no longer covers it');
        console.log('STEP 5 - retention window prunes stale entries on read: PASS');

        // --- Step 6: "Clear all local data" wipes chat history, not just localStorage ---
        await page.evaluate(() => localStorage.setItem('chatHistoryDays', '90'));
        await page.click('#topbar-identity');
        await page.click('#topbar-identity-settings');
        await page.click('[data-settings-section="privacy"]');
        const clearDataBtn = page.locator('#settings-clear-data');
        await clearDataBtn.click();
        await clearDataBtn.click(); // two-step confirm — this reloads the page itself
        await page.waitForURL(`${BASE_URL}/${code}`, { timeout: 5000 });
        await page.waitForSelector('.participant-card[data-self]', { timeout: 10000 });

        // Re-enable the setting after the wipe (localStorage.clear() turned it back off too) —
        // isolates "did the IndexedDB data survive" from "is the flag still on".
        await enableHistory(page, '30');
        await page.reload();
        await page.waitForSelector('.participant-card[data-self]', { timeout: 10000 });
        const survivedClear = await page.locator('.chat-message-history:has-text("link to keep")').count();
        assert(survivedClear === 0, '"Clear all local data" wipes previously-persisted chat history');
        console.log('STEP 6 - Clear all local data wipes chat history too: PASS');

        assert(consoleErrors.length === 0, `no page errors during run, got: ${JSON.stringify(consoleErrors)}`);
        console.log('All chat-history-retention checks passed.');
    } finally {
        await browser.close();
        server.kill();
        await sleep(200);
    }
}

await main();
