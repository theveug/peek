// --- src/server/SessionManager.js ---
import { timingSafeEqual, randomBytes } from 'crypto';

/**
 * All server-side room state, in-memory only — the concrete embodiment of
 * Peek's "no info held on a server" principle. A session (room) and every
 * peer's membership in it live only as long as the process runs and the
 * room stays non-empty; nothing here is ever persisted to disk or a
 * database. Two maps: `sessions` (sessionId -> room state, including
 * moderator/creator bookkeeping) and `peerMap` (peerId -> which session and
 * socket a connected peer belongs to, for O(1) reverse lookup).
 */
export class SessionManager {
    constructor() {
        this.sessions = new Map(); // sessionId -> { peers: Set, name, password }
        this.peerMap = new Map();  // peerId -> { sessionId, socket }
    }

    /**
     * Creates a session if it doesn't already exist (idempotent — a repeat
     * call for an existing sessionId is a no-op, it does not reset state).
     * @param {string} sessionId - the room code.
     * @param {object} [options]
     * @param {string|null} [options.name] - optional display name for the room.
     * @param {string|null} [options.password] - optional join password.
     * @param {number} [options.maxPeers=6] - participant cap, clamped to [2, 12].
     * @param {string|null} [options.creatorToken] - secret minted at room
     *   creation; whoever presents it via `claimModerator` becomes creator.
     * @returns {void}
     */
    createSession(sessionId, { name = null, password = null, maxPeers = 6, creatorToken = null } = {}) {
        if (!this.sessions.has(sessionId)) {
            const clampedMaxPeers = Math.min(12, Math.max(2, parseInt(maxPeers, 10) || 6));
            this.sessions.set(sessionId, { peers: new Set(), name, password, maxPeers: clampedMaxPeers, createdAt: Date.now(), creatorToken, creatorPeerId: null, moderatorPeerIds: new Set(), bannedIps: new Set(), bans: new Map() });
        }
    }

    /**
     * Registers a peer as a member of a session, lazily creating the session
     * (with default settings) if it doesn't exist yet — this is what lets a
     * room code be rejoined/recreated after it emptied out.
     *
     * `password` only applies when the join lazily recreates a dead session — a saved
     * password-protected room recreated this way keeps its protection instead of
     * silently coming back passwordless. `creatorToken` gets the same treatment: if the
     * very first joiner of a lazily-recreated session presents one (this happens when
     * the whole server process restarts — a dev deploy, a crash-restart — which wipes
     * every in-memory session, including ones that *did* go through /api/create-room),
     * it's adopted as that session's creatorToken so claimModerator() (called right
     * after this, in WebSocketServer.js's 'join' case) can succeed and the original
     * creator doesn't lose their crown just because the process happened to restart
     * between their disconnect and reconnect. Safe because the token is an unguessable
     * secret the client already held — only whoever legitimately created the room (or
     * wins the race to reconnect first after a restart, same trust level as recreating
     * a saved room today) can supply one that matches on a later claim.
     *
     * @param {string} sessionId
     * @param {string} peerId
     * @param {import('ws').WebSocket} socket
     * @param {object} [options]
     * @param {string|null} [options.password] - only applied if the session is being lazily created here.
     * @param {string|null} [options.creatorToken] - only applied if the session is being lazily created here.
     * @returns {void}
     */
    addPeer(sessionId, peerId, socket, { password = null, creatorToken = null } = {}) {
        // Lazy-create goes through createSession — a second inline session
        // literal here silently drifted from createSession's shape once
        // already (missing bannedIps, crashing recordBan in lazily-created
        // rooms), so there is deliberately only one place that builds one.
        this.createSession(sessionId, { password, creatorToken });
        this.sessions.get(sessionId).peers.add(peerId);
        this.peerMap.set(peerId, { sessionId, socket });
    }

    /** @param {string} sessionId @returns {boolean} true if the session currently exists. */
    hasSession(sessionId) {
        return this.sessions.has(sessionId);
    }

    /**
     * A peer presenting the token minted at room creation claims (or reclaims, after a
     * reconnect issues them a new peerId) creator/moderator status for that session.
     * The old creatorPeerId (stale after a reconnect) is dropped from moderatorPeerIds.
     * @param {string} sessionId
     * @param {string} peerId - the peer's current (possibly just-reconnected) ID.
     * @param {string} token - the creator token the client presents.
     * @returns {boolean} true if the token matched and creator status was (re)assigned.
     */
    claimModerator(sessionId, peerId, token) {
        const s = this.sessions.get(sessionId);
        if (!s || !s.creatorToken || !token || s.creatorToken !== token) return false;
        if (s.creatorPeerId) s.moderatorPeerIds.delete(s.creatorPeerId);
        s.creatorPeerId = peerId;
        s.moderatorPeerIds.add(peerId);
        return true;
    }

