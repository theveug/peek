// --- src/server/authRoutes.js ---
import { rateLimit } from './rateLimit.js';

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 200;
// Exported for friendsRoutes.js to reuse — the session cookie's name and
// parser are a single shared concept, not something worth re-deriving.
export const COOKIE_NAME = 'peek_session';
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

// Same per-IP fixed-window lockout SHAPE as /api/validate-room's
// failedValidationsByIp (server.js) — a separate Map on purpose, matching
// this codebase's existing convention of each call site owning its own
// counter rather than sharing one (see failedValidationsByIp/failedJoinsByIp).
const FAILED_LOGIN_LIMIT = 20;
const failedLoginsByIp = new Map();
setInterval(() => failedLoginsByIp.clear(), 10 * 60_000).unref();
const FAILED_RECOVERY_LIMIT = 10;
const failedRecoveriesByIp = new Map();
setInterval(() => failedRecoveriesByIp.clear(), 10 * 60_000).unref();

function isValidPassword(pw) {
    return typeof pw === 'string' && pw.length >= MIN_PASSWORD_LEN && pw.length <= MAX_PASSWORD_LEN;
}

// Express 5 doesn't parse the Cookie request header itself (that's
// cookie-parser's job) — for the one cookie this app needs, a small
// hand-rolled reader is simpler than adding a dependency for it, matching
// this codebase's existing hand-rolled rateLimit()/sanitization idiom.
export function readCookie(req, name) {
    const header = req.headers.cookie;
    if (typeof header !== 'string') return null;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) {
            return decodeURIComponent(part.slice(eq + 1).trim());
        }
    }
    return null;
}

function setSessionCookie(req, res, token) {
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure,
        path: '/',
        maxAge: SESSION_MAX_AGE_S * 1000,
    });
}

function clearSessionCookie(req, res) {
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
}

/**
 * Mounts /api/auth/* on `app`. Only ever called from server.js's
 * ACCOUNTS_ENABLED branch — an unset deployment never calls this, so these
 * routes simply don't exist (Express's plain 404, not a custom
 * "disabled" response — a prober can't tell "not built" from "turned off").
 * @param {import('express').Express} app
 * @param {import('./AuthManager.js').AuthManager} authManager
 */
