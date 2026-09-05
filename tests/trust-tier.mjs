// Deployment-level 'trust' descriptor sent once in every 'init' message —
// verifies it mirrors the real env-driven server state already used to log
// STUN/TURN/debug status at startup, not just a hardcoded stub:
//   1. default (no DEBUG, no TURN) -> accounts/serverSideHistory hardcoded
//      false, debugLogging false, mediaRelayConfigured false,
//   2. DEBUG=1 -> debugLogging true,
//   3. TURN_URL+TURN_SECRET configured -> mediaRelayConfigured true.
//
// Each scenario needs its own spawned server process (trust is deployment-
// level, computed once at startup, not per-room) — spawned env explicitly
// blanks DEBUG/NODE_ENV/TURN_URL/TURN_SECRET/STUN_URL rather than trusting
// {...process.env} alone, so an ambient `npm run dev` environment (which may
// export DEBUG=1/NODE_ENV=development) can't leak into the "default" case.
//
// Run with: npm run test:trust-tier

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed dev cert

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

function startServer(port, envOverrides = {}) {
    const proc = spawn(process.execPath, ['server.js'], {
        env: {
            ...process.env,
            PORT: String(port),
            DEBUG: '',
            NODE_ENV: 'test',
            TURN_URL: '',
            TURN_SECRET: '',
            STUN_URL: '',
            ACCOUNTS_ENABLED: '',
            ACCOUNTS_DB_PATH: '',
            ...envOverrides,
        },
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

/** Lazy-join with an arbitrary code — no /api/create-room needed, same
 * pattern as lazy-room-owner.mjs — and resolve with the 'init' payload. */
function joinAndGetInit(port, code) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://localhost:${port}`, { rejectUnauthorized: false });
        ws.on('error', reject);
        ws.on('open', () => ws.send(JSON.stringify({ type: 'join', sessionId: code })));
        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.type === 'init') resolve({ ws, init: msg });
        });
        setTimeout(() => reject(new Error("timed out waiting for 'init'")), 5000);
    });
}

async function main() {
    // --- 1. default: no DEBUG, no TURN ---
    let server = await startServer(3126);
    try {
        const { ws, init } = await joinAndGetInit(3126, 'AAAAA');
        assert(init.trust.accounts === false, 'accounts is false with ACCOUNTS_ENABLED unset');
        assert(init.trust.serverSideHistory === false, 'serverSideHistory is hardcoded false');
        assert(init.trust.debugLogging === false, 'debugLogging false with no DEBUG env');
        assert(init.trust.mediaRelayConfigured === false, 'mediaRelayConfigured false with no TURN env');
        ws.close();
    } finally {
        server.kill();
        await sleep(200);
    }

    // --- 2. DEBUG=1 ---
    server = await startServer(3127, { DEBUG: '1' });
    try {
        const { ws, init } = await joinAndGetInit(3127, 'BBBBB');
        assert(init.trust.debugLogging === true, 'debugLogging true with DEBUG=1');
        ws.close();
    } finally {
        server.kill();
        await sleep(200);
    }

    // --- 3. TURN_URL + TURN_SECRET ---
    server = await startServer(3128, { TURN_URL: 'turn:example.invalid:3478', TURN_SECRET: 'shh' });
    try {
        const { ws, init } = await joinAndGetInit(3128, 'CCCCC');
        assert(init.trust.mediaRelayConfigured === true, 'mediaRelayConfigured true with TURN configured');
        ws.close();
    } finally {
        server.kill();
        await sleep(200);
    }

    console.log('All trust-tier checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
