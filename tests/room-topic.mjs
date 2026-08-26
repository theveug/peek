// Room topic banner (creator-only, live) with raw ws clients (no browser):
//   1. /api/create-room seeds a topic, and a fresh join's 'init' reflects it,
//   2. an overlong topic gets capped at 120 chars, same tier as password's
//      200-char cap,
//   3. a non-creator's set-topic is silently ignored (no broadcast),
//   4. the creator's set-topic broadcasts 'topic-update' to every peer in the
//      room (including the creator) — one apply path for everyone,
//   5. the creator can clear the topic entirely (falsy value).
//
// Structural mirror of room-password.mjs's test shape for the analogous
// creator-only room-rule feature.
//
// Run with: npm run test:room-topic

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed dev cert

const PORT = process.env.TEST_PORT || 3124;
const BASE_URL = `https://localhost:${PORT}`;
const WS_URL = `wss://localhost:${PORT}`;

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

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

/** Opens a socket, sends a join, and resolves with helpers around it. */
function connectAndJoin(code, { creatorToken, topic } = {}) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
        const messages = [];
        const waiters = [];
        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            messages.push(msg);
            waiters.forEach(w => w());
        });
        ws.on('error', reject);
        ws.on('open', () => {
            const join = { type: 'join', sessionId: code };
            if (creatorToken) join.creatorToken = creatorToken;
            if (topic) join.topic = topic;
            ws.send(JSON.stringify(join));
        });
        const waitFor = (type, timeoutMs = 5000) => new Promise((res, rej) => {
            const check = () => {
                const found = messages.find(m => m.type === type);
                if (found) res(found);
            };
            waiters.push(check);
            check();
            setTimeout(() => rej(new Error(`timed out waiting for '${type}'`)), timeoutMs);
        });
        waitFor('init').then(init => resolve({ ws, messages, waitFor, init })).catch(reject);
    });
}

async function createRoom(body) {
    const res = await fetch(`${BASE_URL}/api/create-room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return res.json();
}

async function main() {
    const server = await startServer();
    try {
        const TOPIC1 = 'Sprint planning';
        const TOPIC2 = 'Rotated topic';
        const { code, creatorToken } = await createRoom({ topic: TOPIC1 });

        // --- 1. create-time topic round-trips into a fresh join's init ---
        const creator = await connectAndJoin(code, { creatorToken });
        assert(creator.init.topic === TOPIC1, "a fresh join's init reflects the create-time topic");

        // --- 2. overlong topic gets capped at 120 chars ---
        const longTopic = 'x'.repeat(200);
        const { code: code2, creatorToken: token2 } = await createRoom({ topic: longTopic });
        const capped = await connectAndJoin(code2, { creatorToken: token2 });
        assert(capped.init.topic.length === 120, 'an overlong create-time topic is capped at 120 chars');
        capped.ws.close();

        const peerB = await connectAndJoin(code);

        // --- 3. non-creator's set-topic is ignored ---
        peerB.ws.send(JSON.stringify({ type: 'set-topic', payload: { topic: 'hijacked' } }));
        await sleep(400);
        assert(!creator.messages.some(m => m.type === 'topic-update'),
            "non-creator's set-topic produced no broadcast");

        // --- 4. creator's change broadcasts to everyone including themselves ---
        creator.ws.send(JSON.stringify({ type: 'set-topic', payload: { topic: TOPIC2 } }));
        const updCreator = await creator.waitFor('topic-update');
        const updB = await peerB.waitFor('topic-update');
        assert(updCreator.payload?.topic === TOPIC2, 'creator received their own topic-update with the new value');
        assert(updB.payload?.topic === TOPIC2, 'other peer received the topic-update with the new value');

        // --- 5. creator clears the topic entirely ---
        creator.ws.send(JSON.stringify({ type: 'set-topic', payload: { topic: null } }));
        await sleep(300);
        const clearMsg = creator.messages.filter(m => m.type === 'topic-update').pop();
        assert(clearMsg.payload?.topic === null, 'clearing broadcasts topic:null');

        creator.ws.close();
        peerB.ws.close();
        await sleep(200);

        // --- 6. a lazily-recreated session adopts the rejoining client's
        //        resent topic, instead of coming back topic-less ---
        const { code: code3, creatorToken: token3 } = await createRoom({ topic: 'First life' });
        const solo = await connectAndJoin(code3, { creatorToken: token3 });
        assert(solo.init.topic === 'First life', 'sanity: solo peer sees the create-time topic');
        solo.ws.close();
        await sleep(300); // let removePeer() delete the now-empty session

        const revived = await connectAndJoin(code3, { creatorToken: token3, topic: 'First life' });
        assert(revived.init.topic === 'First life', 'a lazily-recreated session adopts the resent topic instead of coming back null');
        revived.ws.close();

        await sleep(200);
        console.log('All room-topic checks passed.');
    } finally {
        server.kill();
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
