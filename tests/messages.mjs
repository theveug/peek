// Accounts Phase 4 (direct messages) — raw fetch, no browser:
//   1. sending between accepted friends succeeds and appears in both
//      GET /api/messages/:username conversation views,
//   2. sending to a non-friend is rejected (even a nonexistent username, and
//      an existing account you're just not friends with),
//   3. self-DM is rejected,
//   4. empty/oversized/non-string body is rejected,
//   5. fetching a conversation marks the recipient's unread messages read —
//      confirmed via GET /api/messages' unreadCount,
//   6. GET /api/messages lists conversations most-recent-first with the
//      correct lastMessage/fromMe/unreadCount,
//   7. unfriending does not delete message history, but blocks new sends,
//   8. no cookie -> 401 on all three routes,
//   9. accounts-disabled deployment -> 404 on all three routes.
//
// Run with: npm run test:messages

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed dev cert

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

function startServer(port, envOverrides = {}) {
    const proc = spawn(process.execPath, ['server.js'], {
        env: { ...process.env, PORT: String(port), DEBUG: '', NODE_ENV: 'test', ACCOUNTS_ENABLED: '', ACCOUNTS_DB_PATH: '', ...envOverrides },
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

function cookiePair(res) {
    const raw = res.headers.get('set-cookie');
    if (!raw) return null;
    return raw.split(';')[0];
}

async function register(base, username, password) {
    const res = await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    return cookiePair(res);
}

async function sendFriendRequest(base, cookie, username) {
    await fetch(`${base}/api/friends/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ username }),
    });
}

async function befriend(base, cookieA, cookieB, usernameA, usernameB) {
    await sendFriendRequest(base, cookieA, usernameB);
    const res = await fetch(`${base}/api/friends`, { headers: { Cookie: cookieB } });
    const { incoming } = await res.json();
    const req = incoming.find(r => r.user.username === usernameA);
    await fetch(`${base}/api/friends/${req.requestId}/accept`, { method: 'POST', headers: { Cookie: cookieB } });
}

async function send(base, cookie, username, body) {
    const res = await fetch(`${base}/api/messages/${username}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ body }),
    });
    return { status: res.status, body: await res.json() };
}

async function conversation(base, cookie, username) {
    const res = await fetch(`${base}/api/messages/${username}`, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: res.status, body: await res.json() };
}

async function inbox(base, cookie) {
    const res = await fetch(`${base}/api/messages`, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: res.status, body: await res.json() };
}

