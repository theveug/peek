// --- server.js ---
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { setupWebSocket } from './src/server/WebSocketServer.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';
import { Debug } from './utils/Debug.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
setupWebSocket(wss);

const activeSessions = new Set();

function generateUniqueShortCode(length = 5) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result;
    do {
        result = '';
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
        }
    } while (activeSessions.has(result));
    activeSessions.add(result);
    return result;
}

app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
app.use('/client', express.static(path.join(__dirname, 'public/client')));

// Redirect root to new session
app.get('/', (req, res) => {
    const shortCode = generateUniqueShortCode();
    Debug.log('Serving /');
    res.redirect(`/${shortCode}`);
});

app.get('/settings', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/settings.html'));
});
// Serve static index.html for session URLs
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