export function mountAuthRoutes(app, authManager) {
    app.post('/api/auth/register', rateLimit(60_000, 5), async (req, res) => {
        const { username, password } = req.body || {};
        if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
            return res.status(400).json({ error: 'Username must be 3-32 characters: letters, numbers, _ or -' });
        }
        if (!isValidPassword(password)) {
            return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
        }

        const session = await authManager.register(username, password);
        if (!session) {
            return res.status(409).json({ error: 'That username is already taken' });
        }
        setSessionCookie(req, res, session.token);
        // Shown once by the client right after registering — the only
        // self-service way back in if the password is ever forgotten.
        const recoveryCodes = authManager.generateRecoveryCodes(session.userId);
        res.status(201).json({ username, recoveryCodes });
    });

    app.post('/api/auth/login', async (req, res) => {
        if ((failedLoginsByIp.get(req.ip) || 0) >= FAILED_LOGIN_LIMIT) {
            return res.status(429).json({ error: 'Too many attempts, try again later' });
        }

        const { username, password } = req.body || {};
        if (typeof username !== 'string' || typeof password !== 'string') {
            failedLoginsByIp.set(req.ip, (failedLoginsByIp.get(req.ip) || 0) + 1);
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const session = await authManager.login(username, password.slice(0, MAX_PASSWORD_LEN));
        if (!session) {
            failedLoginsByIp.set(req.ip, (failedLoginsByIp.get(req.ip) || 0) + 1);
            return res.status(401).json({ error: 'Invalid username or password' });
        }
        setSessionCookie(req, res, session.token);
        res.status(200).json({ username });
    });

    app.post('/api/auth/logout', (req, res) => {
        const token = readCookie(req, COOKIE_NAME);
        if (token) authManager.logout(token);
        clearSessionCookie(req, res);
        res.status(204).end();
    });

    // --- Password recovery (2026-10-12) ---

    // Forgotten password: username + one unused recovery code + new password.
    // Same failure response for a nonexistent user and a wrong code, plus its
    // own per-IP lockout (codes are 80-bit, so this is belt-and-braces, but it
    // also stops this route being hammered for its argon2 cost on success).
    app.post('/api/auth/recover', rateLimit(60_000, 10), async (req, res) => {
        if ((failedRecoveriesByIp.get(req.ip) || 0) >= FAILED_RECOVERY_LIMIT) {
            return res.status(429).json({ error: 'Too many attempts, try again later' });
        }
        const { username, code, newPassword } = req.body || {};
        if (!isValidPassword(newPassword)) {
            return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
        }
        const result = typeof username === 'string'
            ? await authManager.recoverWithCode(username, code, newPassword)
            : null;
        if (!result) {
            failedRecoveriesByIp.set(req.ip, (failedRecoveriesByIp.get(req.ip) || 0) + 1);
            return res.status(401).json({ error: 'Invalid username or recovery code' });
        }
        setSessionCookie(req, res, result.token);
        res.status(200).json({ username: result.username, remainingCodes: result.remaining });
    });

    app.post('/api/auth/change-password', rateLimit(60_000, 5), async (req, res) => {
        const token = readCookie(req, COOKIE_NAME);
        const session = token ? authManager.validateSessionToken(token) : null;
        if (!session) {
            return res.status(401).json({ error: 'Not logged in' });
        }
        const { currentPassword, newPassword } = req.body || {};
        if (!isValidPassword(newPassword)) {
            return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LEN} characters` });
        }
        const result = await authManager.changePassword(session.userId, session.sessionId, currentPassword, newPassword);
        if (!result) {
            return res.status(403).json({ error: 'Current password is incorrect' });
        }
        res.status(200).json({ ok: true, signedOutOtherSessions: result.revoked });
    });

    app.get('/api/auth/recovery-codes', (req, res) => {
        const token = readCookie(req, COOKIE_NAME);
        const session = token ? authManager.validateSessionToken(token) : null;
        if (!session) {
            return res.status(401).json({ error: 'Not logged in' });
        }
        res.status(200).json({ remaining: authManager.countRecoveryCodes(session.userId) });
    });

    // Regenerating requires the current password, not just a session — new
    // codes are effectively a new password, so a hijacked session alone
    // mustn't be able to mint a permanent way back in.
    app.post('/api/auth/recovery-codes', rateLimit(60_000, 5), async (req, res) => {
        const token = readCookie(req, COOKIE_NAME);
        const session = token ? authManager.validateSessionToken(token) : null;
        if (!session) {
            return res.status(401).json({ error: 'Not logged in' });
        }
        if (!(await authManager.verifyPassword(session.userId, req.body?.currentPassword))) {
            return res.status(403).json({ error: 'Current password is incorrect' });
        }
        res.status(200).json({ recoveryCodes: authManager.generateRecoveryCodes(session.userId) });
    });

    app.get('/api/auth/me', (req, res) => {
        const token = readCookie(req, COOKIE_NAME);
        const session = token ? authManager.validateSessionToken(token) : null;
        if (!session) {
            return res.status(401).json({ error: 'Not logged in' });
        }
        res.status(200).json(authManager.getPublicProfile(session.userId));
    });

    // Accounts Phase 1c: sync a small, fixed set of client preferences
    // (color scheme + device selection) to the account — see
    // AccountSettingsSync.js for the client-side push/pull logic.
    app.get('/api/auth/settings', (req, res) => {
        const token = readCookie(req, COOKIE_NAME);
        const session = token ? authManager.validateSessionToken(token) : null;
        if (!session) {
            return res.status(401).json({ error: 'Not logged in' });
        }
        res.status(200).json(authManager.getSettings(session.userId) || {});
    });

    app.put('/api/auth/settings', rateLimit(60_000, 30), (req, res) => {
        const token = readCookie(req, COOKIE_NAME);
        const session = token ? authManager.validateSessionToken(token) : null;
        if (!session) {
            return res.status(401).json({ error: 'Not logged in' });
        }
        const result = authManager.saveSettings(session.userId, req.body?.settings);
        if (!result) {
            return res.status(400).json({ error: 'Invalid settings payload' });
        }
        res.status(200).json(result.settings);
    });

    // Accounts Phase 1d: camera/mic/speaker selection is per-(user,device),
    // not account-wide — see AccountSettingsSync.js for why (a synced device
    // ID is meaningless on a different physical machine).
    app.get('/api/auth/device-settings', (req, res) => {
        const token = readCookie(req, COOKIE_NAME);
        const session = token ? authManager.validateSessionToken(token) : null;
        if (!session) {
            return res.status(401).json({ error: 'Not logged in' });
        }
        const deviceId = req.query.deviceId;
        if (typeof deviceId !== 'string' || !deviceId) {
            return res.status(400).json({ error: 'Missing deviceId' });
        }
        res.status(200).json(authManager.getDeviceSettings(session.userId, deviceId) || {});
    });

    app.put('/api/auth/device-settings', rateLimit(60_000, 30), (req, res) => {
        const token = readCookie(req, COOKIE_NAME);
        const session = token ? authManager.validateSessionToken(token) : null;
        if (!session) {
            return res.status(401).json({ error: 'Not logged in' });
        }
        const result = authManager.saveDeviceSettings(session.userId, req.body?.deviceId, req.body?.settings);
        if (!result) {
            return res.status(400).json({ error: 'Invalid device-settings payload' });
        }
        res.status(200).json(result.settings);
    });

    // Account avatar (2026-09-10) — a separate small pair from
    // GET/PUT /api/auth/settings above rather than a 4th GLOBAL_KEYS entry:
    // an avatar data URL can be up to 40,000 chars (a real photo, not a tiny
    // string), so bundling it into that endpoint's payload would mean
    // resending the whole image on every unrelated theme/accent change. See
    // AccountSettingsSync.js's syncAvatar() for the client-side push.
    app.get('/api/auth/avatar', (req, res) => {
        const token = readCookie(req, COOKIE_NAME);
        const session = token ? authManager.validateSessionToken(token) : null;
        if (!session) {
            return res.status(401).json({ error: 'Not logged in' });
        }
        res.status(200).json(authManager.getAvatar(session.userId));
    });

    app.put('/api/auth/avatar', rateLimit(60_000, 20), (req, res) => {
        const token = readCookie(req, COOKIE_NAME);
        const session = token ? authManager.validateSessionToken(token) : null;
        if (!session) {
            return res.status(401).json({ error: 'Not logged in' });
        }
        const result = authManager.saveAvatar(session.userId, req.body?.avatar);
        if (!result) {
            return res.status(400).json({ error: 'Invalid avatar payload' });
        }
        res.status(200).json(result);
    });
}
