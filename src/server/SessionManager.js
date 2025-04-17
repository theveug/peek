// --- src/server/SessionManager.js ---
export class SessionManager {
    constructor() {
        this.sessions = new Map(); // sessionId -> Set of peers
        this.peerMap = new Map();  // peerId -> { sessionId, socket }
    }

    addPeer(sessionId, peerId, socket) {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, new Set());
        }
        this.sessions.get(sessionId).add(peerId);
        this.peerMap.set(peerId, { sessionId, socket });
    }

    removePeer(peerId) {
        const peerInfo = this.peerMap.get(peerId);
        if (peerInfo) {
            const { sessionId } = peerInfo;
            const session = this.sessions.get(sessionId);
            if (session) {
                session.delete(peerId);
                if (session.size === 0) {
                    this.sessions.delete(sessionId);
                }
            }
            this.peerMap.delete(peerId);
        }
    }

    getPeersInSession(sessionId) {
        return this.sessions.has(sessionId) ? [...this.sessions.get(sessionId)] : [];
    }

    getPeerSocket(peerId) {
        return this.peerMap.get(peerId)?.socket;
    }

    getSessionId(peerId) {
        return this.peerMap.get(peerId)?.sessionId;
    }
}