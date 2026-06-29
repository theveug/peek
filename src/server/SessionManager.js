// --- src/server/SessionManager.js ---
export class SessionManager {
    constructor() {
        this.sessions = new Map(); // sessionId -> { peers: Set, name, password }
        this.peerMap = new Map();  // peerId -> { sessionId, socket }
    }

    createSession(sessionId, { name = null, password = null } = {}) {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, { peers: new Set(), name, password });
        }
    }

    addPeer(sessionId, peerId, socket) {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, { peers: new Set(), name: null, password: null });
        }
        this.sessions.get(sessionId).peers.add(peerId);
        this.peerMap.set(peerId, { sessionId, socket });
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
        return { name: s.name, hasPassword: !!s.password, peerCount: s.peers.size };
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
