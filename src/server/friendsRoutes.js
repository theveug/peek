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

/**
 * @param {import('express').Express} app
 * @param {import('./AuthManager.js').AuthManager} authManager
 * @param {import('./FriendsManager.js').FriendsManager} friendsManager
 */
export function mountFriendsRoutes(app, authManager, friendsManager) {
    app.get('/api/friends', (req, res) => {
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

    app.post('/api/friends/request', rateLimit(60_000, 20), (req, res) => {
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

    app.post('/api/friends/:id/accept', (req, res) => {
        const session = requireSession(req, authManager);
        if (!session) return res.status(401).json({ error: 'Not logged in' });
        const requestId = Number(req.params.id);
        if (!Number.isInteger(requestId)) return res.status(400).json({ error: 'Invalid request id' });
        const ok = friendsManager.acceptRequest(session.userId, requestId);
        if (!ok) return res.status(400).json({ error: 'No such pending request' });
        res.status(200).json({ accepted: true });
    });

    app.delete('/api/friends/:id', (req, res) => {
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
    app.post('/api/friends/block', rateLimit(60_000, 20), (req, res) => {
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

    app.delete('/api/friends/block/:id', (req, res) => {
        const session = requireSession(req, authManager);
        if (!session) return res.status(401).json({ error: 'Not logged in' });
        const blockId = Number(req.params.id);
        if (!Number.isInteger(blockId)) return res.status(400).json({ error: 'Invalid block id' });
        const ok = friendsManager.unblockUser(session.userId, blockId);
        if (!ok) return res.status(400).json({ error: 'No such block' });
        res.status(200).json({ unblocked: true });
    });
}
