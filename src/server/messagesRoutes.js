// --- src/server/messagesRoutes.js ---
// Accounts Phase 4 (2026-09-07): mounts /api/messages/* — only ever called
// from server.js's ACCOUNTS_ENABLED branch, alongside mountAuthRoutes()/
// mountFriendsRoutes(). Same inline session-check repetition those files
// use rather than shared middleware, for consistency with their style.
import { rateLimit } from './rateLimit.js';
import { readCookie, COOKIE_NAME } from './authRoutes.js';

const REASON_MESSAGES = {
    not_found: 'No account with that username',
    not_friends: 'You can only message friends',
    invalid_body: 'Message is empty or too long',
};

function requireSession(req, authManager) {
    const token = readCookie(req, COOKIE_NAME);
    return token ? authManager.validateSessionToken(token) : null;
}

/**
 * @param {import('express').Express} app
 * @param {import('./AuthManager.js').AuthManager} authManager
 * @param {import('./DirectMessagesManager.js').DirectMessagesManager} messagesManager
 */
export function mountMessagesRoutes(app, authManager, messagesManager) {
    // Polled every ~30s by messagesPoll.js for the inbox unread badge — same
    // "the fetch is enough, no separate signal needed" shape as
    // GET /api/friends/presence, just without a heartbeat side effect here
    // (presence's heartbeat lives on that route, not this one).
    app.get('/api/messages', rateLimit(60_000, 30), (req, res) => {
        const session = requireSession(req, authManager);
        if (!session) return res.status(401).json({ error: 'Not logged in' });
        res.status(200).json({ conversations: messagesManager.listConversations(session.userId) });
    });

    app.get('/api/messages/:username', rateLimit(60_000, 60), (req, res) => {
        const session = requireSession(req, authManager);
        if (!session) return res.status(401).json({ error: 'Not logged in' });
        const result = messagesManager.getConversation(session.userId, req.params.username);
        if (!result.ok) return res.status(404).json({ error: REASON_MESSAGES[result.reason] || 'Not found' });
        res.status(200).json({ messages: result.messages });
    });

    app.post('/api/messages/:username', rateLimit(60_000, 30), (req, res) => {
        const session = requireSession(req, authManager);
        if (!session) return res.status(401).json({ error: 'Not logged in' });
        const result = messagesManager.sendMessage(session.userId, req.params.username, req.body?.body);
        if (!result.ok) {
            const status = result.reason === 'invalid_body' ? 400 : 404;
            return res.status(status).json({ error: REASON_MESSAGES[result.reason] || 'Could not send message' });
        }
        res.status(200).json({ message: result.message });
    });
}
