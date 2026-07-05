// --- public/client/App.js ---
import { PeerManager } from './PeerManager.js';
import { UIController } from './UIController.js';
import { DebugPanel } from './DebugPanel.js';
import { initTheme } from './ThemeManager.js';
import { SettingsPanel } from './SettingsPanel.js';
import { QuickRoomSettings } from './QuickRoomSettings.js';
import { InvitePopover } from './InvitePopover.js';
import { SidebarIdentity } from './SidebarIdentity.js';

initTheme();

const sessionId = location.pathname.split('/').pop();
const protocol = location.protocol === 'https:' ? 'wss' : 'ws';

const ui = new UIController();
const peerManager = new PeerManager(null, ui);
const debug = new DebugPanel(peerManager);
ui.onWatchChange = (streamKey, watched) => peerManager.setWatched(streamKey, watched);
ui.onPipExit = () => peerManager.handleTabVisibility(document.hidden);
ui.onModeratorAction = (action, peerId) => {
    if (action === 'stop-stream') peerManager.requestStopStream(peerId);
    else if (action === 'kick') peerManager.kickPeer(peerId);
    else if (action === 'promote') peerManager.promotePeer(peerId);
    else if (action === 'demote') peerManager.demotePeer(peerId);
};
peerManager.onActiveSpeakerChange = (peerId) => ui.autoFocusTo(peerId);
peerManager.onSpeakingChange = (peerId, speaking) => ui.setSpeaking(peerId, speaking);

let socket;
let reconnectTimer;
let leavingRoom = false;
let roomPassword = sessionStorage.getItem('roomPassword') || null;
const creatorToken = sessionStorage.getItem('creatorToken') || null;

// Server sends a fresh buildId (regenerated every process start) in every 'init'
// message. If it changes between our first connect and a later reconnect, the
// server was redeployed/restarted while we were open — nudge the user to refresh.
let knownBuildId = null;

function checkBuildId(buildId) {
    if (!buildId) return;
    if (knownBuildId === null) {
        knownBuildId = buildId;
        return;
    }
    if (buildId !== knownBuildId) {
        showUpdateBanner();
    }
}

function showUpdateBanner() {
    const banner = document.getElementById('update-banner');
    if (banner) banner.classList.remove('hidden');
}

function connect() {
    socket = new WebSocket(`${protocol}://${location.host}`);
    peerManager.socket = socket;
    debug.setSocket(socket);

    socket.onopen = () => {
        const joinMsg = { type: 'join', sessionId };
        if (roomPassword) joinMsg.password = roomPassword;
        if (creatorToken) joinMsg.creatorToken = creatorToken;
        socket.send(JSON.stringify(joinMsg));
    };

    socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'join-error') {
            clearTimeout(reconnectTimer);
            socket.close();
            if (msg.reason === 'room-full') {
                location.href = '/?full=1';
                return;
            }
            if (msg.reason === 'invalid-room') {
                location.href = '/';
                return;
            }
            showPasswordPrompt();
            return;
        }
        if (msg.type === 'kicked') {
            leavingRoom = true;
            clearTimeout(reconnectTimer);
            socket.close();
            location.href = '/?kicked=1';
            return;
        }
        if (msg.type === 'init') {
            checkBuildId(msg.buildId);
            ui.setRoomMeta({ name: msg.roomName, code: sessionId, hasPassword: msg.hasPassword, maxPeers: msg.maxPeers });
        }
        peerManager.handleSignal(msg);
    };

    socket.onclose = () => {
        clearTimeout(reconnectTimer);
        if (leavingRoom) return;
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

// Update banner — refresh applies the new build; dismiss just hides it for this tab
const updateBanner = document.getElementById('update-banner');
if (updateBanner) {
    document.getElementById('update-refresh-btn')?.addEventListener('click', () => location.reload());
    document.getElementById('update-dismiss-btn')?.addEventListener('click', () => updateBanner.classList.add('hidden'));
}

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
            ui.addPendingFiles([...e.dataTransfer.files]);
        }
    });
}

