// --- src/server/AuthManager.js ---
import { hash, verify } from '@node-rs/argon2';
import { randomBytes, createHash } from 'crypto';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Lazily computed once, reused for every login attempt against a username
// that doesn't exist — makes a nonexistent-user login take the same time as
// a real wrong-password one, so response latency can't be used to enumerate
// which usernames are registered.
let DUMMY_HASH = null;

// Accounts Phase 1c: the only keys ever persisted to/read from a user's
// settings blob — a client-sent PUT is never trusted verbatim, same
// "validate on receive" discipline as WebSocketServer.js's join-message
// handling elsewhere in this codebase.
const SETTINGS_KEYS = ['theme', 'accentHue', 'bgTint', 'camDeviceId', 'micDeviceId', 'speakerDeviceId'];

// Mirrors SessionManager.js's method style: every mutator re-checks its own
// invariants and returns falsy on failure, a small result object on success
// (never bare `true`, so a success carrying no other data doesn't read as
// falsy) — see SessionManager.setPassword()'s {password} return for the
// precedent this follows.
class AuthManager {
    constructor(db) {
        this.db = db;
    }

    /**
     * @param {string} username
     * @param {string} password
     * @returns {Promise<{token: string, expiresAt: number}|false>}
     */
    async register(username, password) {
        const dupe = this.db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
        if (dupe) return false;

        const password_hash = await hash(password);
        const now = Date.now();
        const info = this.db.prepare(
            'INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)'
        ).run(username, password_hash, now, now);

        return this._mintSession(info.lastInsertRowid);
    }

    /**
     * @param {string} username
     * @param {string} password
     * @returns {Promise<{token: string, expiresAt: number}|null>}
     */
    async login(username, password) {
        const row = this.db.prepare(
            'SELECT id, password_hash FROM users WHERE username = ? COLLATE NOCASE'
        ).get(username);

        if (!row) {
            DUMMY_HASH ??= await hash(randomBytes(16).toString('hex'));
            await verify(DUMMY_HASH, password);
            return null;
        }

        const ok = await verify(row.password_hash, password);
        if (!ok) return null;

        return this._mintSession(row.id);
    }

    _mintSession(userId) {
        const token = randomBytes(32).toString('hex');
        const tokenHash = createHash('sha256').update(token).digest('hex');
        const now = Date.now();
        const expiresAt = now + SESSION_TTL_MS;
        this.db.prepare(
            'INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
        ).run(userId, tokenHash, now, expiresAt, now);
        return { token, expiresAt };
    }

    /**
     * Looked up by a hashed value via an indexed unique column — an indexed
     * lookup, not a compare loop, so this sidesteps timing-attack concerns
     * entirely (unlike creatorToken's timingSafeEqual compare elsewhere in
     * this codebase, which exists because that token has no DB to look
     * itself up in).
     * @param {string} token
     * @returns {{sessionId: number, expiresAt: number, userId: number, username: string, nickname: string|null, avatar: string|null}|null}
     */
    validateSessionToken(token) {
        if (typeof token !== 'string' || !token) return null;
        const tokenHash = createHash('sha256').update(token).digest('hex');
        const row = this.db.prepare(`
            SELECT s.id AS sessionId, s.expires_at AS expiresAt,
                   u.id AS userId, u.username, u.nickname, u.avatar
            FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ?
        `).get(tokenHash);
        if (!row || row.expiresAt < Date.now()) return null;
        return row;
    }

    /**
     * @param {string} token
     * @returns {boolean} whether a session was actually revoked
     */
    logout(token) {
        if (typeof token !== 'string' || !token) return false;
        const tokenHash = createHash('sha256').update(token).digest('hex');
        const info = this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
        return info.changes > 0;
    }

    // Public-safe projection — never leaks password_hash, mirrors
    // SessionManager.getSessionMeta().
    getPublicProfile(userId) {
        return this.db.prepare(
            'SELECT id, username, nickname, avatar FROM users WHERE id = ?'
        ).get(userId) || null;
    }

    /**
     * @param {number} userId
     * @returns {object|null} the saved settings blob, or null if nothing's ever been saved
     */
    getSettings(userId) {
        const row = this.db.prepare('SELECT settings FROM users WHERE id = ?').get(userId);
        if (!row?.settings) return null;
        try {
            return JSON.parse(row.settings);
        } catch {
            return null;
        }
    }

    /**
     * @param {number} userId
     * @param {unknown} settings client-supplied, never trusted verbatim
     * @returns {{settings: object}|false}
     */
    saveSettings(userId, settings) {
        if (!settings || typeof settings !== 'object') return false;
        const clean = {};
        for (const key of SETTINGS_KEYS) {
            if (typeof settings[key] === 'string') clean[key] = settings[key].slice(0, 200);
        }
        this.db.prepare('UPDATE users SET settings = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(clean), Date.now(), userId);
        return { settings: clean };
    }
}

export { AuthManager };
