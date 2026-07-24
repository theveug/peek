const DB_NAME = 'peek-chat-history';
const DB_VERSION = 1;
const STORE_NAME = 'messages';
const ROOM_INDEX = 'byRoom';
const DAY_MS = 24 * 60 * 60 * 1000;

let dbPromise = null;

function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'messageId' });
                    store.createIndex(ROOM_INDEX, ['roomCode', 'ts']);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    return dbPromise;
}

function getRetentionDays() {
    const days = parseInt(localStorage.getItem('chatHistoryDays'), 10);
    return Number.isFinite(days) && days > 0 ? days : 7;
}

function roomRange(roomCode) {
    return IDBKeyRange.bound([roomCode, -Infinity], [roomCode, Infinity]);
}

// Every exported function below runs its body through this chain rather than
// firing its own transaction immediately. ChatUI.js calls appendMessage()
// without awaiting it (a chat send/render path can't block on a background
// persistence write), so a same-message edit/delete that follows quickly
// would otherwise race its own IndexedDB transaction — e.g. updateMessage()'s
// `get` finding nothing yet (append hasn't committed), no-op'ing, and then
// the still-in-flight append landing afterward and silently reverting the
// edit. Chaining onto one promise instead of dispatching each call's IndexedDB
// work immediately preserves call order regardless of what callers await.
let queue = Promise.resolve();
function enqueue(fn) {
    const run = queue.then(fn, fn);
    queue = run.then(() => {}, () => {});
    return run;
}

async function pruneRoom(db, roomCode, days) {
    const cutoff = Date.now() - days * DAY_MS;
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const range = IDBKeyRange.bound([roomCode, -Infinity], [roomCode, cutoff]);
        const req = tx.objectStore(STORE_NAME).index(ROOM_INDEX).openCursor(range);
        req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Persists one text message for later rejoin. Prunes anything older than the
 * configured retention window in the same room right after writing, so a
 * room's history never grows past its own retention setting.
 * @param {string} roomCode
 * @param {{messageId: string, sender: string, text: string, ts: number, isSelf: boolean}} entry
 * @returns {Promise<void>}
 */
export function appendMessage(roomCode, entry) {
    return enqueue(async () => {
        try {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).put({ ...entry, roomCode });
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
            await pruneRoom(db, roomCode, getRetentionDays());
        } catch {
            // Best-effort local persistence — a write failure (quota, disabled storage) must
            // never break live chat, which works fine with zero history behind it.
        }
    });
}

/**
 * Returns a room's remaining (not-yet-expired) history, oldest-first. Prunes
 * on read too, since a room can sit unopened long enough for its whole
 * cached history to go stale before this is ever called again.
 * @param {string} roomCode
 * @param {number} maxDays - current retention setting, in days.
 * @returns {Promise<Array<{messageId: string, sender: string, text: string, ts: number, isSelf: boolean}>>}
 */
export function getHistory(roomCode, maxDays) {
    return enqueue(async () => {
        try {
            const db = await openDb();
            await pruneRoom(db, roomCode, maxDays);
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const req = tx.objectStore(STORE_NAME).index(ROOM_INDEX).getAll(roomRange(roomCode));
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });
        } catch {
            return [];
        }
    });
}

/**
 * Updates a stored message's text in place (chat-edit propagation).
 * No-ops if the message was never persisted (history disabled at send time,
 * or already pruned).
 * @param {string} messageId
 * @param {string} text
 * @returns {Promise<void>}
 */
export function updateMessage(messageId, text) {
    return enqueue(async () => {
        try {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                const getReq = store.get(messageId);
                getReq.onsuccess = () => {
                    const record = getReq.result;
                    if (record) store.put({ ...record, text });
                };
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch {
            // best-effort, see appendMessage
        }
    });
}

/**
 * Removes one stored message (chat-delete propagation).
 * @param {string} messageId
 * @returns {Promise<void>}
 */
export function deleteMessage(messageId) {
    return enqueue(async () => {
        try {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).delete(messageId);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch {
            // best-effort, see appendMessage
        }
    });
}

/**
 * Wipes every room's history. Used by Settings' "Clear all local data" (which
 * only reaches localStorage on its own — this feature's data lives in
 * IndexedDB, outside that flat clear's scope) and the standalone
 * "Clear chat history" action.
 * @returns {Promise<void>}
 */
export function clearAll() {
    return enqueue(async () => {
        try {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).clear();
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch {
            // best-effort, see appendMessage
        }
    });
}

/**
 * Wipes a single room's history.
 * @param {string} roomCode
 * @returns {Promise<void>}
 */
export function clearRoom(roomCode) {
    return enqueue(async () => {
        try {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const req = tx.objectStore(STORE_NAME).index(ROOM_INDEX).openCursor(roomRange(roomCode));
                req.onsuccess = () => {
                    const cursor = req.result;
                    if (cursor) {
                        cursor.delete();
                        cursor.continue();
                    }
                };
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch {
            // best-effort, see appendMessage
        }
    });
}
