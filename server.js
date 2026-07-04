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
const wss = new WebSocketServer({ server });

const manager = new SessionManager();

const turnConfig = (process.env.TURN_URL && process.env.TURN_SECRET)
    ? { url: process.env.TURN_URL, secret: process.env.TURN_SECRET }
    : null;

if (turnConfig) {
    Debug.log('TURN server configured:', turnConfig.url);
} else {
    Debug.log('No TURN server configured — STUN only');
}

// Identifies this running process to connected clients so they can tell when
// they're talking to a stale client build after a deploy/restart. Generated
// fresh every process start — no manual version bump required to "just know".
const APP_VERSION = process.env.APP_VERSION || '0.0.0';
const BUILD_ID = `${APP_VERSION}-${Date.now()}`;

setupWebSocket(wss, turnConfig, manager, BUILD_ID);

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
