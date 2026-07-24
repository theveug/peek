// --- public/client/lobby.js ---
// Lobby page logic — was an inline <script type="module"> in lobby.html until
// 2026-07-07, externalized so the Content-Security-Policy can be a strict
// `script-src 'self'` with no 'unsafe-inline'. Same module semantics (deferred),
// so behavior is unchanged.
import { initTheme } from '/client/ThemeManager.js';
import { saveRoom } from '/client/savedRooms.js';
import { SettingsPanel } from '/client/SettingsPanel.js';
import { initTooltips } from '/client/Tooltip.js';
import { RoomRail } from '/client/RoomRail.js';

initTheme();
initTooltips();

const settingsPanel = new SettingsPanel();
document.getElementById('settings-button').addEventListener('click', () => settingsPanel.open());

const roomRail = new RoomRail({ currentRoomCode: null, navigate: (url) => { window.location.href = url; } });

if (new URLSearchParams(location.search).get('new')) {
    document.getElementById('create-name')?.focus();
}

if (new URLSearchParams(location.search).get('full')) {
    const fullRoomError = document.getElementById('join-error');
    fullRoomError.textContent = 'Room is full.';
    fullRoomError.classList.remove('hidden');
}

if (new URLSearchParams(location.search).get('kicked')) {
    const kickedError = document.getElementById('join-error');
    kickedError.textContent = 'You were removed from that room by the moderator.';
    kickedError.classList.remove('hidden');
}

if (new URLSearchParams(location.search).get('banned')) {
    const bannedError = document.getElementById('join-error');
    bannedError.textContent = 'You were banned from that room by the moderator.';
    bannedError.classList.remove('hidden');
}

// Max-participants stepper (min 2, max 12, default 6)
const maxPeersInput = document.getElementById('create-max-peers');
document.getElementById('create-max-peers-dec').addEventListener('click', () => {
    maxPeersInput.value = String(Math.max(2, Number(maxPeersInput.value) - 1));
});
document.getElementById('create-max-peers-inc').addEventListener('click', () => {
    maxPeersInput.value = String(Math.min(12, Number(maxPeersInput.value) + 1));
});

// Create room
const createBtn = document.querySelector('#create-form button[type="submit"]');
const createBtnLabel = createBtn.innerHTML;
const createSaveCheckbox = document.getElementById('create-save-room');
const createSaveLabel = document.getElementById('create-save-label');
createSaveCheckbox.addEventListener('change', () => {
    createSaveLabel.classList.toggle('hidden', !createSaveCheckbox.checked);
});

document.getElementById('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    createBtn.disabled = true;
    createBtn.textContent = 'Creating...';
    try {
        const name = document.getElementById('create-name').value.trim();
        const password = document.getElementById('create-password').value;
        const maxPeers = maxPeersInput.value;
        const micPolicy = document.getElementById('create-ptt')?.checked ? 'ptt' : 'open';
        const res = await fetch('/api/create-room', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name || null, password: password || null, maxPeers, micPolicy }),
        });
        const { code, creatorToken } = await res.json();
        // Always set-or-clear, never leave a previous room's password
        // sitting in this flat, non-room-scoped sessionStorage key —
        // otherwise a later passwordless room silently inherits it via
        // the server's lazy-recreate-adopts-joiner's-password path.
        if (password) {
            sessionStorage.setItem('roomPassword', password);
        } else {
            sessionStorage.removeItem('roomPassword');
        }
        sessionStorage.setItem('creatorToken', creatorToken);
        if (createSaveCheckbox.checked) {
            saveRoom({ code, label: createSaveLabel.value || name, password });
        }
        createBtn.textContent = 'Joining...';
        window.location.href = '/' + code;
    } catch {
        createBtn.disabled = false;
        createBtn.innerHTML = createBtnLabel;
    }
});

// Join room
const joinForm = document.getElementById('join-form');
const joinCode = document.getElementById('join-code');
const joinPasswordRow = document.getElementById('join-password-row');
const joinPassword = document.getElementById('join-password');
const joinError = document.getElementById('join-error');
const joinRoomName = document.getElementById('join-room-name');
const joinSaveCheckbox = document.getElementById('join-save-room');
const joinSaveLabel = document.getElementById('join-save-label');
joinSaveCheckbox.addEventListener('change', () => {
    joinSaveLabel.classList.toggle('hidden', !joinSaveCheckbox.checked);
});

const joinBtn = joinForm.querySelector('button[type="submit"]');
const joinBtnLabel = joinBtn.innerHTML;

// Shared by the manual join form and "Rejoin" clicks on recent rooms.
// Returns true on success (caller navigates away), false to let the caller re-show its own UI.
async function attemptJoin(code, password, { onNeedsPassword, onWrongPassword, onFull } = {}) {
    const res = await fetch('/api/validate-room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, password: password || null }),
    });
    const result = await res.json();

    if (result.full) {
        onFull?.(result);
        return false;
    }
    if (result.needsPassword) {
        if (result.wrongPassword) onWrongPassword?.(result);
        else onNeedsPassword?.(result);
        return false;
    }
    // Same reasoning as the create-room handler above: always
    // set-or-clear so a stale password from a previously joined
    // room can't leak into this one.
    if (password) {
        sessionStorage.setItem('roomPassword', password);
    } else {
        sessionStorage.removeItem('roomPassword');
    }
    window.location.href = '/' + code;
    return true;
}

joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = joinCode.value.trim();
    if (code.length !== 5) return;

    joinBtn.disabled = true;
    joinBtn.textContent = 'Joining...';
    const password = joinPassword.value;
    try {
        const joined = await attemptJoin(code, password, {
            onFull: () => {
                joinError.textContent = 'Room is full.';
                joinError.classList.remove('hidden');
            },
            onNeedsPassword: (result) => {
                joinPasswordRow.classList.remove('hidden');
                joinPassword.focus();
                if (result.name) {
                    joinRoomName.textContent = `Room: ${result.name}`;
                    joinRoomName.classList.remove('hidden');
                }
            },
            onWrongPassword: (result) => {
                joinPasswordRow.classList.remove('hidden');
                joinPassword.focus();
                if (result.name) {
                    joinRoomName.textContent = `Room: ${result.name}`;
                    joinRoomName.classList.remove('hidden');
                }
                joinError.textContent = 'Wrong password. Try again.';
                joinError.classList.remove('hidden');
            },
        });
        if (joined) {
            joinError.classList.add('hidden');
            if (joinSaveCheckbox.checked) {
                saveRoom({ code, label: joinSaveLabel.value || code, password });
            }
            return;
        }
    } catch {
        // fall through to re-enable button below
    }
    joinBtn.disabled = false;
    joinBtn.innerHTML = joinBtnLabel;
});

// Auto-uppercase room code; typed input is stripped to alphanumeric as before,
// but a pasted link (e.g. https://peek.app/AB12C) is reduced to its trailing code.
joinCode.addEventListener('input', () => {
    joinCode.value = joinCode.value.replace(/[^A-Za-z0-9]/g, '').slice(-5);
});
joinCode.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    if (!text) return;
    e.preventDefault();
    joinCode.value = text.replace(/[^A-Za-z0-9]/g, '').slice(-5);
});
