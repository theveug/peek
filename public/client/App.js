// --- public/client/App.js ---
import { PeerManager } from './PeerManager.js';
import { UIController } from './UIController.js';
import { DebugPanel } from './DebugPanel.js';
import { initGradientBackground } from './GradientBackground.js';
import { initTheme } from './ThemeManager.js';

initTheme();
initGradientBackground();

const sessionId = location.pathname.split('/').pop();
const protocol = location.protocol === 'https:' ? 'wss' : 'ws';

const ui = new UIController();
const peerManager = new PeerManager(null, ui);
const debug = new DebugPanel(peerManager);

let socket;
let reconnectTimer;
let roomPassword = sessionStorage.getItem('roomPassword') || null;

function connect() {
    socket = new WebSocket(`${protocol}://${location.host}`);
    peerManager.socket = socket;
    debug.setSocket(socket);

    socket.onopen = () => {
        const joinMsg = { type: 'join', sessionId };
        if (roomPassword) joinMsg.password = roomPassword;
        socket.send(JSON.stringify(joinMsg));
    };

    socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'join-error') {
            clearTimeout(reconnectTimer);
            socket.close();
            showPasswordPrompt();
            return;
        }
        if (msg.type === 'chat') {
            if (msg.from !== peerManager.peerId) {
                const displayName = msg.nickname || msg.from;
                ui.addChatMessage(displayName, msg.text, msg.messageId, msg.replyTo || null);
                ui.updateTypingIndicator(msg.from, false);
            }
        } else if (msg.type === 'reaction') {
            ui.addReaction(msg.payload.messageId, msg.payload.emoji, msg.payload.nickname, msg.from);
        } else {
            if (msg.type === 'init' && msg.roomName) {
                const header = document.getElementById('room-header');
                if (header) {
                    header.textContent = msg.roomName;
                    header.classList.remove('hidden');
                }
            }
            peerManager.handleSignal(msg);
        }
    };

    socket.onclose = () => {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 2000);
    };
}

function showPasswordPrompt() {
    const modal = document.getElementById('password-modal');
    const form = document.getElementById('password-form');
    const input = document.getElementById('password-input');
    const error = document.getElementById('password-error');
    if (!modal) return;
    modal.classList.remove('hidden');
    input.focus();
    form.onsubmit = async (e) => {
        e.preventDefault();
        const pw = input.value;
        const res = await fetch('/api/validate-room', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: sessionId, password: pw }),
        });
        const result = await res.json();
        if (result.valid) {
            roomPassword = pw;
            sessionStorage.setItem('roomPassword', pw);
            modal.classList.add('hidden');
            error.classList.add('hidden');
            connect();
        } else {
            error.classList.remove('hidden');
            input.value = '';
            input.focus();
        }
    };
}

connect();

// File sharing — drag & drop, paste, button
const chatPanel = document.getElementById('chat');
const dropOverlay = document.getElementById('drop-zone-overlay');
const fileInput = document.getElementById('file-input');
const fileAttachBtn = document.getElementById('file-attach-btn');

if (chatPanel && dropOverlay) {
    chatPanel.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropOverlay.classList.add('active');
    });

    dropOverlay.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    dropOverlay.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = dropOverlay.getBoundingClientRect();
        if (e.clientX <= rect.left || e.clientX >= rect.right || e.clientY <= rect.top || e.clientY >= rect.bottom) {
            dropOverlay.classList.remove('active');
        }
    });

    dropOverlay.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropOverlay.classList.remove('active');
        if (e.dataTransfer.files.length) {
            [...e.dataTransfer.files].forEach(f => peerManager.sendFileToAll(f));
        }
    });
}

if (fileAttachBtn && fileInput) {
    fileAttachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        [...fileInput.files].forEach(f => peerManager.sendFileToAll(f));
        fileInput.value = '';
    });
}

document.addEventListener('paste', (e) => {
    if (document.activeElement?.id === 'message' && e.clipboardData.files.length) {
        e.preventDefault();
        [...e.clipboardData.files].forEach(f => peerManager.sendFileToAll(f));
    }
});

