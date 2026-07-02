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
    rooms.unshift({ code, label: (label || '').trim() || code, password: password || null });
    setSavedRooms(rooms);
}

export function removeRoom(code) {
    setSavedRooms(getSavedRooms().filter(r => r.code !== code));
}
