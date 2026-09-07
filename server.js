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
import { Debug, DEBUG_ENABLED } from './utils/Debug.js';
import { rateLimit } from './src/server/rateLimit.js';
import { openDb } from './src/server/db/connection.js';
import { runMigrations } from './src/server/db/migrate.js';
import { AuthManager } from './src/server/AuthManager.js';
import { mountAuthRoutes } from './src/server/authRoutes.js';
import { FriendsManager } from './src/server/FriendsManager.js';
import { mountFriendsRoutes } from './src/server/friendsRoutes.js';
import { DirectMessagesManager } from './src/server/DirectMessagesManager.js';
import { mountMessagesRoutes } from './src/server/messagesRoutes.js';

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

// Accounts (Phase 1: register/login/logout + SQLite storage) — strictly
// opt-in per deployment, never on by default. An unset ACCOUNTS_ENABLED
// leaves this whole branch unexecuted: no DB file created, no routes
// mounted, trust.accounts stays false — byte-for-byte today's behavior. See
// CLAUDE.md's accounts/design-principles entry for why this stays an
// explicit per-operator choice rather than something Peek itself runs.
const accountsEnabled = process.env.ACCOUNTS_ENABLED === '1';
let authManager = null;
let friendsManager = null;
let messagesManager = null;
let accountsDb = null; // hoisted so the graceful-shutdown handler below can close it
if (accountsEnabled) {
    const db = openDb(process.env.ACCOUNTS_DB_PATH || './data/peek.db');
    accountsDb = db;
    runMigrations(db);
    authManager = new AuthManager(db);
    friendsManager = new FriendsManager(db);
    messagesManager = new DirectMessagesManager(db);
    if (!useHttps && !process.env.TRUST_PROXY) {
        console.warn('[WARN] ACCOUNTS_ENABLED=1 but no HTTPS cert and no TRUST_PROXY configured — ' +
            'session cookies will be sent over plain HTTP. Fine on a trusted LAN, not recommended otherwise.');
    }
    Debug.log('Accounts enabled, DB at', process.env.ACCOUNTS_DB_PATH || './data/peek.db');
}
// mountAuthRoutes() itself is called after app.use(express.json()) below —
// route registration order matters in Express, and these handlers need
// req.body already parsed (see the express.json() call site).

// Deployment-level "trust tier" descriptor — what THIS server does,
// independent of any room's state (sibling to iceServers/buildId on init,
// not part of getSessionMeta()). serverSideHistory now reflects reality
// (2026-09-07, accounts Phase 4): direct messages persist plaintext message
// content server-side, so this can no longer stay hardcoded false once that
// ships. Tied to the same accountsEnabled gate rather than a separate flag —
// DMs only ever exist under that same opt-in, there's no independent
// "messages enabled" toggle. debugLogging/mediaRelayConfigured are real,
// already-computed facts. See CLAUDE.md's "Trust-tier indicator" convention.
const trust = {
    accounts: accountsEnabled,
    serverSideHistory: accountsEnabled,
    debugLogging: DEBUG_ENABLED,
    mediaRelayConfigured: !!turnConfig,
};

// Identifies this running process to connected clients so they can tell when
// they're talking to a stale client build after a deploy/restart. Generated
// fresh every process start — no manual version bump required to "just know".
const APP_VERSION = process.env.APP_VERSION || '0.0.0';
const BUILD_ID = `${APP_VERSION}-${Date.now()}`;

