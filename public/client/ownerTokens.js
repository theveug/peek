// --- public/client/ownerTokens.js ---
// Local-device-only memory of "which rooms am I the owner of", keyed by room
// code — backed by localStorage (survives a closed browser / restarted PC),
// unlike the flat sessionStorage['creatorToken'] key App.js also keeps (that
// one exists only to prevent a same-tab cross-room leak on the Leave Room
// button — see its handler — and dies with the tab, which is exactly the gap
// this module fixes: the room itself may still be alive server-side with
// other peers present, but a token that only lived in sessionStorage can't
// survive to reclaim it). Same trust level as `peek.savedRooms` already
// storing plaintext room passwords here — both accept "anyone using this
// browser profile inherits this" as the threat model.

const STORAGE_KEY = 'peek.ownerTokens';
const MAX_ENTRIES = 100;

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

/** @param {string} code @returns {string|null} the remembered creator token for a room code, if any. */
export function getOwnerToken(code) {
    return readAll()[code]?.token || null;
}

/**
 * Remembers a creator token for a room code (overwriting/refreshing any
 * existing entry) and evicts the least-recently-touched entries past
 * MAX_ENTRIES, so this can't grow unbounded across a long-lived browser
 * profile that's created/lazily-owned many rooms over time.
 * @param {string} code
 * @param {string} token
 * @returns {void}
 */
export function setOwnerToken(code, token) {
    if (!code || !token) return;
    const all = readAll();
    all[code] = { token, savedAt: Date.now() };
    const trimmed = Object.entries(all)
        .sort((a, b) => b[1].savedAt - a[1].savedAt)
        .slice(0, MAX_ENTRIES);
    writeAll(Object.fromEntries(trimmed));
}