if (fileAttachBtn && fileInput) {
    fileAttachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const files = [...fileInput.files];
        fileInput.value = '';
        ui.addPendingFiles(files);
        // Pending-attachment chips render in the Chat tab's composer — switch there
        // so a file picked from the Files tab's dropzone card is actually visible.
        ui._switchTab('chat');
    });
}

document.getElementById('files-dropzone-card')?.addEventListener('click', () => fileInput?.click());

document.addEventListener('paste', (e) => {
    if (document.activeElement?.id === 'message' && e.clipboardData.files.length) {
        e.preventDefault();
        ui.addPendingFiles([...e.clipboardData.files]);
    }
});

// Poll
(function initPoll() {
    const modal = document.getElementById('poll-modal');
    const backdrop = document.getElementById('poll-backdrop');
    const optionsList = document.getElementById('poll-options-list');
    const questionInput = document.getElementById('poll-question');
    const validation = document.getElementById('poll-validation');

    function openModal() {
        modal.classList.remove('hidden');
        questionInput.focus();
    }

    function closeModal() {
        modal.classList.add('hidden');
        validation.classList.add('hidden');
        questionInput.value = '';
        optionsList.innerHTML = '';
        [1, 2].forEach(n => {
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'poll-option-input poll-input w-full surface-input rounded-lg px-3 py-2 text-sm';
            input.placeholder = `Option ${n}`;
            optionsList.appendChild(input);
        });
    }

    document.getElementById('poll-btn').addEventListener('click', openModal);
    backdrop.addEventListener('click', closeModal);
    document.getElementById('poll-cancel').addEventListener('click', closeModal);

    document.getElementById('poll-add-option').addEventListener('click', () => {
        const inputs = optionsList.querySelectorAll('.poll-option-input');
        if (inputs.length >= 6) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'poll-option-input w-full surface-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500/50';
        input.placeholder = `Option ${inputs.length + 1}`;
        optionsList.appendChild(input);
        input.focus();
    });

    document.getElementById('poll-create-submit').addEventListener('click', () => {
        const question = questionInput.value.trim();
        const options = [...optionsList.querySelectorAll('.poll-option-input')]
            .map(i => i.value.trim()).filter(v => v.length > 0);
        if (!question || options.length < 2) {
            validation.classList.remove('hidden');
            return;
        }
        const pollId = 'poll-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
        ui.addPollMessage('Me', pollId, question, options, peerManager.peerId);
        peerManager.broadcastPollCreate(pollId, question, options);
        closeModal();
    });

    ui.onPollVote = (pollId, optionIndex) => {
        ui.updatePollVote(pollId, optionIndex, peerManager.peerId);
        peerManager.broadcastPollVote(pollId, optionIndex);
    };
})();

