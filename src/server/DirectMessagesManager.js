// --- src/server/DirectMessagesManager.js ---
// Accounts Phase 4 (2026-09-07): direct messages, friends-only. Mirrors
// FriendsManager.js's constructor/method style. Deliberately poll-based on
// the client side (see messagesPoll.js) rather than push — the always-on
// connection Phase 4 was originally scoped to need never got built, since
// the 2026-09-07 security/load review moved Phase 3 (presence) to a poll
// too. Rendered as plain text client-side (MessagesPanel.js uses
// textContent, not the marked/DOMPurify pipeline room chat uses) — a
// deliberate v1 scope cut, not an oversight; see TODO.md's Phase 4 entry.
const MAX_BODY_LEN = 4000; // generous plain-text cap, no attachments/markdown in v1
const CONVERSATION_LIMIT = 200; // most recent N messages; no pagination in v1

class DirectMessagesManager {
    constructor(db) {
        this.db = db;
    }

    _publicProfile(userId) {
        return this.db.prepare(
            'SELECT id, username, nickname, avatar FROM users WHERE id = ?'
        ).get(userId);
    }

    _isFriend(userA, userB) {
        return !!this.db.prepare(`
            SELECT 1 FROM friendships
            WHERE status = 'accepted'
              AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))
        `).get(userA, userB, userB, userA);
    }

    /**
     * Re-validates the friendship on every send (not just once, e.g. at
     * conversation-open time) — a friendship can end between messages, and
     * this is the actual enforcement point, not a UI nicety. Blocking
     * (FriendsManager.blockUser()) already deletes the friendships row, so
     * a blocked user is rejected here for free, no separate block check
     * needed.
     * @param {number} senderId
     * @param {string} recipientUsername
     * @param {unknown} body client-supplied, never trusted verbatim
     * @returns {{ok:true, message:object}|{ok:false, reason:'not_found'|'not_friends'|'invalid_body'}}
     */
    sendMessage(senderId, recipientUsername, body) {
        if (typeof body !== 'string') return { ok: false, reason: 'invalid_body' };
        const trimmed = body.trim();
        if (!trimmed || trimmed.length > MAX_BODY_LEN) return { ok: false, reason: 'invalid_body' };

        const recipient = this.db.prepare(
            'SELECT id FROM users WHERE username = ? COLLATE NOCASE'
        ).get(recipientUsername);
        if (!recipient) return { ok: false, reason: 'not_found' };
        if (recipient.id === senderId) return { ok: false, reason: 'not_friends' }; // no self-DMs; same reason, no new enumeration surface
        if (!this._isFriend(senderId, recipient.id)) return { ok: false, reason: 'not_friends' };

        const now = Date.now();
        const info = this.db.prepare(
            'INSERT INTO direct_messages (sender_id, recipient_id, body, created_at) VALUES (?, ?, ?, ?)'
        ).run(senderId, recipient.id, trimmed, now);
        return { ok: true, message: { id: info.lastInsertRowid, body: trimmed, createdAt: now, fromMe: true } };
    }

    /**
     * Fetches the most recent messages between the two users AND marks
     * every unread message *sent to* `userId` in this conversation as read
     * — this is the only place read_at is ever written, and it's a side
     * effect of the recipient actually viewing the thread, not a separate
     * "mark read" call the client has to remember to make.
     * @param {number} userId
     * @param {string} otherUsername
     * @returns {{ok:true, messages:Array<object>, partnerAvatar:string|null}|{ok:false, reason:'not_found'}}
     */
    getConversation(userId, otherUsername) {
        const other = this.db.prepare(
            'SELECT id, avatar FROM users WHERE username = ? COLLATE NOCASE'
        ).get(otherUsername);
        if (!other) return { ok: false, reason: 'not_found' };

        this.db.prepare(`
            UPDATE direct_messages SET read_at = ?
            WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL
        `).run(Date.now(), other.id, userId);

        const rows = this.db.prepare(`
            SELECT id, sender_id, body, created_at FROM direct_messages
            WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
            ORDER BY created_at ASC
            LIMIT ?
        `).all(userId, other.id, other.id, userId, CONVERSATION_LIMIT);

        return {
            ok: true,
            messages: rows.map(r => ({ id: r.id, body: r.body, createdAt: r.created_at, fromMe: r.sender_id === userId })),
            partnerAvatar: other.avatar || null,
        };
    }

    /**
     * One row per conversation partner (anyone `userId` has ever exchanged
     * a message with — not scoped to *current* friends, so history stays
     * visible after an unfriend; sendMessage() is what actually blocks new
     * messages once the friendship ends), each with the last message's
     * preview and an unread count. N+1 queries (one per partner) — fine at
     * this app's expected scale, same simplicity-over-cleverness precedent
     * as FriendsManager.listFriends()'s own per-row _publicProfile() calls.
     * @param {number} userId
     * @returns {Array<{user:object, lastMessage:{body:string,createdAt:number,fromMe:boolean}, unreadCount:number}>}
     */
    listConversations(userId) {
        const partners = this.db.prepare(`
            SELECT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS other_id,
                   MAX(created_at) AS last_at
            FROM direct_messages
            WHERE sender_id = ? OR recipient_id = ?
            GROUP BY other_id
            ORDER BY last_at DESC
        `).all(userId, userId, userId);

        return partners.map(({ other_id }) => {
            const last = this.db.prepare(`
                SELECT sender_id, body, created_at FROM direct_messages
                WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
                ORDER BY created_at DESC LIMIT 1
            `).get(userId, other_id, other_id, userId);
            const unreadCount = this.db.prepare(`
                SELECT COUNT(*) AS n FROM direct_messages
                WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL
            `).get(other_id, userId).n;
            return {
                user: this._publicProfile(other_id),
                lastMessage: { body: last.body, createdAt: last.created_at, fromMe: last.sender_id === userId },
                unreadCount,
            };
        });
    }
}

export { DirectMessagesManager };