    /**
     * Broader check — creator + anyone promoted. Used for force-stop-stream and
     * crown-badge visibility. Any moderator can target any peer, including the creator.
     * @param {string} sessionId
     * @param {string} peerId
     * @returns {boolean}
     */
    isModerator(sessionId, peerId) {
        return !!this.sessions.get(sessionId)?.moderatorPeerIds.has(peerId);
    }

    /**
     * Stricter check — only the current token-holding creator. Used for kick and
     * promote/demote, both deliberately kept owner-only.
     * @param {string} sessionId
     * @param {string} peerId
     * @returns {boolean}
     */
    isCreator(sessionId, peerId) {
        return this.sessions.get(sessionId)?.creatorPeerId === peerId;
    }

    /**
     * Grants moderator status to another peer in the same room. Creator-only:
     * fails if `requesterPeerId` isn't the current creator, preventing a peer
     * from self-promoting or a non-creator moderator from promoting further.
     * @param {string} sessionId
     * @param {string} requesterPeerId
     * @param {string} targetPeerId - must already be a member of this session.
     * @returns {boolean} true if the promotion was applied.
     */
    promoteModerator(sessionId, requesterPeerId, targetPeerId) {
        const s = this.sessions.get(sessionId);
        if (!s || s.creatorPeerId !== requesterPeerId) return false;
        if (!s.peers.has(targetPeerId)) return false; // target must be in this room
        s.moderatorPeerIds.add(targetPeerId);
        return true;
    }

    /**
     * Revokes a promoted peer's moderator status. Creator-only, and the
     * creator itself can never be demoted this way.
     * @param {string} sessionId
     * @param {string} requesterPeerId
     * @param {string} targetPeerId
     * @returns {boolean} true if the demotion was applied.
     */
    demoteModerator(sessionId, requesterPeerId, targetPeerId) {
        const s = this.sessions.get(sessionId);
        if (!s || s.creatorPeerId !== requesterPeerId) return false;
        if (targetPeerId === s.creatorPeerId) return false; // can't demote the creator
        s.moderatorPeerIds.delete(targetPeerId);
        return true;
    }

    /**
     * True if the presented token matches the session's creator token — a pure
     * check with no side effects, unlike claimModerator(). Used by the ban
     * gate so the creator can never be locked out of their own room (e.g.
     * after banning someone who shares their NAT/IP).
     * @param {string} sessionId
     * @param {string|null} token
     * @returns {boolean}
     */
    isCreatorTokenValid(sessionId, token) {
        const s = this.sessions.get(sessionId);
        return !!(s && s.creatorToken && token && s.creatorToken === token);
    }

    /**
     * Remembers a banned peer's IP for the session's lifetime, so a ban can't
     * be undone by simply rejoining — peerIds are reassigned on every
     * connection, so the IP is the only server-visible identifier that
     * survives a reconnect. Ban is the sticky sibling of kick (which stays a
     * one-time removal with no memory). In-memory only, dies with the room
     * (nothing persisted, per the design principles). Best-effort by design:
     * peers behind one shared NAT share an IP, so banning one may exclude
     * others behind it — the creator-token bypass in the join gate keeps the
     * creator themselves immune.
     *
     * `nickname` is display-only, for the creator's ban-list UI (there's
     * nothing else to show — the room itself never learns anyone's identity
     * beyond a peerId) — it's supplied by the *banning* creator's client, not
     * validated, and never fed back into any authorization decision. The raw
     * IP itself is deliberately never sent to any client (see `listBans`) —
     * an opaque `banId` is the only handle the creator gets for unbanning.
     * @param {string} sessionId
     * @param {string|null|undefined} ip
     * @param {string|null} [nickname]
     * @returns {string|null} the new ban's id, or null if nothing was recorded.
     */
    recordBan(sessionId, ip, nickname = null) {
        const s = this.sessions.get(sessionId);
        if (!s || !ip) return null;
        s.bannedIps.add(ip);
        const banId = randomBytes(8).toString('hex');
        s.bans.set(banId, { ip, nickname: nickname || 'Unknown', bannedAt: Date.now() });
        return banId;
    }

    /**
     * @param {string} sessionId
     * @param {string|null|undefined} ip
     * @returns {boolean} true if this IP was banned from the session.
     */
    isBanned(sessionId, ip) {
        const s = this.sessions.get(sessionId);
        return !!(s && ip && s.bannedIps && s.bannedIps.has(ip));
    }