// Reaction callback
ui._onReaction = (messageId, emoji) => {
    const nickname = (localStorage.getItem('nickname') || 'Anonymous').trim();
    socket.send(JSON.stringify({ type: 'reaction', payload: { messageId, emoji, nickname } }));
    ui.addReaction(messageId, emoji, nickname, peerManager.peerId);
};

// Chat UI interactions
const input = document.getElementById('message');

function generateFunnyNickname() {
    const adjectives = ['Funky', 'Silly', 'Smart', 'Sneaky', 'Zesty', 'Wiggly', 'Cheesy', 'Invincible', 'Fluffy', 'Sassy', 'Bouncy', 'Wacky', 'Jumpy', 'Quirky', 'Spicy', 'Nerdy', 'Chill', 'Epic', 'Crazy', 'Dizzy'];
    const animals = ['Penguin', 'Llama', 'Nugget', 'Pineapple', 'Walrus', 'Donkey', 'Taco', 'Otter', 'Sloth', 'Panda', 'Koala', 'Narwhal', 'Turtle', 'Dolphin', 'Giraffe', 'Platypus', 'Octopus', 'Raccoon', 'Kangaroo', 'Cactus', 'Dragon'];

    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const animal = animals[Math.floor(Math.random() * animals.length)];

    return `${adj}${animal}${Math.floor(Math.random() * 1000)}`;
}
// Typing indicator debounce
let typingTimer = null;
let isTyping = false;

function sendTypingStatus(typing) {
    if (typing === isTyping) return;
    isTyping = typing;
    peerManager.send('typing', null, { isTyping: typing });
}

input.addEventListener('input', () => {
    sendTypingStatus(true);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => sendTypingStatus(false), 2000);
});

// Handle enter + shift logic
input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

function sendMessage() {
    const text = input.value.trim();
    const nickname = (localStorage.getItem('nickname') || 'Anonymous').trim();

    if (text) {
        const messageId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
        const reply = ui.getReplyTo();
        const chatMsg = { type: 'chat', text, nickname, messageId };
        if (reply) chatMsg.replyTo = { messageId: reply.messageId, sender: reply.sender, text: reply.text };
        socket.send(JSON.stringify(chatMsg));
        ui.addChatMessage('Me', text, messageId, reply);
        ui.clearReply();
        input.value = '';
    }
    clearTimeout(typingTimer);
    sendTypingStatus(false);
}

function updateShareButton() {
    document.getElementById('share-play-icon').classList.toggle('hidden', peerManager.isSharing);
    document.getElementById('share-stop-icon').classList.toggle('hidden', !peerManager.isSharing);
    document.getElementById('share-toggle').title = peerManager.isSharing ? 'Stop sharing' : 'Start sharing';
}

document.getElementById('share-toggle').onclick = async () => {
    if (peerManager.isSharing) {
        peerManager.stopSharing();
    } else {
        await peerManager.startSharing();
    }
    updateShareButton();
};

document.getElementById('grid-button').addEventListener('click', () => {
    ui.toggleViewMode();
});

document.getElementById('mic-toggle').addEventListener('click', async () => {
    const enabled = await peerManager.toggleMic();
    updateMicUI(enabled);
});

document.getElementById('deafen-toggle').addEventListener('click', () => {
    peerManager.deafened = !peerManager.deafened;
    document.querySelectorAll('audio').forEach(a => { a.muted = peerManager.deafened; });
    document.getElementById('deafen-off-icon').classList.toggle('hidden', peerManager.deafened);
    document.getElementById('deafen-on-icon').classList.toggle('hidden', !peerManager.deafened);
    document.getElementById('deafen-toggle').title = peerManager.deafened ? 'Undeafen' : 'Deafen';
    peerManager.broadcastDeafenStatus();
    if (peerManager.peerId) ui.updateParticipantDeafen(peerManager.peerId, peerManager.deafened);
});

// Self-view placeholder on any focus loss (window blur or tab hidden)
const handleFocusChange = () => {
    const blurred = document.hidden || !document.hasFocus();
    ui.handleVisibilityChange(blurred);
};
window.addEventListener('blur', handleFocusChange);
window.addEventListener('focus', handleFocusChange);

