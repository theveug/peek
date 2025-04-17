// --- server.js ---
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { setupWebSocket } from './src/server/WebSocketServer.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
setupWebSocket(wss);

app.use(express.static(path.join(__dirname, 'public')));

// Redirect root to new session
app.get('/', (req, res) => {
    const newSessionId = uuidv4();
    res.redirect(`/session/${newSessionId}`);
});

// Serve static index.html for session URLs
app.get('/session/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening at http://localhost:${PORT}`);
});