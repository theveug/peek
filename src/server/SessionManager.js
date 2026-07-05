// --- src/server/SessionManager.js ---
import { timingSafeEqual } from 'crypto';

export class SessionManager {
    constructor() {
        this.sessions = new Map(); // sessionId -> { peers: Set, name, password }
        this.peerMap = new Map();  // peerId -> { sessionId, socket }
    }

    createSession(sessionId, { name = null, password = null, maxPeers = 6, creatorToken = null } = {}) {
        if (!this.sessions.has(sessionId)) {
            const clampedMaxPeers = Math.min(12, Math.max(2, parseInt(maxPeers, 10) || 6));
            this.sessions.set(sessionId, { peers: new Set(), name, password, maxPeers: clampedMaxPeers, createdAt: Date.now(), creatorToken, creatorPeerId: null, moderatorPeerIds: new Set() });
        }
    }

    // `password` only applies when the join lazily recreates a dead session — a saved
    // password-protected room recreated this way keeps its protection instead of
    // silently coming back passwordless. `creatorToken` gets the same treatment: if the
    // very first joiner of a lazily-recreated session presents one (this happens when
    // the whole server process restarts — a dev deploy, a crash-restart — which wipes
    // every in-memory session, including ones that *did* go through /api/create-room),
    // it's adopted as that session's creatorToken so claimModerator() (called right
    // after this, in WebSocketServer.js's 'join' case) can succeed and the original
    // creator doesn't lose their crown just because the process happened to restart
    // between their disconnect and reconnect. Safe because the token is an unguessable
    // secret the client already held — only whoever legitimately created the room (or
    // wins the race to reconnect first after a restart, same trust level as recreating
    // a saved room today) can supply one that matches on a later claim.
    addPeer(sessionId, peerId, socket, { password = null, creatorToken = null } = {}) {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, { peers: new Set(), name: null, password, maxPeers: 6, createdAt: Date.now(), creatorToken, creatorPeerId: null, moderatorPeerIds: new Set() });
        }
        this.sessions.get(sessionId).peers.add(peerId);
        this.peerMap.set(peerId, { sessionId, socket });
    }

    // A peer presenting the token minted at room creation claims (or reclaims, after a
    // reconnect issues them a new peerId) creator/moderator status for that session.
    // The old creatorPeerId (stale after a reconnect) is dropped from moderatorPeerIds.
    claimModerator(sessionId, peerId, token) {
        const s = this.sessions.get(sessionId);
        if (!s || !s.creatorToken || !token || s.creatorToken !== token) return false;
        if (s.creatorPeerId) s.moderatorPeerIds.delete(s.creatorPeerId);
        s.creatorPeerId = peerId;
        s.moderatorPeerIds.add(peerId);
        return true;
    }

    // Broader check — creator + anyone promoted. Used for force-stop-stream and
    // crown-badge visibility. Any moderator can target any peer, including the creator.
    isModerator(sessionId, peerId) {
        return !!this.sessions.get(sessionId)?.moderatorPeerIds.has(peerId);
    }

    // Stricter check — only the current token-holding creator. Used for kick and
    // promote/demote, both deliberately kept owner-only.
    isCreator(sessionId, peerId) {
        return this.sessions.get(sessionId)?.creatorPeerId === peerId;
    }

    promoteModerator(sessionId, requesterPeerId, targetPeerId) {
        const s = this.sessions.get(sessionId);
        if (!s || s.creatorPeerId !== requesterPeerId) return false;
        if (!s.peers.has(targetPeerId)) return false; // target must be in this room
        s.moderatorPeerIds.add(targetPeerId);
        return true;
    }

    demoteModerator(sessionId, requesterPeerId, targetPeerId) {
        const s = this.sessions.get(sessionId);
        if (!s || s.creatorPeerId !== requesterPeerId) return false;
        if (targetPeerId === s.creatorPeerId) return false; // can't demote the creator
        s.moderatorPeerIds.delete(targetPeerId);
        return true;
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
                // Promotion is session-lifetime only, not reconnect-durable (a promoted
                // peer has no token to reclaim it with) — drop it on disconnect. The
                // creator's own entry is re-added by claimModerator() on their reconnect.
                session.moderatorPeerIds.delete(peerId);
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
        return { name: s.name, hasPassword: !!s.password, peerCount: s.peers.size, maxPeers: s.maxPeers ?? 6, creatorPeerId: s.creatorPeerId ?? null, moderatorPeerIds: [...s.moderatorPeerIds] };
    }

    validatePassword(sessionId, password) {
        const s = this.sessions.get(sessionId);
        if (!s) return true;
        if (!s.password) return true;
        if (typeof password !== 'string') return false;
        const expected = Buffer.from(s.password);
        const given = Buffer.from(password);
        // Constant-time compare so response timing doesn't leak how much of a
        // guess matched. timingSafeEqual requires equal lengths, so a length
        // mismatch short-circuits — that only leaks the password's length.
        if (expected.length !== given.length) return false;
        return timingSafeEqual(expected, given);
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