// Video pause + auto-away ONLY when tab is actually hidden (switched tabs),
// NOT when the window just loses focus (alt-tabbing to another app)
document.addEventListener('visibilitychange', () => {
    handleFocusChange();
    peerManager.handleTabVisibility(document.hidden);
});


// --- Mobile detection helper ---
function isMobile() {
    return window.innerWidth < 768;
}

const mobileBackdrop = document.getElementById('mobile-backdrop');

function closeMobilePanels() {
    const chatBox = document.getElementById('chat');
    const membersSidebar = document.getElementById('members-sidebar');
    if (chatBox) chatBox.classList.remove('mobile-open');
    if (membersSidebar) membersSidebar.classList.remove('mobile-open');
    if (mobileBackdrop) mobileBackdrop.classList.remove('active');
}

if (mobileBackdrop) {
    mobileBackdrop.addEventListener('click', closeMobilePanels);
}

const chatButton = document.getElementById('togglechat');
chatButton.addEventListener('click', () => {
    const chatBox = document.getElementById('chat');
    const handle = document.getElementById('chat-resize-handle');
    if (!chatBox) return;

    if (isMobile()) {
        const membersSidebar = document.getElementById('members-sidebar');
        if (membersSidebar) membersSidebar.classList.remove('mobile-open');
        const opening = !chatBox.classList.contains('mobile-open');
        chatBox.classList.toggle('mobile-open');
        if (mobileBackdrop) mobileBackdrop.classList.toggle('active', opening);
        if (opening) {
            const indicator = document.getElementById('new-message-indicator');
            if (indicator) indicator.classList.add('hidden');
        }
    } else {
        const isHidden = chatBox.classList.toggle('hidden');
        if (handle) handle.style.display = isHidden ? 'none' : '';
        localStorage.setItem('chatHidden', isHidden ? '1' : '0');
    }
});

const chatBox = document.getElementById('chat');
const chatHandle = document.getElementById('chat-resize-handle');
if (isMobile()) {
    // On mobile, visibility is controlled purely by the .mobile-open transform — leave 'hidden' untouched.
} else if (localStorage.getItem('chatHidden') === '1') {
    chatBox.classList.add('hidden');
    if (chatHandle) chatHandle.style.display = 'none';
} else {
    chatBox.classList.remove('hidden');
}

