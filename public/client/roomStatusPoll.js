const POLL_INTERVAL_MS = 25_000;
const MAX_CODES = 50;

// Polls /api/room-status for live active/peerCount info on saved rooms.
// getCodes() is called fresh every tick so add/remove is picked up automatically.
// Pauses while the tab is hidden; fetch failures are swallowed (last-known-good stays).
export function startRoomStatusPolling(getCodes, onUpdate) {
    let timer = null;
    let stopped = false;

    async function tick() {
        const codes = getCodes().slice(0, MAX_CODES);
        if (codes.length === 0) return;
        try {
            const res = await fetch('/api/room-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ codes }),
            });
            if (!res.ok) return;
            const { statuses } = await res.json();
            onUpdate(statuses || {});
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
