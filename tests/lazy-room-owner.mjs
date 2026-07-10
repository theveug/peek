// Lazily-created rooms get an owner (fix for "joining a dead/unknown code
// leaves the room ownerless — no kick/ban/promote possible all session"):
//
// Raw-ws layer:
//   1. joining a code with no live session returns a minted creatorToken in
//      'init' and marks the joiner as creatorPeerId,
//   2. a second joiner gets no token and isn't the creator,
//   3. the minted ownership carries real powers — kick works, and BAN works
//      (regression guard: addPeer's lazy-create used to build its own session
//      object missing bannedIps, so recordBan threw and killed the server on
//      exactly this path),
//   4. joining an existing /api/create-room room without a token mints nothing.
//
// Browser layer (App.js side):
//   5. a browser landing on an unknown code's room URL stores the minted token
//      in sessionStorage and shows the self crown badge; after a reload
//      (fresh peerId) the token re-claims ownership.
//
// Run with: npm run test:lazy-owner

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed dev cert

const PORT = process.env.TEST_PORT || 3119;
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

function randomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function connectAndJoin(code, { creatorToken } = {}) {
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
            ws.send(JSON.stringify(join));
        });
        const waitFor = (type, timeoutMs = 5000) => new Promise((res, rej) => {
            const check = () => {
                const found = messages.find(m => m.type === type);
                if (found) res(found);
            };
            waiters.push(check);
            check();
            setTimeout(() => rej(new Error(`timed out waiting for '${type}'; got: ${messages.map(m => m.type).join(',')}`)), timeoutMs);
        });
        resolve({ ws, messages, waitFor });
    });
}

async function main() {
    const server = await startServer();
    let serverDied = false;
    server.on('exit', () => { serverDied = true; });
    try {
        // --- Raw-ws layer ---
        const code = randomCode();
        console.log('unknown code:', code);

        const owner = await connectAndJoin(code);
        const ownerInit = await owner.waitFor('init');
        assert(typeof ownerInit.creatorToken === 'string' && ownerInit.creatorToken.length >= 16,
            'lazy-created room returns a minted creatorToken in init');
        assert(ownerInit.creatorPeerId === ownerInit.peerId, 'the lazy creator is marked creatorPeerId');

        const second = await connectAndJoin(code);
        const secondInit = await second.waitFor('init');
        assert(secondInit.creatorToken === undefined, 'second joiner gets no creatorToken');
        assert(secondInit.creatorPeerId === ownerInit.peerId, 'second joiner sees the lazy creator as creator');

        // Minted ownership carries real powers: kick...
        owner.ws.send(JSON.stringify({ type: 'kick', to: secondInit.peerId }));
        await second.waitFor('kicked');
        console.log('STEP 1 - lazy owner can kick: PASS');
        await sleep(300);

        // ...and ban, in this lazily-created session (the recordBan crash path).
        const third = await connectAndJoin(code);
        const thirdInit = await third.waitFor('init');
        owner.ws.send(JSON.stringify({ type: 'ban', to: thirdInit.peerId }));
        await third.waitFor('banned');
        await sleep(300);
        assert(!serverDied, 'server survived a ban in a lazily-created room');
        const banRetry = await connectAndJoin(code);
        const err = await banRetry.waitFor('join-error');
        assert(err.reason === 'banned', 'ban sticks in a lazily-created room');
        console.log('STEP 2 - lazy owner can ban, no server crash: PASS');

        // Existing rooms are untouched: /api/create-room's token holder stays owner.
        const createResp = await fetch(`${BASE_URL}/api/create-room`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ maxPeers: 6 }),
        });
        const { code: apiCode } = await createResp.json();
        const visitor = await connectAndJoin(apiCode);
        const visitorInit = await visitor.waitFor('init');
        assert(visitorInit.creatorToken === undefined, 'joining an existing (API-created) room mints nothing');
        assert(visitorInit.creatorPeerId === null, 'visitor is not creator of the API-created room');
        console.log('STEP 3 - existing rooms unaffected: PASS');
        owner.ws.close(); visitor.ws.close();

        // --- Browser layer ---
        const { chromium } = await import('playwright');
        const browser = await chromium.launch({
            args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        });
        try {
            const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
            const page = await ctx.newPage();
            const browserCode = randomCode();
            await page.goto(`${BASE_URL}/${browserCode}`);
            await page.waitForSelector('.participant-card[data-self]', { state: 'attached', timeout: 10000 });

            await page.waitForFunction(() => !!sessionStorage.getItem('creatorToken'), null, { timeout: 5000 });
            console.log('STEP 4 - browser stored the minted creatorToken: PASS');

            const crownShown = await page.evaluate(() => {
                const crown = document.querySelector('.participant-card[data-self] .participant-crown');
                return crown && crown.style.display !== 'none';
            });
            assert(crownShown, 'self card shows the creator crown');

            // Reload = new connection = new peerId; the stored token must re-claim.
            await page.reload();
            await page.waitForSelector('.participant-card[data-self]', { state: 'attached', timeout: 10000 });
            await page.waitForFunction(() => {
                const crown = document.querySelector('.participant-card[data-self] .participant-crown');
                return crown && crown.style.display !== 'none';
            }, null, { timeout: 5000 });
            console.log('STEP 5 - ownership survives a reload via the stored token: PASS');
        } finally {
            await browser.close();
        }

        console.log('All lazy-room-owner checks passed.');
    } finally {
        server.kill();
        await sleep(200);
    }
}

await main();
