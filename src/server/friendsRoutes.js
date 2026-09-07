// --- src/server/friendsRoutes.js ---
// Accounts Phase 2: mounts /api/friends/* — only ever called from server.js's
// ACCOUNTS_ENABLED branch, right alongside mountAuthRoutes(). Each route
// repeats the same inline session check authRoutes.js's own routes use
// (never factored into shared middleware there), for consistency rather
// than introducing a different pattern for one new file.
import { rateLimit } from './rateLimit.js';
import { readCookie, COOKIE_NAME } from './authRoutes.js';

const REASON_MESSAGES = {
    self: "You can't friend yourself",
    not_found: 'No account with that username',
    already_friends: 'Already friends',
    already_pending: 'Friend request already pending',
};

// Reused for both block reasons — blockUser() only ever returns 'self' or
// 'not_found' (never the friend-request-specific reasons above).
const BLOCK_REASON_MESSAGES = {
    self: "You can't block yourself",
    not_found: 'No account with that username',
};

function requireSession(req, authManager) {
    const token = readCookie(req, COOKIE_NAME);
    return token ? authManager.validateSessionToken(token) : null;
}

// Keyed by the raw session token where present, not by IP (2026-09-07
// real-usage audit fix) — every route here is session-authenticated, and
// keying by IP meant two friends behind the same NAT/office network shared
// one bucket, able to throttle each other's legitimate requests. Falls back
// to IP for an unauthenticated/expired cookie, same as before. The token
// itself is never persisted by this limiter — it's just used as an in-memory
// map key for the current fixed window.
const byAccount = (req) => readCookie(req, COOKIE_NAME) || req.ip;

// Accounts Phase 3 (2026-09-07): 3x the client's poll interval
// (presencePoll.js's 30s) — tolerates one missed beat (a slow tick, a
// backgrounded-tab pause resuming late) without flickering a friend
// offline and back on every poll cycle.
const ONLINE_THRESHOLD_MS = 90_000;

/**
 * @param {import('express').Express} app
 * @param {import('./AuthManager.js').AuthManager} authManager
 * @param {import('./FriendsManager.js').FriendsManager} friendsManager
 */
export function mountFriendsRoutes(app, authManager, friendsManager) {
    app.get('/api/friends', rateLimit(60_000, 60, byAccount), (req, res) => {
        const session = requireSession(req, authManager);
        if (!session) return res.status(401).json({ error: 'Not logged in' });
        const { incoming, outgoing } = friendsManager.listPending(session.userId);
        res.status(200).json({
            friends: friendsManager.listFriends(session.userId),
            incoming,
            outgoing,
            blocked: friendsManager.listBlocked(session.userId),
        });
    });

    // Accounts Phase 3 (2026-09-07): presence, poll-based rather than an
    // always-on socket (see TODO.md's Deployment models entry for the full
    // reasoning — this was a deliberate load/security tradeoff, not a
    // shortcut). Polled every ~30s by presencePoll.js while a logged-in user
    // has the lobby open; the call itself IS the polling account's own
    // heartbeat (authManager.touchLastSeen()), so no separate heartbeat
    // endpoint exists. Rate-limited defensively even though it's session-
    // authenticated — same shape as the settings PUT routes, not because
    // abuse is expected.
    app.get('/api/friends/presence', rateLimit(60_000, 30, byAccount), (req, res) => {
        const session = requireSession(req, authManager);
        if (!session) return res.status(401).json({ error: 'Not logged in' });
        authManager.touchLastSeen(session.userId);
        res.status(200).json({ presence: friendsManager.listFriendsPresence(session.userId, ONLINE_THRESHOLD_MS) });
    });

    app.post('/api/friends/request', rateLimit(60_000, 20, byAccount), (req, res) => {
        const session = requireSession(req, authManager);
        if (!session) return res.status(401).json({ error: 'Not logged in' });
        const username = req.body?.username;
        if (typeof username !== 'string' || !username) {
            return res.status(400).json({ error: 'Missing username' });
        }
        const result = friendsManager.sendRequest(session.userId, username);
        if (!result.ok) {
            return res.status(400).json({ error: REASON_MESSAGES[result.reason] || 'Could not send request' });
        }
        res.status(200).json({ status: result.status });
    });

    app.post('/api/friends/:id/accept', rateLimit(60_000, 20, byAccount), (req, res) => {
        const session = requireSession(req, authManager);
        if (!session) return res.status(401).json({ error: 'Not logged in' });
        const requestId = Number(req.params.id);
        if (!Number.isInteger(requestId)) return res.status(400).json({ error: 'Invalid request id' });
        const ok = friendsManager.acceptRequest(session.userId, requestId);
        if (!ok) return res.status(400).json({ error: 'No such pending request' });
        res.status(200).json({ accepted: true });
    });

    app.delete('/api/friends/:id', rateLimit(60_000, 20, byAccount), (req, res) => {
        const session = requireSession(req, authManager);
        if (!session) return res.status(401).json({ error: 'Not logged in' });
        const requestId = Number(req.params.id);
        if (!Number.isInteger(requestId)) return res.status(400).json({ error: 'Invalid request id' });
        const ok = friendsManager.removeFriendship(session.userId, requestId);
        if (!ok) return res.status(400).json({ error: 'No such relationship' });
        res.status(200).json({ removed: true });
    });

    // Security-review follow-up (2026-09-07): declining/removing a
    // friendship alone left no way to stop someone re-sending — see
    // TODO.md's "No account-level block" entry. Two distinct path segments
    // from the single-:id routes above ('block' is a literal first
    // segment), so there's no Express route-matching collision.
    app.post('/api/friends/block', rateLimit(60_000, 20, byAccount), (req, res) => {
        const session = requireSession(req, authManager);
        if (!session) return res.status(401).json({ error: 'Not logged in' });
        const username = req.body?.username;
        if (typeof username !== 'string' || !username) {
            return res.status(400).json({ error: 'Missing username' });
        }
        const result = friendsManager.blockUser(session.userId, username);
        if (!result.ok) {
            return res.status(400).json({ error: BLOCK_REASON_MESSAGES[result.reason] || 'Could not block user' });
        }
        res.status(200).json({ blocked: true });
    });

    app.delete('/api/friends/block/:id', rateLimit(60_000, 20, byAccount), (req, res) => {
        const session = requireSession(req, authManager);
        if (!session) return res.status(401).json({ error: 'Not logged in' });
        const blockId = Number(req.params.id);
        if (!Number.isInteger(blockId)) return res.status(400).json({ error: 'Invalid block id' });
        const ok = friendsManager.unblockUser(session.userId, blockId);
        if (!ok) return res.status(400).json({ error: 'No such block' });
        res.status(200).json({ unblocked: true });
    });
}
