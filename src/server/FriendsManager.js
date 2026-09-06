// --- src/server/FriendsManager.js ---
// Accounts Phase 2: a bare add/accept/remove relationship graph — no
// presence, no DMs (both later phases; see TODO.md's "Deployment models"
// entry). Mirrors AuthManager.js's constructor/method-style, with one
// deliberate deviation noted on sendRequest() below.
class FriendsManager {
    constructor(db) {
        this.db = db;
    }

    // Public-safe projection, same shape as AuthManager.getPublicProfile().
    _publicProfile(userId) {
        return this.db.prepare(
            'SELECT id, username, nickname, avatar FROM users WHERE id = ?'
        ).get(userId);
    }

    _findRelationship(userA, userB) {
        return this.db.prepare(`
            SELECT * FROM friendships
            WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
        `).get(userA, userB, userB, userA);
    }

    /**
     * Blocking is symmetric for request purposes even though storage is
     * directional (only the blocker's row exists) — if A blocks B, B
     * shouldn't be able to route around it by requesting A first.
     */
    isBlockedEitherWay(userA, userB) {
        return !!this.db.prepare(`
            SELECT 1 FROM blocks
            WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
        `).get(userA, userB, userB, userA);
    }

    /**
     * @param {number} requesterId
     * @param {string} addresseeUsername
     * @returns {{ok:true, status:'pending'|'accepted'}|{ok:false, reason:'self'|'not_found'|'already_friends'|'already_pending'}}
     *
     * Deliberately not the plain falsy-on-failure convention AuthManager.js
     * uses elsewhere — these are all expected, non-error outcomes a user
     * needs distinct feedback on (typo'd a username vs. already friends vs.
     * already asked), unlike login's generic "invalid credentials" case
     * where hiding the reason is the point. Not a fresh enumeration surface:
     * /api/auth/register's 409 already confirms whether a username exists.
     */
    sendRequest(requesterId, addresseeUsername) {
        const addressee = this.db.prepare(
            'SELECT id FROM users WHERE username = ? COLLATE NOCASE'
        ).get(addresseeUsername);
        if (!addressee) return { ok: false, reason: 'not_found' };
        if (addressee.id === requesterId) return { ok: false, reason: 'self' };
        // Reuses 'not_found' rather than a distinct 'blocked' reason — a
        // blocked user querying by trial-and-error shouldn't be able to
        // learn that they specifically are blocked vs. the account simply
        // not existing.
        if (this.isBlockedEitherWay(requesterId, addressee.id)) return { ok: false, reason: 'not_found' };

        const existing = this._findRelationship(requesterId, addressee.id);
        if (existing) {
            if (existing.status === 'accepted') return { ok: false, reason: 'already_friends' };
            // existing.status === 'pending'
            if (existing.requester_id === requesterId) return { ok: false, reason: 'already_pending' };
            // The other user already asked us — accept their existing row
            // instead of creating a second, redundant pending relationship
            // for the same pair.
            const now = Date.now();
            this.db.prepare('UPDATE friendships SET status = ?, updated_at = ? WHERE id = ?')
                .run('accepted', now, existing.id);
            return { ok: true, status: 'accepted' };
        }

        const now = Date.now();
        this.db.prepare(
            'INSERT INTO friendships (requester_id, addressee_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        ).run(requesterId, addressee.id, 'pending', now, now);
        return { ok: true, status: 'pending' };
    }

    /**
     * Only the addressee of a still-pending request can accept it.
     * @returns {boolean} whether a request was actually accepted
     */
    acceptRequest(userId, requestId) {
        const info = this.db.prepare(
            "UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ? AND addressee_id = ? AND status = 'pending'"
        ).run(Date.now(), requestId, userId);
        return info.changes > 0;
    }

    /**
     * One verb for declining an incoming request, cancelling your own
     * outgoing one, and unfriending an accepted relationship — either party
     * to the row may remove it, regardless of status.
     * @returns {boolean} whether a relationship was actually removed
     */
    removeFriendship(userId, requestId) {
        const info = this.db.prepare(
            'DELETE FROM friendships WHERE id = ? AND (requester_id = ? OR addressee_id = ?)'
        ).run(requestId, userId, userId);
        return info.changes > 0;
    }

    /**
     * @returns {Array<{requestId:number, id:number, username:string, nickname:string|null, avatar:string|null}>}
     * requestId is the friendships row id — the client needs it to call
     * removeFriendship() (unfriend), same shape as listPending()'s entries.
     */
    listFriends(userId) {
        const rows = this.db.prepare(
            "SELECT id, requester_id, addressee_id FROM friendships WHERE (requester_id = ? OR addressee_id = ?) AND status = 'accepted'"
        ).all(userId, userId);
        return rows.map(r => ({
            requestId: r.id,
            ...this._publicProfile(r.requester_id === userId ? r.addressee_id : r.requester_id),
        }));
    }

    /** @returns {{incoming: Array<{requestId:number, user:object}>, outgoing: Array<{requestId:number, user:object}>}} */
    listPending(userId) {
        const incomingRows = this.db.prepare(
            "SELECT id, requester_id FROM friendships WHERE addressee_id = ? AND status = 'pending'"
        ).all(userId);
        const outgoingRows = this.db.prepare(
            "SELECT id, addressee_id FROM friendships WHERE requester_id = ? AND status = 'pending'"
        ).all(userId);
        return {
            incoming: incomingRows.map(r => ({ requestId: r.id, user: this._publicProfile(r.requester_id) })),
            outgoing: outgoingRows.map(r => ({ requestId: r.id, user: this._publicProfile(r.addressee_id) })),
        };
    }

    /**
     * Blocking severs any existing friendship/pending request between the
     * pair (in either direction — _findRelationship already checks both)
     * outright, same "no soft state" precedent as removeFriendship(), then
     * records the block. INSERT OR IGNORE against the unique (blocker_id,
     * blocked_id) index makes re-blocking an already-blocked user a no-op
     * rather than a constraint-violation throw.
     * @param {number} blockerId
     * @param {string} blockedUsername
     * @returns {{ok:true}|{ok:false, reason:'self'|'not_found'}}
     */
    blockUser(blockerId, blockedUsername) {
        const target = this.db.prepare(
            'SELECT id FROM users WHERE username = ? COLLATE NOCASE'
        ).get(blockedUsername);
        if (!target) return { ok: false, reason: 'not_found' };
        if (target.id === blockerId) return { ok: false, reason: 'self' };

        const existing = this._findRelationship(blockerId, target.id);
        if (existing) {
            this.db.prepare('DELETE FROM friendships WHERE id = ?').run(existing.id);
        }
        this.db.prepare(
            'INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)'
        ).run(blockerId, target.id, Date.now());
        return { ok: true };
    }

    /**
     * Only the blocker can lift their own block — mirrors acceptRequest()'s
     * ownership-in-the-WHERE-clause pattern rather than a separate check.
     * @returns {boolean} whether a block was actually removed
     */
    unblockUser(blockerId, blockId) {
        const info = this.db.prepare(
            'DELETE FROM blocks WHERE id = ? AND blocker_id = ?'
        ).run(blockId, blockerId);
        return info.changes > 0;
    }

    /**
     * Only rows where `userId` is the blocker — you can't see or lift a
     * block someone else placed on you (nor should you be able to tell one
     * exists; that's why sendRequest() collapses it into 'not_found').
     * @returns {Array<{blockId:number, id:number, username:string, nickname:string|null, avatar:string|null}>}
     */
    listBlocked(userId) {
        const rows = this.db.prepare(
            'SELECT id, blocked_id FROM blocks WHERE blocker_id = ?'
        ).all(userId);
        return rows.map(r => ({ blockId: r.id, ...this._publicProfile(r.blocked_id) }));
    }
}

export { FriendsManager };
