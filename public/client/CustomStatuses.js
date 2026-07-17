// --- public/client/CustomStatuses.js ---
// User-defined reusable quick statuses (Settings -> Profile -> Custom statuses).
// Pure client-side preference data, same tier as nickname/keybinds/theme — see
// EmojiPicker.js's getRecent()/recordRecent() for the try/catch + Array.isArray
// pattern this mirrors. Only the label + baseStatus are ever broadcast to peers
// (via the existing setManualStatus/setStatusText calls); color/deafen/mute/
// dropStreams are applied locally by whoever selects the status (TopbarIdentity.js).

const STORAGE_KEY = 'customStatuses';
const ACTIVE_KEY = 'activeCustomStatusId';
const MAX_STATUSES = 12;
const LABEL_MAX = 40;

// A fixed swatch palette rather than a raw <input type="color"> — nothing like
// that exists elsewhere in Peek's UI, and a small curated set keeps custom dots
// visually consistent with the app's existing status/accent colors.
export const SWATCHES = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899'];

export const BASE_STATUSES = ['online', 'away', 'dnd'];

// Mute/deafen are tri-state, not booleans — a status can force them on
// ('on'), force them off ('off'), or leave them exactly as they were
// ('none'). That third option is what makes a "Back" status able to
// auto-unmute/undeafen after a "Lunch" status forced them on, rather than
// custom statuses only ever being able to mute/deafen and never reverse it.
export const TOGGLE_VALUES = ['none', 'on', 'off'];

function normalizeToggle(v) {
    // Back-compat for statuses saved before mute/deafen became tri-state,
    // when they were plain booleans (true meant "force on", same as 'on' now).
    if (v === true) return 'on';
    if (v === false || v === undefined) return 'none';
    return TOGGLE_VALUES.includes(v) ? v : 'none';
}

function isValidStatus(s) {
    return s && typeof s.id === 'string' && typeof s.label === 'string' && BASE_STATUSES.includes(s.baseStatus);
}

/** @returns {Array<{id:string,label:string,color:string,baseStatus:string,deafen:'none'|'on'|'off',mute:'none'|'on'|'off',dropStreams:boolean,keybind:?string}>} */
export function getCustomStatuses() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        if (!Array.isArray(raw)) return [];
        return raw.filter(isValidStatus).map((s) => ({
            ...s,
            deafen: normalizeToggle(s.deafen),
            mute: normalizeToggle(s.mute),
            dropStreams: !!s.dropStreams,
        }));
    } catch {
        return [];
    }
}

export function getCustomStatus(id) {
    return getCustomStatuses().find((s) => s.id === id) || null;
}

function saveCustomStatuses(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_STATUSES)));
}

/**
 * Creates or updates a custom status (update when `id` matches an existing
 * entry, create otherwise) and persists the list.
 * @param {{id?: string, label: string, color: string, baseStatus: string, deafen: 'none'|'on'|'off', mute: 'none'|'on'|'off', dropStreams: boolean}} status
 */
export function upsertCustomStatus(status) {
    const list = getCustomStatuses();
    const entry = {
        id: status.id || 'status-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
        label: (status.label || '').trim().slice(0, LABEL_MAX),
        color: SWATCHES.includes(status.color) ? status.color : SWATCHES[0],
        baseStatus: BASE_STATUSES.includes(status.baseStatus) ? status.baseStatus : 'online',
        deafen: normalizeToggle(status.deafen),
        mute: normalizeToggle(status.mute),
        dropStreams: !!status.dropStreams,
        keybind: null, // reserved for a later pass — not wired up yet
    };
    const idx = list.findIndex((s) => s.id === entry.id);
    if (idx === -1) list.push(entry);
    else list[idx] = entry;
    saveCustomStatuses(list);
    return entry;
}

export function deleteCustomStatus(id) {
    saveCustomStatuses(getCustomStatuses().filter((s) => s.id !== id));
    if (localStorage.getItem(ACTIVE_KEY) === id) localStorage.removeItem(ACTIVE_KEY);
}

export function getActiveCustomStatusId() {
    return localStorage.getItem(ACTIVE_KEY);
}

export function setActiveCustomStatusId(id) {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
}