async function main() {
    const scratchDir = mkdtempSync(path.join(tmpdir(), 'peek-messages-test-'));
    const dbPath = path.join(scratchDir, 'peek.db');
    const BASE = 'https://localhost:3137';

    let server = await startServer(3137, { ACCOUNTS_ENABLED: '1', ACCOUNTS_DB_PATH: dbPath });
    try {
        const aliceName = `alice_${Date.now()}`;
        const bobName = `bob_${Date.now()}`;
        const carolName = `carol_${Date.now()}`;
        const cookieA = await register(BASE, aliceName, 'correct-horse-battery');
        const cookieB = await register(BASE, bobName, 'another-horse-battery');
        const cookieC = await register(BASE, carolName, 'yet-another-battery');

        // --- 2. not friends yet ---
        const notFriendsYet = await send(BASE, cookieA, bobName, 'hi');
        assert(notFriendsYet.status === 404 && notFriendsYet.body.error === 'You can only message friends', 'messaging a non-friend is rejected');
        const ghostSend = await send(BASE, cookieA, `nobody_${Date.now()}`, 'hi');
        assert(ghostSend.status === 404, 'messaging a nonexistent username is rejected');

        // --- 3. self-DM ---
        const selfSend = await send(BASE, cookieA, aliceName, 'hi me');
        assert(selfSend.status === 404, 'self-DM is rejected');

        await befriend(BASE, cookieA, cookieB, aliceName, bobName);

        // --- 4. body validation ---
        assert((await send(BASE, cookieA, bobName, '')).status === 400, 'empty body is rejected');
        assert((await send(BASE, cookieA, bobName, '   ')).status === 400, 'whitespace-only body is rejected');
        assert((await send(BASE, cookieA, bobName, 'x'.repeat(4001))).status === 400, 'oversized body is rejected');
        assert((await send(BASE, cookieA, bobName, 42)).status === 400, 'non-string body is rejected');

        // --- 1. sending between friends ---
        const sendRes = await send(BASE, cookieA, bobName, 'Hey Bob!');
        assert(sendRes.status === 200 && sendRes.body.message.body === 'Hey Bob!' && sendRes.body.message.fromMe === true, "Alice's send succeeds and echoes fromMe:true");
        await send(BASE, cookieB, aliceName, 'Hey Alice!');

        const aliceConvo = await conversation(BASE, cookieA, bobName);
        assert(aliceConvo.status === 200 && aliceConvo.body.messages.length === 2, "Alice's conversation view shows both messages");
        assert(aliceConvo.body.messages[0].fromMe === true && aliceConvo.body.messages[1].fromMe === false, 'messages are ordered oldest-first with correct fromMe per side');

        const bobConvo = await conversation(BASE, cookieB, aliceName);
        assert(bobConvo.body.messages[0].fromMe === false && bobConvo.body.messages[1].fromMe === true, "Bob's conversation view shows the same two messages with fromMe flipped");

        // --- 5. fetching a conversation marks it read ---
        await send(BASE, cookieA, bobName, 'You there?');
        const bobInboxBeforeRead = await inbox(BASE, cookieB);
        assert(bobInboxBeforeRead.body.conversations[0].unreadCount === 1, "Bob's inbox shows 1 unread from Alice before he opens the thread");
        await conversation(BASE, cookieB, aliceName); // Bob opens the thread
        const bobInboxAfterRead = await inbox(BASE, cookieB);
        assert(bobInboxAfterRead.body.conversations[0].unreadCount === 0, "opening the conversation clears Bob's unread count");

        // --- 6. inbox listing ---
        await befriend(BASE, cookieA, cookieC, aliceName, carolName);
        await send(BASE, cookieA, carolName, 'Hi Carol');
        const aliceInbox = await inbox(BASE, cookieA);
        assert(aliceInbox.body.conversations.length === 2, "Alice's inbox lists both conversations (Bob and Carol)");
        assert(aliceInbox.body.conversations[0].user.username === carolName, 'most-recently-active conversation (Carol) sorts first');
        assert(aliceInbox.body.conversations[0].lastMessage.fromMe === true, "Alice's own last message to Carol shows fromMe:true in her inbox");

        // --- 7. unfriending preserves history but blocks new sends ---
        const aliceFriends = await fetch(`${BASE}/api/friends`, { headers: { Cookie: cookieA } }).then(r => r.json());
        const abFriendship = aliceFriends.friends.find(f => f.username === bobName);
        await fetch(`${BASE}/api/friends/${abFriendship.requestId}`, { method: 'DELETE', headers: { Cookie: cookieA } });
        const convoAfterUnfriend = await conversation(BASE, cookieA, bobName);
        assert(convoAfterUnfriend.status === 200 && convoAfterUnfriend.body.messages.length > 0, 'conversation history survives unfriending');
        const sendAfterUnfriend = await send(BASE, cookieA, bobName, 'still there?');
        assert(sendAfterUnfriend.status === 404, 'sending a new message after unfriending is rejected');

        // --- 8. no cookie ---
        assert((await inbox(BASE, null)).status === 401, 'GET /api/messages: 401 with no cookie');
        assert((await conversation(BASE, null, bobName)).status === 401, 'GET /api/messages/:username: 401 with no cookie');
        const noCookieSend = await fetch(`${BASE}/api/messages/${bobName}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'x' }) });
        assert(noCookieSend.status === 401, 'POST /api/messages/:username: 401 with no cookie');
    } finally {
        server.kill();
        await sleep(200);
    }

    // --- 9. accounts-disabled deployment ---
    server = await startServer(3138); // ACCOUNTS_ENABLED left unset
    try {
        const BASE2 = 'https://localhost:3138';
        assert((await fetch(`${BASE2}/api/messages`)).status === 404, 'accounts disabled: GET /api/messages is a plain 404');
        assert((await fetch(`${BASE2}/api/messages/someone`)).status === 404, 'accounts disabled: GET /api/messages/:username is a plain 404');
        assert((await fetch(`${BASE2}/api/messages/someone`, { method: 'POST' })).status === 404, 'accounts disabled: POST /api/messages/:username is a plain 404');
    } finally {
        server.kill();
        await sleep(200);
    }

    rmSync(scratchDir, { recursive: true, force: true });
    console.log('All messages checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
