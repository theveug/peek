// --- src/server/WebSocketServer.js ---
import { v4 as uuidv4 } from 'uuid';
import { createHmac } from 'crypto';

function generateIceServers(turnConfig) {
    const servers = [{ urls: 'stun:stun.l.google.com:19302' }];

    if (turnConfig) {
        const ttl = 24 * 60 * 60;
        const expiry = Math.floor(Date.now() / 1000) + ttl;
        const username = `${expiry}:peek`;
        const credential = createHmac('sha1', turnConfig.secret)
            .update(username)
            .digest('base64');

        servers.push({
            urls: [turnConfig.url, `${turnConfig.url}?transport=tcp`],
            username,
            credential,
        });
    }

    return servers;
}

export function setupWebSocket(wss, turnConfig, manager, buildId) {
    const PING_INTERVAL = 30_000;

    const pingTimer = setInterval(() => {
        wss.clients.forEach(ws => {
            if (ws.isAlive === false) return ws.terminate();
            ws.isAlive = false;
            ws.ping();
        });
    }, PING_INTERVAL);

    wss.on('close', () => clearInterval(pingTimer));

    wss.on('connection', (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        const peerId = uuidv4();
        let failedJoins = 0;

        ws.on('message', (data) => {
            let msg;
            try {
                msg = JSON.parse(data);
            } catch (e) {
                console.error('Invalid JSON:', data);
                return;
            }

            const { type, sessionId, to, payload, text, messageId } = msg;

            switch (type) {
                case 'join': {
                    // Same format the /:code route enforces — without this, a raw WS client
                    // can lazily create unbounded sessions keyed by arbitrary strings.
                    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9]{5}$/.test(sessionId)) {
                        ws.send(JSON.stringify({ type: 'join-error', reason: 'invalid-room' }));
                        return;
                    }

                    if (!manager.validatePassword(sessionId, msg.password || null)) {
                        ws.send(JSON.stringify({ type: 'join-error', reason: 'invalid-password' }));
                        if (++failedJoins >= 5) ws.close();
                        return;
                    }

                    if (manager.isFull(sessionId)) {
                        ws.send(JSON.stringify({ type: 'join-error', reason: 'room-full' }));
                        return;
                    }

                    // A second join on the same connection would leave a ghost entry in the
                    // first session's peer set (removePeer on close only cleans the current one).
                    const prevSessionId = manager.getSessionId(peerId);
                    if (prevSessionId) {
                        manager.removePeer(peerId);
                        manager.getPeersInSession(prevSessionId).forEach(pid => {
                            const socket = manager.getPeerSocket(pid);
                            if (socket) {
                                socket.send(JSON.stringify({ type: 'peer-left', peerId }));
                            }
                        });
                    }

                    manager.addPeer(sessionId, peerId, ws, { password: msg.password || null });
                    const peers = manager.getPeersInSession(sessionId).filter(p => p !== peerId);
                    const meta = manager.getSessionMeta(sessionId);

                    const iceServers = generateIceServers(turnConfig);
                    ws.send(JSON.stringify({ type: 'init', peerId, peers, iceServers, roomName: meta?.name || null, hasPassword: !!meta?.hasPassword, maxPeers: meta?.maxPeers || 6, buildId }));

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
                case 'ice-candidate':
                case 'watch-stream':
                case 'unwatch-stream': {
                    const target = manager.getPeerSocket(to);
                    if (target) {
                        target.send(JSON.stringify({ type, from: peerId, payload }));
                    }
                    break;
                }

                case 'start-sharing':
                case 'stop-sharing':
                case 'webcam-start':
                case 'webcam-stop':
                case 'mic-status':
                case 'deafen-status':
                case 'nickname-update':
                case 'status-update': {
                    const sessionId = manager.getSessionId(peerId);
                    const peers = manager.getPeersInSession(sessionId).filter(id => id !== peerId);
                    peers.forEach(pid => {
                        const socket = manager.getPeerSocket(pid);
                        if (socket) {
                            socket.send(JSON.stringify({ type, from: peerId, payload }));
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