    /**
     * @param {string} sessionId
     * @returns {{banId: string, nickname: string, bannedAt: number}[]} newest first,
     *   IP deliberately omitted — the creator's client never needs to see it.
     */
    listBans(sessionId) {
        const s = this.sessions.get(sessionId);
        if (!s) return [];
        return [...s.bans.entries()]
            .map(([banId, b]) => ({ banId, nickname: b.nickname, bannedAt: b.bannedAt }))
            .sort((a, b) => b.bannedAt - a.bannedAt);
    }

    /**
     * Reverses a ban by its opaque id. A stale/unknown banId (already undone,
     * or from a different session) is a silent no-op.
     * @param {string} sessionId
     * @param {string} banId
     * @returns {boolean} true if a ban was actually removed.
     */
    unban(sessionId, banId) {
        const s = this.sessions.get(sessionId);
        const entry = s?.bans.get(banId);
        if (!entry) return false;
        s.bannedIps.delete(entry.ip);
        s.bans.delete(banId);
        return true;
    }

    /**
     * Deletes sessions that were created (via `/api/create-room`) but never
     * actually joined by anyone, once they're older than `maxAgeMs`.
     * Created-but-never-joined sessions have no peers, so removePeer() never deletes them.
     * @param {number} maxAgeMs
     * @returns {void}
     */
    sweepEmptySessions(maxAgeMs) {
        const now = Date.now();
        for (const [id, s] of this.sessions) {
            if (s.peers.size === 0 && now - (s.createdAt || 0) > maxAgeMs) {
                this.sessions.delete(id);
            }
        }
    }

    /**
     * @param {string} sessionId
     * @returns {boolean} true if the session is at its configured participant cap.
     */
    isFull(sessionId) {
        const s = this.sessions.get(sessionId);
        if (!s) return false;
        return s.peers.size >= (s.maxPeers ?? 6);
    }

    /**
     * Removes a peer from whatever session it belongs to (on disconnect).
     * Deletes the session entirely once its last peer leaves — this is the
     * mechanism behind "a room disappears the moment everyone leaves."
     * @param {string} peerId
     * @returns {void}
     */
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

    /**
     * @param {string} sessionId
     * @returns {boolean}
     */
    hasSession(sessionId) {
        return this.sessions.has(sessionId);
    }

    /**
     * Public-safe snapshot of a session's metadata (never includes the
     * actual password) — used to answer lobby validation requests and to
     * populate the room-info a client sees in its own `'init'` payload.
     * @param {string} sessionId
     * @returns {{name: string|null, hasPassword: boolean, peerCount: number, maxPeers: number, creatorPeerId: string|null, moderatorPeerIds: string[]}|null}
     */
    getSessionMeta(sessionId) {
        const s = this.sessions.get(sessionId);
        if (!s) return null;
        return { name: s.name, hasPassword: !!s.password, peerCount: s.peers.size, maxPeers: s.maxPeers ?? 6, creatorPeerId: s.creatorPeerId ?? null, moderatorPeerIds: [...s.moderatorPeerIds] };
    }

    /**
     * @param {string} sessionId
     * @param {string} password
     * @returns {boolean} true if the session has no password, or `password` matches it.
     */
    validatePassword(sessionId, password) {
        const s = this.sessions.get(sessionId);
        if (!s) return true;
        if (!s.password) return true;
        if (typeof password !== 'string') return false;
        // Defense-in-depth: both intake points (create-room API, WS join) only
        // store string passwords now, but a non-string here would throw in
        // Buffer.from() — inside a ws 'message' listener that's an uncaught
        // exception that kills the process. Fail closed instead.
        if (typeof s.password !== 'string') return false;
        const expected = Buffer.from(s.password);
        const given = Buffer.from(password);
        // Constant-time compare so response timing doesn't leak how much of a
        // guess matched. timingSafeEqual requires equal lengths, so a length
        // mismatch short-circuits — that only leaks the password's length.
        if (expected.length !== given.length) return false;
        return timingSafeEqual(expected, given);
    }

    /**
     * @param {string} sessionId
     * @returns {string[]} peer IDs currently in the session (empty if the session doesn't exist).
     */
    getPeersInSession(sessionId) {
        const s = this.sessions.get(sessionId);
        return s ? [...s.peers] : [];
    }

    /**
     * @param {string} peerId
     * @returns {import('ws').WebSocket|undefined}
     */
    getPeerSocket(peerId) {
        return this.peerMap.get(peerId)?.socket;
    }

    /**
     * @param {string} peerId
     * @returns {string|undefined}
     */
    getSessionId(peerId) {
        return this.peerMap.get(peerId)?.sessionId;
    }
}
