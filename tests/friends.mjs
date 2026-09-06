// Accounts Phase 2 (friends) — raw fetch, no browser:
//   1. Alice requests Bob by username -> Bob sees incoming, Alice sees outgoing,
//   2. self-request -> 400 reason 'self',
//   3. request to nonexistent username -> 400 'not_found',
//   4. duplicate pending request -> 400 'already_pending',
//   5. Bob accepts -> both see each other in friends, pending cleared,
//   6. requesting an existing friend again -> 400 'already_friends',
//   7. either side removes the friendship -> gone from both sides,
//   8. mutual-pending auto-accept (Carol -> Dave, then Dave -> Carol),
//   9. declining an incoming request via DELETE -> no friendship created,
//  10. accept/remove someone else's requestId -> 400,
//  11. no cookie -> 401 on all four routes,
//  12. accounts-disabled deployment -> 404 on all four routes.
//  13. blocking (2026-09-07 security-review follow-up): self-block -> 400,
//      block nonexistent username -> 400, blocking a friend severs the
//      friendship, a blocked user's request is rejected exactly like a
//      nonexistent one (no 'blocked' reason leaked), the *blocker's* own
//      request to the blocked user is also rejected, unblocking someone
//      else's block id -> 400, unblocking restores normal request flow,
//      no cookie -> 401, accounts-disabled -> 404.
//
// Run with: npm run test:friends

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

async function getFriends(base, cookie) {
    const res = await fetch(`${base}/api/friends`, { headers: { Cookie: cookie } });
    return { status: res.status, body: await res.json() };
}

