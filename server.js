// --- server.js ---
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { setupWebSocket } from './src/server/WebSocketServer.js';
import { SessionManager } from './src/server/SessionManager.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { Debug } from './utils/Debug.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
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

setupWebSocket(wss, turnConfig, manager);

function generateUniqueShortCode(length = 5) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result;
    do {
        result = '';
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
        }
    } while (manager.hasSession(result));
    return result;
}

app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
app.use('/client', express.static(path.join(__dirname, 'public/client')));

// Lobby page
app.get('/', (req, res) => {
    Debug.log('Serving lobby');
    res.sendFile(path.join(__dirname, 'public/lobby.html'));
});

// API: Create room
app.post('/api/create-room', (req, res) => {
    const { name, password } = req.body || {};
    const code = generateUniqueShortCode();
    const cleanName = name ? name.replace(/[<>]/g, '').trim().substring(0, 50) : null;
    manager.createSession(code, { name: cleanName || null, password: password || null });
    Debug.log(`Room created: ${code}${cleanName ? ` (${cleanName})` : ''}${password ? ' [password]' : ''}`);
    res.json({ code });
});

// API: Validate room (check if it exists / needs password)
app.post('/api/validate-room', (req, res) => {
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
    res.json({ valid: true, needsPassword: false, name: meta.name });
});

app.get('/settings', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/settings.html'));
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
server.listen(PORT, () => {
    console.log(`Server listening at http://localhost:${PORT}`);
});
