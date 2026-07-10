// --- src/server/WebSocketServer.js ---
import { v4 as uuidv4 } from 'uuid';
import { createHmac } from 'crypto';

// No hardcoded public STUN (this used to default to Google's) — every
// participant's IP pinging a third party on each call cut against the
// privacy ethos, and on a disconnected LAN host candidates alone are enough
// for the mesh to form. STUN_URL is opt-in for internet deployments without
// TURN; a TURN allocation already yields the server-reflexive candidate, so
// TURN deployments don't need a separate STUN entry either.
function generateIceServers({ turnConfig, stunUrl }) {
    const servers = [];

    if (stunUrl) {
        servers.push({ urls: stunUrl });
    }

    if (turnConfig) {
        // Short-lived on purpose: these creds let the holder relay arbitrary
        // traffic through our TURN server, and anyone who joins any room once
        // receives a set. 2h covers any real session without leaving a wide
        // free-relay window open per join.
        const ttl = 2 * 60 * 60;
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

export function setupWebSocket(wss, iceConfig, manager, buildId) {
    const PING_INTERVAL = 30_000;

    // The per-connection failedJoins counter alone isn't enough — it resets on
    // every new socket, so a script could brute-force passwords 5 at a time by
    // reconnecting. Track failures per IP too, fixed-window like server.js's
    // HTTP rateLimit(). In-memory only, cleared wholesale each window.
    const FAILED_JOIN_LIMIT = 20;
    const failedJoinsByIp = new Map();
    const failedJoinsTimer = setInterval(() => failedJoinsByIp.clear(), 10 * 60_000);

    const pingTimer = setInterval(() => {
        wss.clients.forEach(ws => {
            if (ws.isAlive === false) return ws.terminate();
            ws.isAlive = false;
            ws.ping();
        });
    }, PING_INTERVAL);

    wss.on('close', () => {
        clearInterval(pingTimer);
        clearInterval(failedJoinsTimer);
    });

    // Mirrors Express's TRUST_PROXY opt-in (server.js) for the WS-side per-IP
    // throttle — without it, behind a reverse proxy every client shares the
    // proxy's address and one brute-forcer locks everyone out of password joins.
    const trustProxy = !!process.env.TRUST_PROXY;

    wss.on('connection', (ws, req) => {
        const forwardedFor = trustProxy ? req.headers['x-forwarded-for'] : null;
        const ip = forwardedFor ? String(forwardedFor).split(',')[0].trim() : req.socket.remoteAddress;
        // Stamped on the socket so the 'kick' case (which runs in the *kicker's*
        // connection scope) can read the kick target's IP for the sticky-kick set.
        ws.clientIp = ip;
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

            const { type, sessionId, to, payload } = msg;

            switch (type) {
                case 'join': {
                    // Same format the /:code route enforces — without this, a raw WS client
                    // can lazily create unbounded sessions keyed by arbitrary strings.
                    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9]{5}$/.test(sessionId)) {
                        ws.send(JSON.stringify({ type: 'join-error', reason: 'invalid-room' }));
                        return;
                    }

                    if ((failedJoinsByIp.get(ip) || 0) >= FAILED_JOIN_LIMIT) {
                        ws.send(JSON.stringify({ type: 'join-error', reason: 'invalid-password' }));
                        ws.close();
                        return;
                    }

                    // Sticky kick: a kicked IP stays out for the rest of the session's
                    // lifetime (the set dies with the room). The creator token bypasses
                    // the gate so the creator can never lock themselves out by kicking
                    // someone who shares their NAT/IP.
                    if (manager.isKickBanned(sessionId, ip) && !manager.isCreatorTokenValid(sessionId, msg.creatorToken || null)) {
                        ws.send(JSON.stringify({ type: 'join-error', reason: 'kicked' }));
                        ws.close();
                        return;
                    }

                    if (!manager.validatePassword(sessionId, msg.password || null)) {
                        ws.send(JSON.stringify({ type: 'join-error', reason: 'invalid-password' }));
                        failedJoinsByIp.set(ip, (failedJoinsByIp.get(ip) || 0) + 1);
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

                    manager.addPeer(sessionId, peerId, ws, { password: msg.password || null, creatorToken: msg.creatorToken || null });
                    const peers = manager.getPeersInSession(sessionId).filter(p => p !== peerId);

                    // A claim can flip creatorPeerId/moderatorPeerIds, so this must run
                    // before reading getSessionMeta() below for the init payload to reflect it.
                    const claimedModerator = msg.creatorToken ? manager.claimModerator(sessionId, peerId, msg.creatorToken) : false;
                    const meta = manager.getSessionMeta(sessionId);

                    const iceServers = generateIceServers(iceConfig);
                    ws.send(JSON.stringify({ type: 'init', peerId, peers, iceServers, roomName: meta?.name || null, hasPassword: !!meta?.hasPassword, maxPeers: meta?.maxPeers || 6, creatorPeerId: meta?.creatorPeerId || null, moderatorPeerIds: meta?.moderatorPeerIds || [], buildId }));

                    peers.forEach(pid => {
                        const socket = manager.getPeerSocket(pid);
                        if (socket) {
                            socket.send(JSON.stringify({ type: 'peer-joined', peerId }));
                            if (claimedModerator) {
                                socket.send(JSON.stringify({ type: 'moderator-update', creatorPeerId: meta?.creatorPeerId || null, moderatorPeerIds: meta?.moderatorPeerIds || [] }));
                            }
                        }
                    });
                    break;
                }

                case 'offer':
                case 'answer':
                case 'ice-candidate':
                case 'watch-stream':
                case 'unwatch-stream': {
                    // Only relay within the sender's own session — peerIds are global
                    // (and survive a same-socket room change), so without this any
                    // client could push signalling at peers in other rooms.
                    const sessionId = manager.getSessionId(peerId);
                    if (!sessionId || manager.getSessionId(to) !== sessionId) break;
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

                // Moderator-only actions — enforcement lives entirely here, not in the
                // client UI (which just hides these controls from non-moderators). A
                // sender who never claimed moderator status via a valid creatorToken is
                // silently ignored.
                case 'force-stop-stream': {
                    const sessionId = manager.getSessionId(peerId);
                    if (!manager.isModerator(sessionId, peerId)) break;
                    if (manager.getSessionId(to) !== sessionId) break;
                    const target = manager.getPeerSocket(to);
                    if (target) {
                        target.send(JSON.stringify({ type: 'force-stop-stream', from: peerId }));
                    }
                    break;
                }

                // Kick stays owner-only (isCreator, not the broader isModerator) — a
                // promoted moderator can stop anyone's stream (including the creator's)
                // but cannot remove anyone from the room.
                case 'kick': {
                    const sessionId = manager.getSessionId(peerId);
                    if (!manager.isCreator(sessionId, peerId)) break;
                    if (manager.getSessionId(to) !== sessionId) break;
                    const target = manager.getPeerSocket(to);
                    if (target) {
                        manager.recordKick(sessionId, target.clientIp);
                        target.send(JSON.stringify({ type: 'kicked' }));
                        target.close();
                    }
                    break;
                }

                // Promote/demote are also owner-only — SessionManager's methods already
                // re-check isCreator internally, but checking here too avoids doing any
                // work (or broadcasting) for an unauthorized request.
                case 'promote-moderator': {
                    const sessionId = manager.getSessionId(peerId);
                    if (!manager.promoteModerator(sessionId, peerId, to)) break;
                    const meta = manager.getSessionMeta(sessionId);
                    manager.getPeersInSession(sessionId).forEach(pid => {
                        const socket = manager.getPeerSocket(pid);
                        if (socket) {
                            socket.send(JSON.stringify({ type: 'moderator-update', creatorPeerId: meta?.creatorPeerId || null, moderatorPeerIds: meta?.moderatorPeerIds || [] }));
                        }
                    });
                    break;
                }

                case 'demote-moderator': {
                    const sessionId = manager.getSessionId(peerId);
                    if (!manager.demoteModerator(sessionId, peerId, to)) break;
                    const meta = manager.getSessionMeta(sessionId);
                    manager.getPeersInSession(sessionId).forEach(pid => {
                        const socket = manager.getPeerSocket(pid);
                        if (socket) {
                            socket.send(JSON.stringify({ type: 'moderator-update', creatorPeerId: meta?.creatorPeerId || null, moderatorPeerIds: meta?.moderatorPeerIds || [] }));
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
