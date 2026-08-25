const STORAGE_KEY = 'peek.savedRooms';

export function getSavedRooms() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const rooms = raw ? JSON.parse(raw) : [];
        return Array.isArray(rooms) ? rooms : [];
    } catch {
        return [];
    }
}

function setSavedRooms(rooms) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms));
}

export function saveRoom({ code, label, password }) {
    const rooms = getSavedRooms().filter(r => r.code !== code);
    rooms.unshift({ code, label: (label || '').trim() || code, password: password || null, savedAt: Date.now() });
    setSavedRooms(rooms);
}

export function removeRoom(code) {
    setSavedRooms(getSavedRooms().filter(r => r.code !== code));
}

/**
 * Updates a saved room's stored password in place — used when the room
 * creator changes the room's password mid-call (PeerManager's
 * 'password-update'), so a saved room's one-click Join doesn't keep
 * submitting a now-stale password. No-op if this code isn't currently
 * saved; deliberately leaves label/savedAt/list position untouched, unlike
 * saveRoom() which re-inserts at the front.
 */
export function updateSavedRoomPassword(code, password) {
    const rooms = getSavedRooms();
    const room = rooms.find(r => r.code === code);
    if (!room) return;
    room.password = password || null;
    setSavedRooms(rooms);
}