// Resizable chat panel (width persists to localStorage) — desktop only
(function initChatResize() {
    const handle = document.getElementById('chat-resize-handle');
    const chat = document.getElementById('chat');
    if (!handle || !chat) return;
    const savedW = localStorage.getItem('chatWidth');
    if (savedW && !isMobile()) chat.style.width = savedW + 'px';
    let startX, startW;
    handle.addEventListener('mousedown', (e) => {
        if (isMobile()) return;
        e.preventDefault();
        startX = e.clientX;
        startW = chat.offsetWidth;
        handle.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        const onMove = (e) => {
            const w = Math.max(240, Math.min(window.innerWidth * 0.5, startW + (e.clientX - startX)));
            chat.style.width = w + 'px';
        };
        const onUp = () => {
            handle.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            localStorage.setItem('chatWidth', chat.offsetWidth);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });
})();

// Members sidebar toggle
const membersToggle = document.getElementById('toggle-members');
const membersSidebar = document.getElementById('members-sidebar');
const membersHandle = document.getElementById('members-resize-handle');
if (membersToggle && membersSidebar) {
    if (!isMobile() && localStorage.getItem('membersHidden') === '1') {
        membersSidebar.classList.add('collapsed');
        if (membersHandle) membersHandle.style.display = 'none';
    }
    membersToggle.addEventListener('click', () => {
        if (isMobile()) {
            const chatBox = document.getElementById('chat');
            if (chatBox) chatBox.classList.remove('mobile-open');
            const opening = !membersSidebar.classList.contains('mobile-open');
            membersSidebar.classList.toggle('mobile-open');
            if (mobileBackdrop) mobileBackdrop.classList.toggle('active', opening);
        } else {
            const collapsed = membersSidebar.classList.toggle('collapsed');
            if (membersHandle) membersHandle.style.display = collapsed ? 'none' : '';
            localStorage.setItem('membersHidden', collapsed ? '1' : '0');
        }
    });
}

// Resizable members panel (width persists to localStorage) — desktop only
(function initMembersResize() {
    const handle = document.getElementById('members-resize-handle');
    const panel = document.getElementById('members-sidebar');
    if (!handle || !panel) return;
    const savedW = localStorage.getItem('membersWidth');
    if (savedW && !isMobile()) panel.style.width = savedW + 'px';
    let startX, startW;
    handle.addEventListener('mousedown', (e) => {
        if (isMobile()) return;
        e.preventDefault();
        startX = e.clientX;
        startW = panel.offsetWidth;
        handle.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        const onMove = (e) => {
            const w = Math.max(160, Math.min(window.innerWidth * 0.4, startW - (e.clientX - startX)));
            panel.style.width = w + 'px';
        };
        const onUp = () => {
            handle.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            localStorage.setItem('membersWidth', panel.offsetWidth);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });
})();

// Close mobile panels on resize to desktop
window.addEventListener('resize', () => {
    if (!isMobile()) {
        closeMobilePanels();
    }
});

// --- Settings modal ---
const settingsModal = document.getElementById('settings-modal');
const settingsForm = document.getElementById('settings-form');

function openSettings() {
    document.getElementById('settings-nickname').value = localStorage.getItem('nickname') || '';
    document.getElementById('settings-mute').checked = localStorage.getItem('muteSounds') === '1';
    document.getElementById('settings-res').value = localStorage.getItem('screenShareRes') || '1280x720';
    document.getElementById('settings-fps').value = localStorage.getItem('screenShareFps') || '30';
    document.getElementById('settings-max-messages').value = localStorage.getItem('maxMessages') || '100';
    const vol = localStorage.getItem('soundVolume') || '0.3';
    document.getElementById('settings-volume').value = vol;
    document.getElementById('settings-volume-value').textContent = `${Math.round(vol * 100)}%`;
    settingsModal.classList.remove('hidden');
    highlightCurrentStatus();
    highlightMicMode();
}

function closeSettings() {
    settingsModal.classList.add('hidden');
}

document.getElementById('settings-volume').addEventListener('input', (e) => {
    document.getElementById('settings-volume-value').textContent = `${Math.round(e.target.value * 100)}%`;
});

settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    localStorage.setItem('nickname', document.getElementById('settings-nickname').value.trim());
    localStorage.setItem('muteSounds', document.getElementById('settings-mute').checked ? '1' : '0');
    localStorage.setItem('screenShareRes', document.getElementById('settings-res').value);
    localStorage.setItem('screenShareFps', document.getElementById('settings-fps').value);
    localStorage.setItem('maxMessages', document.getElementById('settings-max-messages').value);
    localStorage.setItem('soundVolume', document.getElementById('settings-volume').value);
    peerManager.applyQualitySettings();
    peerManager.broadcastNickname();
    if (peerManager.peerId) {
        ui.updateParticipantNickname(peerManager.peerId, document.getElementById('settings-nickname').value.trim());
    }
    closeSettings();
});

document.getElementById('settings-button').addEventListener('click', openSettings);
document.getElementById('close-settings').addEventListener('click', closeSettings);
document.getElementById('cancel-settings').addEventListener('click', closeSettings);
document.getElementById('settings-backdrop').addEventListener('click', closeSettings);

// Status picker
document.querySelectorAll('#status-picker .status-pick').forEach(btn => {
    btn.addEventListener('click', () => {
        const status = btn.dataset.status;
        peerManager.setManualStatus(status);
        document.querySelectorAll('#status-picker .status-pick').forEach(b => {
            b.classList.toggle('ring-1', b === btn);
            b.classList.toggle('ring-indigo-500', b === btn);
        });
    });
});

function highlightCurrentStatus() {
    const current = peerManager.status || 'online';
    document.querySelectorAll('#status-picker .status-pick').forEach(b => {
        b.classList.toggle('ring-1', b.dataset.status === current);
        b.classList.toggle('ring-indigo-500', b.dataset.status === current);
    });
}

// --- Mic mode & keybinds ---
let micMode = localStorage.getItem('micMode') || 'toggle';
let micKeybind = localStorage.getItem('micKeybind') || '';
let keybindListening = false;