// Reaction callback
ui._onReaction = (messageId, emoji) => {
    const nickname = (localStorage.getItem('nickname') || 'Anonymous').trim();
    peerManager.broadcastReaction(messageId, emoji, nickname);
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
    peerManager.broadcastTyping(typing);
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

document.getElementById('send-message-btn').addEventListener('click', () => sendMessage());

function sendMessage() {
    const text = input.value.trim();
    const nickname = (localStorage.getItem('nickname') || 'Anonymous').trim();
    const pendingFiles = ui.getPendingFiles();

    if (text) {
        const messageId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
        const reply = ui.getReplyTo();
        peerManager.broadcastChat(text, nickname, messageId, reply || null);
        ui.addChatMessage('Me', text, messageId, reply, true);
        ui.clearReply();
        input.value = '';
    }

    if (pendingFiles.length) {
        ui.clearPendingFiles();
        (async () => { for (const f of pendingFiles) await peerManager.sendFileToAll(f); })();
    }

    clearTimeout(typingTimer);
    sendTypingStatus(false);
}

function updateShareButton() {
    // Inline style, not the `.hidden` utility class: `.dock-btn` (tailwind.css, unlayered
    // custom rule) sets `display:flex` and beats Tailwind's layered `.hidden` utility in
    // the cascade regardless of source order — see CLAUDE.md's cascade-layers gotcha.
    document.getElementById('stop-share-button').style.display = peerManager.isSharing ? '' : 'none';
    document.getElementById('share-toggle').title = peerManager.isSharing ? 'Share a different window' : 'Share screen';
}

function updateCamUI(enabled) {
    document.getElementById('cam-off-icon').classList.toggle('hidden', enabled);
    document.getElementById('cam-on-icon').classList.toggle('hidden', !enabled);
    document.getElementById('cam-toggle').title = enabled ? 'Turn off Camera' : 'Turn on Camera';
}

document.getElementById('cam-toggle').addEventListener('click', async () => {
    const enabled = await peerManager.toggleCam();
    updateCamUI(enabled);
});

peerManager.onForceStopped = () => {
    updateShareButton();
    updateCamUI(false);
};

document.getElementById('share-toggle').onclick = async () => {
    await peerManager.startSharing();
    updateShareButton();
};

document.getElementById('stop-share-button').onclick = () => {
    peerManager.stopSharing();
    updateShareButton();
};

document.getElementById('stage-view-grid').addEventListener('click', () => {
    ui.setViewMode('grid');
});

document.getElementById('stage-view-focus').addEventListener('click', () => {
    ui.setViewMode('focus');
});

document.getElementById('leave-room-button').addEventListener('click', () => {
    leavingRoom = true;
    clearTimeout(reconnectTimer);
    socket?.close();
    window.location.href = '/';
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
        if (!isHidden) {
            const indicator = document.getElementById('new-message-indicator');
            if (indicator) indicator.classList.add('hidden');
        }
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
            if (collapsed) {
                membersSidebar.style.width = '';
            } else {
                const savedW = localStorage.getItem('membersWidth');
                if (savedW) membersSidebar.style.width = savedW + 'px';
            }
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

// --- Settings panel (redesign Phase 3 — see public/client/SettingsPanel.js) ---
const settingsPanel = new SettingsPanel({ ui, peerManager });
document.getElementById('settings-button').addEventListener('click', () => settingsPanel.open());

// --- Quick room settings popover (status/file-trust/follow-speaker/quality) ---
new QuickRoomSettings({ ui, peerManager, settingsPanel });

// --- Members sidebar footer identity (redesign Phase 2c) ---
new SidebarIdentity({ ui, peerManager, settingsPanel });

function updateMicUI(enabled) {
    document.getElementById('mic-off-icon').classList.toggle('hidden', enabled);
    document.getElementById('mic-on-icon').classList.toggle('hidden', !enabled);
    document.getElementById('mic-toggle').title = enabled ? 'Mute Microphone' : 'Unmute Microphone';
    if (peerManager.peerId) ui.updateParticipantMic(peerManager.peerId, enabled);
}

// Push-to-talk / push-to-mute keydown/keyup — mic mode/keybind live in
// localStorage (set by SettingsPanel), read fresh here rather than cached in a
// module variable, since the settings UI is the only writer.
window.addEventListener('keydown', (e) => {
    if (settingsPanel.isKeybindListening()) return;
    const micKeybind = localStorage.getItem('micKeybind') || '';
    if (!micKeybind || e.code !== micKeybind) return;
    if (e.repeat) return;
    const focused = document.activeElement;
    if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.tagName === 'SELECT')) return;

    const micMode = localStorage.getItem('micMode') || 'toggle';
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
    if (settingsPanel.isKeybindListening()) return;
    const micKeybind = localStorage.getItem('micKeybind') || '';
    if (!micKeybind || e.code !== micKeybind) return;
    const focused = document.activeElement;
    if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.tagName === 'SELECT')) return;

    const micMode = localStorage.getItem('micMode') || 'toggle';
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

// --- Invite popover (top bar) ---
new InvitePopover({ ui, roomCode: sessionId });

// --- Defaults ---
const defaults = {
    nickname: generateFunnyNickname(),
    screenShareRes: '1280x720',
    screenShareFps: '30',
    camRes: '640x480',
    camFps: '30',
    muteSounds: '0',
    soundVolume: '0.3',
    maxMessages: '100'
};

for (const [key, value] of Object.entries(defaults)) {
    if (localStorage.getItem(key) === null) {
        localStorage.setItem(key, value);
    }
}