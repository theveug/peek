// --- public/client/presencePoll.js ---
// Accounts Phase 3 (2026-09-07): polls GET /api/friends/presence for live
// online/offline dots on the friends list — same shape as
// roomStatusPoll.js's polling loop (schedule-after-tick, pause on
// visibilitychange, swallow fetch errors so a network blip just leaves the
// last-known-good state). Deliberately not an always-on WebSocket — see
// TODO.md's Deployment models entry for the load/security reasoning behind
// building presence this way. Each tick's request is also this account's own
// heartbeat (see AuthManager.touchLastSeen(), called server-side as this
// route's side effect) — a friend's poll is what makes THIS account show
// online to them, not a separate signal this file has to send.
const POLL_INTERVAL_MS = 30_000;

/**
 * @param {(presence: Array<{username:string, online:boolean}>) => void} onUpdate
 * @param {() => void} [onSessionExpired] - called on a 401, meaning the
 *   session cookie no longer validates — e.g. logged out from another tab
 *   (found during the 2026-09-07 real-usage audit: without this, a second
 *   tab kept polling forever against a dead session and its UI never learned
 *   it was logged out).
 * @returns {() => void} stop
 */
export function startPresencePolling(onUpdate, onSessionExpired) {
    let timer = null;
    let stopped = false;

    async function tick() {
        try {
            const res = await fetch('/api/friends/presence');
            if (res.status === 401) { onSessionExpired?.(); return; }
            if (!res.ok) return; // some other error — next tick retries
            const { presence } = await res.json();
            onUpdate(presence || []);
        } catch {
            // offline / server unreachable — next tick retries, no error surfaced
        }
    }

    function schedule() {
        if (stopped) return;
        timer = setTimeout(async () => {
            await tick();
            schedule();
        }, POLL_INTERVAL_MS);
    }

    function onVisibility() {
        if (stopped) return;
        clearTimeout(timer);
        if (!document.hidden) tick().then(schedule);
    }

    document.addEventListener('visibilitychange', onVisibility);
    tick().then(schedule);

    return function stop() {
        stopped = true;
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', onVisibility);
    };
}