setupWebSocket(wss, { turnConfig, stunUrl }, manager, BUILD_ID, trust);

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
// is 'self' only: per CSP3, 'self' already covers a same-origin ws:/wss: upgrade
// (http↔ws, https↔wss on the same host+port), which is the only socket the app
// ever opens. This once listed bare ws:/wss:, which ALSO allowed connections to
// any host — a needless exfiltration lane behind the otherwise-strict script-src
// (tightened 2026-07-14, verified by tests/offline-selfhost.mjs driving a real
// in-browser room connection with zero CSP violations). img-src allows blob: for
// received file-image previews. Any new external resource will be blocked until
// it's self-hosted — that's the point. 'wasm-unsafe-eval' (added 2026-07-09 for
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
        "connect-src 'self'",
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
if (accountsEnabled) {
    mountAuthRoutes(app, authManager);
    mountFriendsRoutes(app, authManager, friendsManager);
    mountMessagesRoutes(app, authManager, messagesManager);
}
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
app.use('/client', express.static(path.join(__dirname, 'public/client')));

// Lobby page
app.get('/', (req, res) => {
    Debug.log('Serving lobby');
    res.sendFile(path.join(__dirname, 'public/lobby.html'));
});

// API: Create room
app.post('/api/create-room', rateLimit(60_000, 10), (req, res) => {
    const { name, password, maxPeers, micPolicy, topic } = req.body || {};
    const code = generateUniqueShortCode();
    // JSON bodies can carry any type — a non-string password stored here used
    // to reach Buffer.from() in validatePassword and throw (a process-killing
    // uncaught exception on the WS join path). Only strings are ever stored.
    const cleanName = typeof name === 'string' ? name.replace(/[<>]/g, '').trim().substring(0, 50) : null;
    const cleanPassword = (typeof password === 'string' && password) ? password.slice(0, 200) : null;
    const cleanTopic = typeof topic === 'string' ? topic.replace(/[<>]/g, '').trim().substring(0, 120) : null;
    const creatorToken = randomBytes(16).toString('hex');
    // micPolicy is allowlisted inside createSession (anything not 'ptt' → 'open').
    manager.createSession(code, { name: cleanName || null, password: cleanPassword, maxPeers, creatorToken, micPolicy, topic: cleanTopic || null });
    Debug.log(`Room created: ${code}${cleanName ? ` (${cleanName})` : ''}${password ? ' [password]' : ''}`);
    res.json({ code, creatorToken });
});

// Failed-password lockout for the HTTP validation path, mirroring the WS
// join throttle (WebSocketServer.js's failedJoinsByIp): the generic 30/min
// request limiter alone let this endpoint act as a sustained password oracle
// (~43k guesses/day/IP) while the WS side was capped at 20 per 10 minutes.
// Same fixed-window in-memory shape, nothing persisted.
const FAILED_VALIDATE_LIMIT = 20;
const failedValidationsByIp = new Map();
setInterval(() => failedValidationsByIp.clear(), 10 * 60_000).unref();

// API: Validate room (check if it exists / needs password)
app.post('/api/validate-room', rateLimit(60_000, 30), (req, res) => {
    const { code, password } = req.body || {};
    const meta = manager.getSessionMeta(code);
    if (!meta) {
        res.json({ valid: true, needsPassword: false, name: null });
        return;
    }
    if (meta.hasPassword && (failedValidationsByIp.get(req.ip) || 0) >= FAILED_VALIDATE_LIMIT) {
        res.status(429).json({ error: 'Too many password attempts' });
        return;
    }
    if (meta.hasPassword && !password) {
        res.json({ valid: false, needsPassword: true, name: meta.name });
        return;
    }
    if (meta.hasPassword && !manager.validatePassword(code, typeof password === 'string' ? password : null)) {
        failedValidationsByIp.set(req.ip, (failedValidationsByIp.get(req.ip) || 0) + 1);
        res.json({ valid: false, needsPassword: true, name: meta.name, wrongPassword: true });
        return;
    }
    if (manager.isFull(code)) {
        res.json({ valid: false, needsPassword: false, full: true, name: meta.name });
        return;
    }
    res.json({ valid: true, needsPassword: false, name: meta.name });
});

