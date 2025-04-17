// --- src/server/WebSocketServer.js ---
import { v4 as uuidv4 } from 'uuid';
import { SessionManager } from './SessionManager.js';

const manager = new SessionManager();

export function setupWebSocket(wss) {
    wss.on('connection', (ws) => {
        const peerId = uuidv4();

        ws.on('message', (data) => {
            let msg;
            try {
                msg = JSON.parse(data);
            } catch (e) {
                console.error('Invalid JSON:', data);
                return;
            }

            const { type, sessionId, to, payload, text } = msg;

            switch (type) {
                case 'join': {
                    manager.addPeer(sessionId, peerId, ws);
                    const peers = manager.getPeersInSession(sessionId).filter(p => p !== peerId);

                    // Notify new peer of their ID and existing peers
                    ws.send(JSON.stringify({ type: 'init', peerId, peers }));

                    // Notify others of new peer
                    peers.forEach(pid => {
                        const socket = manager.getPeerSocket(pid);
                        if (socket) {
                            socket.send(JSON.stringify({ type: 'peer-joined', peerId }));
                        }
                    });
                    break;
                }

                case 'offer':
                case 'answer':
                case 'ice-candidate': {
                    const target = manager.getPeerSocket(to);
                    if (target) {
                        target.send(JSON.stringify({ type, from: peerId, payload }));
                    }
                    break;
                }

                case 'chat': {
                    const sessionId = manager.getSessionId(peerId);
                    const peers = manager.getPeersInSession(sessionId);
                    const nickname = msg.nickname.replace(/[^a-zA-Z0-9-_]/g,'') || 'Anonymous';

                    peers.forEach(pid => {
                        const socket = manager.getPeerSocket(pid);
                        if (socket) {
                            socket.send(JSON.stringify({ type: 'chat', from: peerId, text, nickname }));
                        }
                    });
                    break;
                }

                case 'stop-sharing': {
                    const sessionId = manager.getSessionId(peerId);
                    const peers = manager.getPeersInSession(sessionId).filter(id => id !== peerId);
                    peers.forEach(pid => {
                        const socket = manager.getPeerSocket(pid);
                        if (socket) {
                            socket.send(JSON.stringify({ type: 'stop-sharing', from: peerId }));
                        }
                    });
                    break;
                }
            }
        });

        ws.on('close', () => {
            const sessionId = manager.getSessionId(peerId);
            manager.removePeer(peerId);

            const peers = manager.getPeersInSession(sessionId);
            peers.forEach(pid => {
                const socket = manager.getPeerSocket(pid);
                if (socket) {
                    socket.send(JSON.stringify({ type: 'peer-left', peerId }));
                }
            });
        });
    });
}