function updateMicUI(enabled) {
    document.getElementById('mic-off-icon').classList.toggle('hidden', enabled);
    document.getElementById('mic-on-icon').classList.toggle('hidden', !enabled);
    document.getElementById('mic-toggle').title = enabled ? 'Mute Microphone' : 'Unmute Microphone';
    if (peerManager.peerId) ui.updateParticipantMic(peerManager.peerId, enabled);
}

function highlightMicMode() {
    const keybindRow = document.getElementById('keybind-row');
    document.querySelectorAll('.mic-mode-pick').forEach(b => {
        const active = b.dataset.micMode === micMode;
        b.classList.toggle('ring-1', active);
        b.classList.toggle('ring-indigo-500', active);
    });
    if (keybindRow) keybindRow.classList.toggle('hidden', micMode === 'toggle');
    const keybindInput = document.getElementById('settings-keybind');
    if (keybindInput) keybindInput.value = micKeybind || '';
}

document.querySelectorAll('.mic-mode-pick').forEach(btn => {
    btn.addEventListener('click', () => {
        micMode = btn.dataset.micMode;
        localStorage.setItem('micMode', micMode);
        highlightMicMode();
    });
});

const keybindInput = document.getElementById('settings-keybind');
if (keybindInput) {
    keybindInput.addEventListener('click', () => {
        keybindListening = true;
        keybindInput.value = 'Press a key...';
        keybindInput.classList.add('ring-1', 'ring-indigo-500');
    });

    keybindInput.addEventListener('keydown', (e) => {
        if (!keybindListening) return;
        e.preventDefault();
        e.stopPropagation();
        micKeybind = e.code;
        localStorage.setItem('micKeybind', micKeybind);
        keybindInput.value = e.code;
        keybindInput.classList.remove('ring-1', 'ring-indigo-500');
        keybindListening = false;
    });

    keybindInput.addEventListener('blur', () => {
        if (keybindListening) {
            keybindInput.value = micKeybind || '';
            keybindInput.classList.remove('ring-1', 'ring-indigo-500');
            keybindListening = false;
        }
    });
}

const keybindClear = document.getElementById('keybind-clear');
if (keybindClear) {
    keybindClear.addEventListener('click', () => {
        micKeybind = '';
        localStorage.setItem('micKeybind', '');
        if (keybindInput) keybindInput.value = '';
    });
}

// Push-to-talk / push-to-mute keydown/keyup
window.addEventListener('keydown', (e) => {
    if (keybindListening) return;
    if (!micKeybind || e.code !== micKeybind) return;
    if (e.repeat) return;
    const focused = document.activeElement;
    if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.tagName === 'SELECT')) return;

    if (micMode === 'push-to-talk') {
        if (!peerManager.micStream) {
            peerManager.toggleMic().then(enabled => updateMicUI(enabled));
        } else if (!peerManager.micEnabled) {
            peerManager.toggleMic().then(enabled => updateMicUI(enabled));
        }
    } else if (micMode === 'push-to-mute') {
        if (peerManager.micEnabled) {
            peerManager.toggleMic().then(enabled => updateMicUI(enabled));
        }
    }
});

window.addEventListener('keyup', (e) => {
    if (keybindListening) return;
    if (!micKeybind || e.code !== micKeybind) return;
    const focused = document.activeElement;
    if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.tagName === 'SELECT')) return;

    if (micMode === 'push-to-talk') {
        if (peerManager.micEnabled) {
            peerManager.toggleMic().then(enabled => updateMicUI(enabled));
        }
    } else if (micMode === 'push-to-mute') {
        if (!peerManager.micEnabled && peerManager.micStream) {
            peerManager.toggleMic().then(enabled => updateMicUI(enabled));
        }
    }
});

const shareButton = document.getElementById('share-button');
if (shareButton) {
    shareButton.addEventListener('click', () => {
        navigator.clipboard.writeText(window.location.href);
    });
}

// --- Defaults ---
const defaults = {
    nickname: generateFunnyNickname(),
    screenShareRes: '1280x720',
    screenShareFps: '30',
    muteSounds: '0',
    soundVolume: '0.3',
    maxMessages: '100'
};

for (const [key, value] of Object.entries(defaults)) {
    if (localStorage.getItem(key) === null) {
        localStorage.setItem(key, value);
    }
}