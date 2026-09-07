// --- public/client/messagesPoll.js ---
// Accounts Phase 4 (2026-09-07): polls GET /api/messages for the messages
// button's unread-count badge — same schedule-after-tick/pause-on-
// visibilitychange shape as roomStatusPoll.js/presencePoll.js. A separate
// poller from presencePoll.js (one concern per file, matching this
// codebase's existing convention) even though both run on the same 30s
// cadence and could theoretically share a request — the two features are
// independent and either could be disabled/changed without touching the
// other.
const POLL_INTERVAL_MS = 30_000;

/**
 * @param {(conversations: Array<{user:object, lastMessage:object, unreadCount:number}>) => void} onUpdate
 * @param {() => void} [onSessionExpired] - called on a 401, meaning the
 *   session cookie no longer validates — e.g. logged out from another tab.
 *   See presencePoll.js's matching param for the full 2026-09-07 audit note.
 * @returns {() => void} stop
 */
export function startMessagesPolling(onUpdate, onSessionExpired) {
    let timer = null;
    let stopped = false;

    async function tick() {
        try {
            const res = await fetch('/api/messages');
            if (res.status === 401) { onSessionExpired?.(); return; }
            if (!res.ok) return; // some other error — next tick retries
            const { conversations } = await res.json();
            onUpdate(conversations || []);
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
