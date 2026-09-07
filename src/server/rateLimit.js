// --- src/server/rateLimit.js ---
// Minimal per-IP fixed-window rate limiter — in-memory only, nothing
// persisted. Extracted from server.js so authRoutes.js can reuse the exact
// same shape for /api/auth/* without a circular import back into server.js.
export function rateLimit(windowMs, max) {
    const hits = new Map();
    setInterval(() => hits.clear(), windowMs).unref();
    return (req, res, next) => {
        const count = (hits.get(req.ip) || 0) + 1;
        hits.set(req.ip, count);
        if (count > max) {
            res.status(429).json({ error: 'Too many requests' });
            return;
        }
        next();
    };
}
