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

function isValidStatus(s) {
    return s && typeof s.id === 'string' && typeof s.label === 'string' && BASE_STATUSES.includes(s.baseStatus);
}

/** @returns {Array<{id:string,label:string,color:string,baseStatus:string,deafen:boolean,mute:boolean,dropStreams:boolean,keybind:?string}>} */
export function getCustomStatuses() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        return Array.isArray(raw) ? raw.filter(isValidStatus) : [];
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
 * @param {{id?: string, label: string, color: string, baseStatus: string, deafen: boolean, mute: boolean, dropStreams: boolean}} status
 */
export function upsertCustomStatus(status) {
    const list = getCustomStatuses();
    const entry = {
        id: status.id || 'status-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
        label: (status.label || '').trim().slice(0, LABEL_MAX),
        color: SWATCHES.includes(status.color) ? status.color : SWATCHES[0],
        baseStatus: BASE_STATUSES.includes(status.baseStatus) ? status.baseStatus : 'online',
        deafen: !!status.deafen,
        mute: !!status.mute,
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
