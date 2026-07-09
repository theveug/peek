// --- server.js ---
import 'dotenv/config';
import express from 'express';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync, existsSync } from 'fs';
import { randomInt, randomBytes } from 'crypto';
import { WebSocketServer } from 'ws';
import { setupWebSocket } from './src/server/WebSocketServer.js';
import { SessionManager } from './src/server/SessionManager.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { Debug } from './utils/Debug.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const certKey = './certs/localhost-key.pem';
const certFile = './certs/localhost.pem';
const useHttps = existsSync(certKey) && existsSync(certFile);

const server = useHttps
    ? createHttpsServer({ key: readFileSync(certKey), cert: readFileSync(certFile) }, app)
    : createHttpServer(app);
// Signalling messages are small (SDP offers top out around a few KB) — a large
// cap would let one peer send a huge broadcast payload the server fans out to
// every other peer in the room (amplification DoS).
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

const manager = new SessionManager();

const turnConfig = (process.env.TURN_URL && process.env.TURN_SECRET)
    ? { url: process.env.TURN_URL, secret: process.env.TURN_SECRET }
    : null;

// Optional public STUN for internet deployments without TURN. Deliberately no
// hardcoded default (this used to be Google's STUN): a third-party server
// seeing every participant's IP on every call cut against the privacy ethos,
// and on a LAN host candidates suffice with no STUN/TURN at all.
const stunUrl = process.env.STUN_URL || null;

if (turnConfig) {
    Debug.log('TURN server configured:', turnConfig.url);
} else if (stunUrl) {
    Debug.log('STUN server configured:', stunUrl);
} else {
    Debug.log('No STUN/TURN configured — direct/LAN candidates only');
}

// Identifies this running process to connected clients so they can tell when
// they're talking to a stale client build after a deploy/restart. Generated
// fresh every process start — no manual version bump required to "just know".
const APP_VERSION = process.env.APP_VERSION || '0.0.0';
const BUILD_ID = `${APP_VERSION}-${Date.now()}`;

setupWebSocket(wss, { turnConfig, stunUrl }, manager, BUILD_ID);

function generateUniqueShortCode(length = 5) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result;
    do {
        result = '';
        for (let i = 0; i < length; i++) {
            result += characters.charAt(randomInt(characters.length));
        }
    } while (manager.hasSession(result));
    return result;
}

// Minimal per-IP fixed-window rate limiter — in-memory only, nothing persisted.
function rateLimit(windowMs, max) {
    const hits = new Map();
    setInterval(() => hits.clear(), windowMs).unref();
    return (req, res, next) => {
        const count = (hits.get(req.ip) || 0) + 1;
        hits.set(req.ip, count);
        if (count > max) {
            res.status(429).json({ error: 'Too many requests' });
            return;
        }
        next();
    };
}

// Sessions created via /api/create-room that nobody ever joins would otherwise live forever.
setInterval(() => manager.sweepEmptySessions(10 * 60_000), 60_000).unref();

// Behind a reverse proxy (nginx/caddy/cloudflared), req.ip is the proxy's
// address unless Express is told to trust X-Forwarded-For — which would make
// the per-IP rate limits one shared bucket for every visitor. Opt-in only
// (TRUST_PROXY=1 for one hop, or any value Express's 'trust proxy' accepts):
// trusting the header with no proxy in front lets clients spoof their IP.
const TRUST_PROXY = process.env.TRUST_PROXY || null;
if (TRUST_PROXY) {
    app.set('trust proxy', TRUST_PROXY === '1' || TRUST_PROXY === 'true' ? 1 : TRUST_PROXY);
}

// Security headers on every response. script-src is a strict 'self' — all
// third-party libs are self-hosted (public/assets/vendor) and both pages'
// former inline scripts are external files now (lobby.js, markdown-setup.js),
// so nothing needs 'unsafe-inline'. style-src keeps 'unsafe-inline' because
// the redesign leans on inline style="" attributes (see CLAUDE.md). connect-src
// lists ws:/wss: explicitly since not every browser lets 'self' cover the
// scheme change to the signalling socket; img-src allows blob: for received
// file-image previews. Any new external resource will be blocked until it's
// self-hosted — that's the point. 'wasm-unsafe-eval' (added 2026-07-09 for
// background blur's self-hosted MediaPipe WASM) is a distinct, narrower CSP
// Level 3 keyword — it only permits compiling/instantiating WebAssembly
// modules, not JS eval()/Function() — 'unsafe-eval' remains deliberately absent.
// worker-src (added 2026-07-10 for mic noise suppression's self-hosted RNNoise
// WASM, loaded via audioContext.audioWorklet.addModule()) is explicit rather
// than relying on its fallback to script-src, since AudioWorkletGlobalScope
// runs in its own realm and the fallback chain is worth being unambiguous about.
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "worker-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "media-src 'self' blob:",
        "connect-src 'self' ws: wss:",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
    next();
});

app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
app.use('/client', express.static(path.join(__dirname, 'public/client')));

// Lobby page
app.get('/', (req, res) => {
    Debug.log('Serving lobby');
    res.sendFile(path.join(__dirname, 'public/lobby.html'));
});

// API: Create room
app.post('/api/create-room', rateLimit(60_000, 10), (req, res) => {
    const { name, password, maxPeers } = req.body || {};
    const code = generateUniqueShortCode();
    const cleanName = name ? name.replace(/[<>]/g, '').trim().substring(0, 50) : null;
    const creatorToken = randomBytes(16).toString('hex');
    manager.createSession(code, { name: cleanName || null, password: password || null, maxPeers, creatorToken });
    Debug.log(`Room created: ${code}${cleanName ? ` (${cleanName})` : ''}${password ? ' [password]' : ''}`);
    res.json({ code, creatorToken });
});

// API: Validate room (check if it exists / needs password)
app.post('/api/validate-room', rateLimit(60_000, 30), (req, res) => {
    const { code, password } = req.body || {};
    const meta = manager.getSessionMeta(code);
    if (!meta) {
        res.json({ valid: true, needsPassword: false, name: null });
        return;
    }
    if (meta.hasPassword && !password) {
        res.json({ valid: false, needsPassword: true, name: meta.name });
        return;
    }
    if (meta.hasPassword && !manager.validatePassword(code, password)) {
        res.json({ valid: false, needsPassword: true, name: meta.name, wrongPassword: true });
        return;
    }
    if (manager.isFull(code)) {
        res.json({ valid: false, needsPassword: false, full: true, name: meta.name });
        return;
    }
    res.json({ valid: true, needsPassword: false, name: meta.name });
});

// Retired standalone settings page — settings now live in a single overlay
// reachable from the lobby and in-room (see public/client/SettingsPanel.js).
// Redirect old bookmarked URLs instead of 404ing.
app.get('/settings', (req, res) => {
    res.redirect('/');
});

// Serve session page for valid room codes
app.get('/:code', (req, res) => {
    const code = req.params.code;
    if (code.length === 5 && /^[A-Za-z0-9]{5}$/.test(code)) {
        Debug.log(`Serving session: ${code}`);
        res.sendFile(path.join(__dirname, 'public/index.html'));
    } else {
        res.status(404).send('Not Found');
    }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || 'Peek';

server.listen(PORT, () => {
    const proto = useHttps ? 'https' : 'http';
    console.log(`${APP_NAME} v${APP_VERSION}`);
    console.log(`Server listening at ${proto}://localhost:${PORT}`);
    if (!useHttps) console.log('  → Add certs/localhost.pem + certs/localhost-key.pem for HTTPS (see README)');
});
