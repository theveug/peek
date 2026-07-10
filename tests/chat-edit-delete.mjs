// Message edit/delete coverage, two layers:
//
// 1. Pure logic (no browser): PeerManager's chat-edit/chat-delete handlers
//    only honor the original author — a forged edit/delete from a different
//    peerId (or for an unknown messageId) must be ignored, and a blocked
//    peer's edit must be dropped even for their own message.
// 2. Two-peer browser test: A edits their message inline (Enter to save) and
//    B sees the new text + "(edited)" tag; A deletes a message via the
//    two-step confirm and it disappears on both sides.
//
// Run with: npm run test:chat-edit

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const storage = new Map();
globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
};

const { PeerManager } = await import('../public/client/PeerManager.js');

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

// --- Layer 1: authorization logic ---

function makeMockUi() {
    const calls = { edits: [], deletes: [], chats: [] };
    return {
        calls,
        blockedIds: new Set(),
        isBlocked(id) { return this.blockedIds.has(id); },
        _peerNickname: (id) => `nick-${id}`,
        addChatMessage: (...a) => calls.chats.push(a),
        updateTypingIndicator: () => {},
        applyChatEdit: (id, text) => calls.edits.push([id, text]),
        applyChatDelete: (id) => calls.deletes.push(id),
    };
}

(function testAuthorCanEditAndDelete() {
    const ui = makeMockUi();
    const pm = new PeerManager(null, ui);
    pm._handleDataChannelMessage('peerA', JSON.stringify({ type: 'chat', text: 'hi', messageId: 'm1' }));
    pm._handleDataChannelMessage('peerA', JSON.stringify({ type: 'chat-edit', messageId: 'm1', text: 'hi edited' }));
    assert(ui.calls.edits.length === 1 && ui.calls.edits[0][1] === 'hi edited', 'author\'s own edit is applied');
    pm._handleDataChannelMessage('peerA', JSON.stringify({ type: 'chat-delete', messageId: 'm1' }));
    assert(ui.calls.deletes.length === 1 && ui.calls.deletes[0] === 'm1', 'author\'s own delete is applied');
})();

(function testForgedEditAndDeleteAreIgnored() {
    const ui = makeMockUi();
    const pm = new PeerManager(null, ui);
    pm._handleDataChannelMessage('peerA', JSON.stringify({ type: 'chat', text: 'hi', messageId: 'm1' }));
    pm._handleDataChannelMessage('peerB', JSON.stringify({ type: 'chat-edit', messageId: 'm1', text: 'hijacked' }));
    pm._handleDataChannelMessage('peerB', JSON.stringify({ type: 'chat-delete', messageId: 'm1' }));
    assert(ui.calls.edits.length === 0, 'another peer\'s forged edit is ignored');
    assert(ui.calls.deletes.length === 0, 'another peer\'s forged delete is ignored');
    // After the forged delete attempt, the real author can still edit.
    pm._handleDataChannelMessage('peerA', JSON.stringify({ type: 'chat-edit', messageId: 'm1', text: 'still mine' }));
    assert(ui.calls.edits.length === 1, 'forged delete did not evict the real ownership record');
})();

(function testUnknownAndMalformedAreIgnored() {
    const ui = makeMockUi();
    const pm = new PeerManager(null, ui);
    pm._handleDataChannelMessage('peerA', JSON.stringify({ type: 'chat-edit', messageId: 'never-seen', text: 'x' }));
    pm._handleDataChannelMessage('peerA', JSON.stringify({ type: 'chat-edit', messageId: 'm1', text: '   ' }));
    pm._handleDataChannelMessage('peerA', JSON.stringify({ type: 'chat-edit', messageId: 42, text: 'x' }));
    pm._handleDataChannelMessage('peerA', JSON.stringify({ type: 'chat-delete', messageId: { evil: 1 } }));
    assert(ui.calls.edits.length === 0 && ui.calls.deletes.length === 0, 'unknown/blank/non-string ids and texts are all ignored');
})();

