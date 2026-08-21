// --- public/client/mediaStateStore.js ---
// Local-only memory of "was mic/cam/screen-share on in this room", keyed by
// room code — backed by localStorage, same read/write/eviction shape as
// ownerTokens.js. Exists so a page refresh (manual, or clicking the
// update-banner's "Refresh") doesn't force the user to re-enable mic/cam by
// hand: App.js re-applies this on the very first 'init' after a fresh page
// load, but only within MAX_AGE_MS of the last save — past that window (tab
// sat closed/idle a while) it's treated as a deliberate stop, not a refresh,
// and nothing is restored. Screen share can't be silently resumed
// (getDisplayMedia() always requires a real user gesture, unlike
// getUserMedia() once permission is already granted), so `wasSharing` only
// drives a one-click resume nudge in App.js, never an automatic restart.

const STORAGE_KEY = 'peek.mediaState';
const MAX_ENTRIES = 50;
const MAX_AGE_MS = 5 * 60 * 1000;

function readAll() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const obj = raw ? JSON.parse(raw) : {};
        return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    } catch {
        return {};
    }
}

function writeAll(map) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

/**
 * @param {string} code
 * @returns {{micEnabled?: boolean, camEnabled?: boolean, wasSharing?: boolean, savedAt: number}|null}
 *   the room's remembered media state, or null if there is none or it's older than MAX_AGE_MS.
 */
export function getMediaState(code) {
    const entry = readAll()[code];
    if (!entry || Date.now() - entry.savedAt > MAX_AGE_MS) return null;
    return entry;
}

/**
 * Merges `patch` into the remembered state for a room code and refreshes its
 * timestamp (so continued activity — including a restore itself re-toggling
 * mic/cam back on — keeps extending the resume window), evicting the
 * least-recently-touched entries past MAX_ENTRIES.
 * @param {string} code
 * @param {{micEnabled?: boolean, camEnabled?: boolean, wasSharing?: boolean}} patch
 * @returns {void}
 */
export function saveMediaState(code, patch) {
    if (!code) return;
    const all = readAll();
    all[code] = { ...all[code], ...patch, savedAt: Date.now() };
    const trimmed = Object.entries(all)
        .sort((a, b) => b[1].savedAt - a[1].savedAt)
        .slice(0, MAX_ENTRIES);
    writeAll(Object.fromEntries(trimmed));
}

/** @param {string} code @returns {void} */
export function clearMediaState(code) {
    if (!code) return;
    const all = readAll();
    delete all[code];
    writeAll(all);
}
