// --- src/server/rateLimit.js ---
// Minimal fixed-window rate limiter — in-memory only, nothing persisted.
// Extracted from server.js so authRoutes.js can reuse the exact same shape
// for /api/auth/* without a circular import back into server.js.
//
// keyFn defaults to per-IP (the original behavior, still right for
// unauthenticated routes like /api/auth/register). friendsRoutes.js/
// messagesRoutes.js's session-authenticated routes pass a keyFn that prefers
// the session cookie instead (2026-09-07 real-usage audit fix) — two friends
// behind the same NAT/office network sharing one IP-keyed bucket could
// otherwise throttle each other's legitimate requests.
export function rateLimit(windowMs, max, keyFn = (req) => req.ip) {
    const hits = new Map();
    setInterval(() => hits.clear(), windowMs).unref();
    return (req, res, next) => {
        const key = keyFn(req);
        const count = (hits.get(key) || 0) + 1;
        hits.set(key, count);
        if (count > max) {
            res.status(429).json({ error: 'Too many requests' });
            return;
        }
        next();
    };
}