(function testBlockedPeerEditIgnored() {
    const ui = makeMockUi();
    const pm = new PeerManager(null, ui);
    pm._handleDataChannelMessage('peerA', JSON.stringify({ type: 'chat', text: 'hi', messageId: 'm1' }));
    ui.blockedIds.add('peerA');
    pm._handleDataChannelMessage('peerA', JSON.stringify({ type: 'chat-edit', messageId: 'm1', text: 'sneaky' }));
    assert(ui.calls.edits.length === 0, 'blocked peer\'s edit of their own message is dropped');
})();

console.log('--- authorization logic checks passed, starting browser test ---');

// --- Layer 2: two-peer browser flow ---

const { chromium } = await import('playwright');

const PORT = process.env.TEST_PORT || 3115;
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

async function main() {
    const server = await startServer();
    const browser = await chromium.launch({
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    const consoleErrors = [];
    try {
        const ctxA = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
        const pageA = await ctxA.newPage();
        pageA.on('pageerror', (err) => consoleErrors.push('A: ' + err));

        const resp = await pageA.request.post(`${BASE_URL}/api/create-room`, { data: { maxPeers: 6 } });
        const { code } = await resp.json();
        await pageA.goto(`${BASE_URL}/${code}`);

        const ctxB = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
        const pageB = await ctxB.newPage();
        pageB.on('pageerror', (err) => consoleErrors.push('B: ' + err));
        await pageB.goto(`${BASE_URL}/${code}`);

        await pageA.waitForSelector('.participant-card:not([data-self])', { timeout: 10000 });
        await pageB.waitForSelector('.participant-card:not([data-self])', { timeout: 10000 });

        // --- Edit flow ---
        await sendChat(pageA, 'original message');
        await pageB.waitForSelector('.chat-message:has-text("original message")', { timeout: 5000 });
        console.log('STEP 1 - message delivered: PASS');

        const msgA = pageA.locator('.chat-message:has-text("original message")').last();
        await msgA.hover();
        await msgA.locator('.msg-action-btn[data-tip="Edit"]').click();
        await pageA.waitForSelector('.chat-edit-input', { timeout: 3000 });
        await pageA.fill('.chat-edit-input', 'edited message text');
        await pageA.press('.chat-edit-input', 'Enter');

        await pageA.waitForSelector('.chat-message:has-text("edited message text")', { timeout: 3000 });
        const editedTagA = await pageA.locator('.chat-edited-tag').count();
        assert(editedTagA === 1, 'A sees the edited text with an (edited) tag');

        await pageB.waitForSelector('.chat-message:has-text("edited message text")', { timeout: 5000 });
        const staleOnB = await pageB.locator('.chat-message:has-text("original message")').count();
        assert(staleOnB === 0, 'B\'s copy was replaced, not duplicated');
        const editedTagB = await pageB.locator('.chat-edited-tag').count();
        assert(editedTagB === 1, 'B sees the (edited) tag');
        console.log('STEP 2 - edit propagates to B with (edited) tag: PASS');

        // Remote messages must not offer Edit/Delete buttons.
        const editBtnOnB = await pageB.locator('.chat-message:has-text("edited message text") .msg-action-btn[data-tip="Edit"]').count();
        assert(editBtnOnB === 0, 'B has no Edit button on A\'s message');

        // --- Delete flow (two-step confirm) ---
        await sendChat(pageA, 'doomed message');
        await pageB.waitForSelector('.chat-message:has-text("doomed message")', { timeout: 5000 });

        const doomedA = pageA.locator('.chat-message:has-text("doomed message")').last();
        await doomedA.hover();
        const delBtn = doomedA.locator('.msg-action-danger');
        await delBtn.click();
        // First click only arms — the message must still exist.
        const stillThere = await pageA.locator('.chat-message:has-text("doomed message")').count();
        assert(stillThere === 1, 'first delete click only arms the confirm');
        await delBtn.click();

        await pageA.waitForSelector('.chat-message:has-text("doomed message")', { state: 'detached', timeout: 3000 });
        await pageB.waitForSelector('.chat-message:has-text("doomed message")', { state: 'detached', timeout: 5000 });
        console.log('STEP 3 - two-step delete removes the message on both sides: PASS');

        assert(consoleErrors.length === 0, `no page errors during run, got: ${JSON.stringify(consoleErrors)}`);
        console.log('All chat edit/delete checks passed.');
    } finally {
        await browser.close();
        server.kill();
        await sleep(200);
    }
}

await main();
