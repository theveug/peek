// --- src/server/authRoutes.js ---
import { rateLimit } from './rateLimit.js';

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 200;
const COOKIE_NAME = 'peek_session';
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

// Same per-IP fixed-window lockout SHAPE as /api/validate-room's
// failedValidationsByIp (server.js) — a separate Map on purpose, matching
// this codebase's existing convention of each call site owning its own
// counter rather than sharing one (see failedValidationsByIp/failedJoinsByIp).
const FAILED_LOGIN_LIMIT = 20;
const failedLoginsByIp = new Map();
setInterval(() => failedLoginsByIp.clear(), 10 * 60_000).unref();

// Express 5 doesn't parse the Cookie request header itself (that's
// cookie-parser's job) — for the one cookie this app needs, a small
// hand-rolled reader is simpler than adding a dependency for it, matching
// this codebase's existing hand-rolled rateLimit()/sanitization idiom.
function readCookie(req, name) {
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
        if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
            return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
        }

        const session = await authManager.register(username, password);
        if (!session) {
            return res.status(409).json({ error: 'That username is already taken' });
        }
        setSessionCookie(req, res, session.token);
        res.status(201).json({ username });
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

    app.get('/api/auth/me', (req, res) => {
        const token = readCookie(req, COOKIE_NAME);
        const session = token ? authManager.validateSessionToken(token) : null;
        if (!session) {
            return res.status(401).json({ error: 'Not logged in' });
        }
        res.status(200).json(authManager.getPublicProfile(session.userId));
    });
}