// API: Live status for saved rooms (lobby sidebar badges) — reads only the
// in-memory session state getSessionMeta() already exposes for validate-room;
// nothing new is stored or tracked server-side. Projects down to the minimum
// public-safe fields (no creatorPeerId/moderatorPeerIds/name/hasPassword).
const MAX_STATUS_CODES = 50;
const ROOM_CODE_RE = /^[A-Za-z0-9]{5}$/;
app.post('/api/room-status', rateLimit(60_000, 40), (req, res) => {
    const { codes } = req.body || {};
    if (!Array.isArray(codes)) {
        res.json({ statuses: {} });
        return;
    }
    const statuses = {};
    for (const code of codes.slice(0, MAX_STATUS_CODES)) {
        if (typeof code !== 'string' || !ROOM_CODE_RE.test(code)) continue;
        const meta = manager.getSessionMeta(code);
        statuses[code] = meta
            ? { active: true, peerCount: meta.peerCount, maxPeers: meta.maxPeers }
            : { active: false };
    }
    res.json({ statuses });
});

// Retired standalone settings page — settings now live in a single overlay
// reachable from the lobby and in-room (see public/client/SettingsPanel.js).
// Redirect old bookmarked URLs instead of 404ing.
app.get('/settings', (req, res) => {
    res.redirect('/');
});

// Exposes the same deployment-level trust descriptor already sent (unauthenticated)
// on every WS 'init' — the lobby has no WebSocket connection at all, so it has no
// other way to know whether this deployment has accounts turned on before deciding
// whether to show the account button. Cheap constant lookup, no rate limit needed
// for the same reason the WS init payload isn't rate-limited per field.
app.get('/api/trust', (req, res) => {
    res.json(trust);
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
// Undefined (default) binds all interfaces, same as before this existed.
// An embedder that fronts this process with its own HTTP-level reverse
// proxy can set this to '127.0.0.1' so the raw server is never reachable
// except through that proxy — load-bearing for TRUST_PROXY above: trusting
// X-Forwarded-For is only safe when the proxy is the sole way in. Left
// unset by embedders exposing this process directly (e.g. peek-desktop's
// "Host a Room", reachable over LAN and via router port-forwarding, with no
// proxy in front at all) — those must also leave TRUST_PROXY unset, since
// there's no proxy to trust a forwarded-for header from.
const HOST = process.env.HOST || undefined;

server.listen(PORT, HOST, () => {
    const proto = useHttps ? 'https' : 'http';
    // server.address().port (not the PORT var) so PORT=0's OS-assigned port
    // shows up correctly here too, not just in the machine-readable line below.
    const boundPort = server.address().port;
    console.log(`${APP_NAME} v${APP_VERSION}`);
    console.log(`Server listening at ${proto}://${HOST || 'localhost'}:${boundPort}`);
    if (!useHttps) console.log('  → Add certs/localhost.pem + certs/localhost-key.pem for HTTPS (see README)');
    // Machine-readable readiness signal, deliberately separate from the
    // human-facing lines above — lets an embedder spawn with PORT=0 and
    // learn the OS-assigned port with no bind/probe/close/reopen dance, and
    // no need to parse the human log lines (which can change wording).
    console.log(`__PEEK_READY__ ${JSON.stringify({ port: server.address().port })}`);
});

// Without this, every stop of the process (Ctrl+C, nodemon restart, a
// container/orchestrator SIGTERM) is a hard kill with no chance for
// better-sqlite3 to run its close-time WAL checkpoint — under WAL mode
// (openDb()'s default), committed writes live ONLY in the `-wal` file until
// something checkpoints them back into the main `.db` file, and SQLite's own
// automatic checkpoint threshold (~1000 WAL pages) is rarely reached by a
// small dev database's light write volume. A hard kill at exactly the wrong
// moment mid-write can leave the WAL unable to validate on the next open,
// which SQLite handles safely by discarding it — but "safely" here means
// silently reverting to whatever the last checkpoint captured, which for a
// dev DB that's never been gracefully closed can be nothing at all. `db.close()`
// forces a full checkpoint, so a normal shutdown never strands data in the WAL.
function shutdown() {
    if (accountsDb) accountsDb.close();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
