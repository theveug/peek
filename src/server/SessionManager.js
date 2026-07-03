// --- src/server/SessionManager.js ---
export class SessionManager {
    constructor() {
        this.sessions = new Map(); // sessionId -> { peers: Set, name, password }
        this.peerMap = new Map();  // peerId -> { sessionId, socket }
    }

    createSession(sessionId, { name = null, password = null, maxPeers = 6 } = {}) {
        if (!this.sessions.has(sessionId)) {
            const clampedMaxPeers = Math.min(12, Math.max(2, parseInt(maxPeers, 10) || 6));
            this.sessions.set(sessionId, { peers: new Set(), name, password, maxPeers: clampedMaxPeers, createdAt: Date.now() });
        }
    }

    // `password` only applies when the join lazily recreates a dead session — a saved
    // password-protected room recreated this way keeps its protection instead of
    // silently coming back passwordless.
    addPeer(sessionId, peerId, socket, { password = null } = {}) {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, { peers: new Set(), name: null, password, maxPeers: 6, createdAt: Date.now() });
        }
        this.sessions.get(sessionId).peers.add(peerId);
        this.peerMap.set(peerId, { sessionId, socket });
    }

    // Created-but-never-joined sessions have no peers, so removePeer() never deletes them.
    sweepEmptySessions(maxAgeMs) {
        const now = Date.now();
        for (const [id, s] of this.sessions) {
            if (s.peers.size === 0 && now - (s.createdAt || 0) > maxAgeMs) {
                this.sessions.delete(id);
            }
        }
    }

    isFull(sessionId) {
        const s = this.sessions.get(sessionId);
        if (!s) return false;
        return s.peers.size >= (s.maxPeers ?? 6);
    }

    removePeer(peerId) {
        const peerInfo = this.peerMap.get(peerId);
        if (peerInfo) {
            const { sessionId } = peerInfo;
            const session = this.sessions.get(sessionId);
            if (session) {
                session.peers.delete(peerId);
                if (session.peers.size === 0) {
                    this.sessions.delete(sessionId);
                }
            }
            this.peerMap.delete(peerId);
        }
    }

    hasSession(sessionId) {
        return this.sessions.has(sessionId);
    }

    getSessionMeta(sessionId) {
        const s = this.sessions.get(sessionId);
        if (!s) return null;
        return { name: s.name, hasPassword: !!s.password, peerCount: s.peers.size, maxPeers: s.maxPeers ?? 6 };
    }

    validatePassword(sessionId, password) {
        const s = this.sessions.get(sessionId);
        if (!s) return true;
        if (!s.password) return true;
        return s.password === password;
    }

    getPeersInSession(sessionId) {
        const s = this.sessions.get(sessionId);
        return s ? [...s.peers] : [];
    }

    getPeerSocket(peerId) {
        return this.peerMap.get(peerId)?.socket;
    }

    getSessionId(peerId) {
        return this.peerMap.get(peerId)?.sessionId;
    }
}