async function sendRequest(base, cookie, username) {
    const res = await fetch(`${base}/api/friends/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ username }),
    });
    return { status: res.status, body: await res.json() };
}

async function accept(base, cookie, requestId) {
    const res = await fetch(`${base}/api/friends/${requestId}/accept`, { method: 'POST', headers: { Cookie: cookie } });
    return { status: res.status, body: await res.json() };
}

async function remove(base, cookie, requestId) {
    const res = await fetch(`${base}/api/friends/${requestId}`, { method: 'DELETE', headers: { Cookie: cookie } });
    return { status: res.status, body: await res.json() };
}

async function block(base, cookie, username) {
    const res = await fetch(`${base}/api/friends/block`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ username }),
    });
    return { status: res.status, body: await res.json() };
}

async function unblock(base, cookie, blockId) {
    const res = await fetch(`${base}/api/friends/block/${blockId}`, { method: 'DELETE', headers: { Cookie: cookie } });
    return { status: res.status, body: await res.json() };
}

async function main() {
    const scratchDir = mkdtempSync(path.join(tmpdir(), 'peek-friends-test-'));
    const dbPath = path.join(scratchDir, 'peek.db');
    const BASE = 'https://localhost:3133';

    let server = await startServer(3133, { ACCOUNTS_ENABLED: '1', ACCOUNTS_DB_PATH: dbPath });
    try {
        const aliceName = `alice_${Date.now()}`;
        const bobName = `bob_${Date.now()}`;
        const cookieA = await register(BASE, aliceName, 'correct-horse-battery');
        const cookieB = await register(BASE, bobName, 'another-horse-battery');

        // --- 2. self-request ---
        const selfReq = await sendRequest(BASE, cookieA, aliceName);
        assert(selfReq.status === 400 && selfReq.body.error, 'self-request is rejected with 400');

        // --- 3. nonexistent username ---
        const ghostReq = await sendRequest(BASE, cookieA, `nobody_${Date.now()}`);
        assert(ghostReq.status === 400, 'requesting a nonexistent username is rejected with 400');

        // --- 1. Alice -> Bob ---
        const reqRes = await sendRequest(BASE, cookieA, bobName);
        assert(reqRes.status === 200 && reqRes.body.status === 'pending', 'Alice -> Bob request succeeds as pending');

        const bobView1 = await getFriends(BASE, cookieB);
        assert(bobView1.body.incoming.length === 1 && bobView1.body.incoming[0].user.username === aliceName, "Bob's incoming shows Alice");
        const aliceView1 = await getFriends(BASE, cookieA);
        assert(aliceView1.body.outgoing.length === 1 && aliceView1.body.outgoing[0].user.username === bobName, "Alice's outgoing shows Bob");
        const requestId = bobView1.body.incoming[0].requestId;

        // --- 4. duplicate pending ---
        const dupeReq = await sendRequest(BASE, cookieA, bobName);
        assert(dupeReq.status === 400, 'a second request to the same still-pending user is rejected');

        // --- 5. Bob accepts ---
        const acceptRes = await accept(BASE, cookieB, requestId);
        assert(acceptRes.status === 200, 'Bob accepts the request');
        const bobView2 = await getFriends(BASE, cookieB);
        assert(bobView2.body.friends.some(f => f.username === aliceName), 'Alice now appears in Bob\'s friends');
        assert(bobView2.body.incoming.length === 0, "Bob's incoming is cleared after accepting");
        const aliceView2 = await getFriends(BASE, cookieA);
        assert(aliceView2.body.friends.some(f => f.username === bobName), 'Bob now appears in Alice\'s friends');
        assert(aliceView2.body.outgoing.length === 0, "Alice's outgoing is cleared after Bob accepted");

        // --- 6. request an existing friend again ---
        const reFriendReq = await sendRequest(BASE, cookieA, bobName);
        assert(reFriendReq.status === 400, 'requesting an existing friend again is rejected');

        // --- 7. remove an accepted friendship, from either side ---
        const removeRes = await remove(BASE, cookieA, requestId); // requestId is Alice<->Bob's row, from step 1
        assert(removeRes.status === 200, 'Alice removes the accepted friendship');
        const bobView3 = await getFriends(BASE, cookieB);
        assert(!bobView3.body.friends.some(f => f.username === aliceName), 'Alice is gone from Bob\'s friends after removal');
        const aliceView3 = await getFriends(BASE, cookieA);
        assert(!aliceView3.body.friends.some(f => f.username === bobName), 'Bob is gone from Alice\'s friends after removal');

        const carolName = `carol_${Date.now()}`;
        const daveName = `dave_${Date.now()}`;
        const cookieC = await register(BASE, carolName, 'correct-horse-battery');
        const cookieD = await register(BASE, daveName, 'another-horse-battery');
        const cdReq = await sendRequest(BASE, cookieC, daveName);
        assert(cdReq.status === 200, 'Carol -> Dave request succeeds');
        const cdView = await getFriends(BASE, cookieD);
        const cdRequestId = cdView.body.incoming[0].requestId;

        // --- 10. accept/remove someone else's requestId ---
        const wrongAccept = await accept(BASE, cookieA, cdRequestId); // Alice tries to accept Carol/Dave's request
        assert(wrongAccept.status === 400, "accepting someone else's request id is rejected");
        const wrongRemove = await remove(BASE, cookieA, cdRequestId);
        assert(wrongRemove.status === 400, "removing someone else's relationship is rejected");

        // --- 9. decline an incoming request via DELETE ---
        const declineRes = await remove(BASE, cookieD, cdRequestId);
        assert(declineRes.status === 200, 'Dave declines (DELETE) the incoming request');
        const cView = await getFriends(BASE, cookieC);
        assert(cView.body.outgoing.length === 0 && !cView.body.friends.some(f => f.username === daveName), "declining leaves no friendship and clears Carol's outgoing");

        // --- 8. mutual-pending auto-accept ---
        const carolToDave = await sendRequest(BASE, cookieC, daveName);
        assert(carolToDave.status === 200 && carolToDave.body.status === 'pending', 'Carol -> Dave (fresh) is pending');
        const daveToCarol = await sendRequest(BASE, cookieD, carolName);
        assert(daveToCarol.status === 200 && daveToCarol.body.status === 'accepted', 'Dave -> Carol while Carol\'s request is pending auto-accepts instead of creating a second pending row');
        const carolView2 = await getFriends(BASE, cookieC);
        assert(carolView2.body.friends.some(f => f.username === daveName), 'Carol and Dave are friends after the mutual-pending auto-accept');
        assert(carolView2.body.outgoing.length === 0, 'no leftover pending row for Carol after auto-accept');

        // --- 13. blocking --- reuses Alice/Bob (already unfriended in step 7
        // above) rather than registering two more users — /api/auth/register
        // is rate-limited to 5/min, and this test already spends 4 of those
        // on Alice/Bob/Carol/Dave.
        const selfBlock = await block(BASE, cookieA, aliceName);
        assert(selfBlock.status === 400, 'self-block is rejected with 400');
        const ghostBlock = await block(BASE, cookieA, `nobody_${Date.now()}`);
        assert(ghostBlock.status === 400, 'blocking a nonexistent username is rejected with 400');

        // Become friends again first, so blocking-severs-friendship is exercised too.
        await sendRequest(BASE, cookieA, bobName);
        const abView = await getFriends(BASE, cookieB);
        await accept(BASE, cookieB, abView.body.incoming[0].requestId);
        assert((await getFriends(BASE, cookieA)).body.friends.some(f => f.username === bobName), 'Alice and Bob are friends again before the block');

        const blockRes = await block(BASE, cookieA, bobName);
        assert(blockRes.status === 200 && blockRes.body.blocked === true, 'Alice blocks Bob');
        assert(!(await getFriends(BASE, cookieA)).body.friends.some(f => f.username === bobName), "blocking severs the existing friendship (Alice's side)");
        assert(!(await getFriends(BASE, cookieB)).body.friends.some(f => f.username === aliceName), "blocking severs the existing friendship (Bob's side)");

        const bobToAlice = await sendRequest(BASE, cookieB, aliceName);
        assert(bobToAlice.status === 400 && bobToAlice.body.error === 'No account with that username', "the blocked user's request is rejected with the same message as a nonexistent account (no 'blocked' reason leaked)");
        const aliceToBob = await sendRequest(BASE, cookieA, bobName);
        assert(aliceToBob.status === 400, "the blocker's own request to the blocked user is also rejected");

        const aliceBlockedView = await getFriends(BASE, cookieA);
        assert(aliceBlockedView.body.blocked.some(b => b.username === bobName), "Alice's own view shows Bob in her blocked list");
        assert(!(await getFriends(BASE, cookieB)).body.blocked?.length, "Bob's own blocked list is empty — a block is invisible to the person blocked");
        const blockId = aliceBlockedView.body.blocked.find(b => b.username === bobName).blockId;

        const wrongUnblock = await unblock(BASE, cookieB, blockId);
        assert(wrongUnblock.status === 400, "unblocking someone else's block id is rejected");

        const unblockRes = await unblock(BASE, cookieA, blockId);
        assert(unblockRes.status === 200, 'Alice unblocks Bob');
        const reFriendReq2 = await sendRequest(BASE, cookieB, aliceName);
        assert(reFriendReq2.status === 200, 'after unblocking, Bob can request Alice again');

        // --- 11. no cookie ---
        const noCookieGet = await fetch(`${BASE}/api/friends`);
        assert(noCookieGet.status === 401, 'GET /api/friends: 401 with no cookie');
        const noCookiePost = await fetch(`${BASE}/api/friends/request`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'x' }),
        });
        assert(noCookiePost.status === 401, 'POST /api/friends/request: 401 with no cookie');
        const noCookieAccept = await fetch(`${BASE}/api/friends/1/accept`, { method: 'POST' });
        assert(noCookieAccept.status === 401, 'POST /api/friends/:id/accept: 401 with no cookie');
        const noCookieDelete = await fetch(`${BASE}/api/friends/1`, { method: 'DELETE' });
        assert(noCookieDelete.status === 401, 'DELETE /api/friends/:id: 401 with no cookie');
        const noCookieBlock = await fetch(`${BASE}/api/friends/block`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'x' }),
        });
        assert(noCookieBlock.status === 401, 'POST /api/friends/block: 401 with no cookie');
        const noCookieUnblock = await fetch(`${BASE}/api/friends/block/1`, { method: 'DELETE' });
        assert(noCookieUnblock.status === 401, 'DELETE /api/friends/block/:id: 401 with no cookie');
    } finally {
        server.kill();
        await sleep(200);
    }

    // --- 12. accounts-disabled deployment ---
    server = await startServer(3134); // ACCOUNTS_ENABLED left unset
    try {
        const BASE2 = 'https://localhost:3134';
        assert((await fetch(`${BASE2}/api/friends`)).status === 404, 'accounts disabled: GET /api/friends is a plain 404');
        assert((await fetch(`${BASE2}/api/friends/request`, { method: 'POST' })).status === 404, 'accounts disabled: POST /api/friends/request is a plain 404');
        assert((await fetch(`${BASE2}/api/friends/1/accept`, { method: 'POST' })).status === 404, 'accounts disabled: POST /api/friends/:id/accept is a plain 404');
        assert((await fetch(`${BASE2}/api/friends/1`, { method: 'DELETE' })).status === 404, 'accounts disabled: DELETE /api/friends/:id is a plain 404');
        assert((await fetch(`${BASE2}/api/friends/block`, { method: 'POST' })).status === 404, 'accounts disabled: POST /api/friends/block is a plain 404');
        assert((await fetch(`${BASE2}/api/friends/block/1`, { method: 'DELETE' })).status === 404, 'accounts disabled: DELETE /api/friends/block/:id is a plain 404');
    } finally {
        server.kill();
        await sleep(200);
    }

    rmSync(scratchDir, { recursive: true, force: true });
    console.log('All friends checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
