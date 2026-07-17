// --- public/client/App.js ---
import { PeerManager } from './PeerManager.js';
import { UIController } from './UIController.js';
import { DebugPanel } from './DebugPanel.js';
import { initTheme } from './ThemeManager.js';
import { SettingsPanel } from './SettingsPanel.js';
import { QuickRoomSettings } from './QuickRoomSettings.js';
import { InvitePopover } from './InvitePopover.js';
import { TopbarIdentity } from './TopbarIdentity.js';
import { initTooltips } from './Tooltip.js';
import { openEmojiPicker } from './EmojiPicker.js';
import { getOwnerToken, setOwnerToken } from './ownerTokens.js';

initTooltips();

initTheme();

const sessionId = location.pathname.split('/').pop();
const protocol = location.protocol === 'https:' ? 'wss' : 'ws';

const ui = new UIController();
const peerManager = new PeerManager(null, ui);
const debug = new DebugPanel(peerManager);
ui.onWatchChange = (streamKey, watched) => peerManager.setWatched(streamKey, watched);
ui.onEditMessage = (messageId, text) => peerManager.broadcastChatEdit(messageId, text);
ui.onDeleteMessage = (messageId) => peerManager.broadcastChatDelete(messageId);
ui.onPinMessage = (messageId) => peerManager.broadcastPin(messageId);
ui.onUnpinMessage = (messageId) => peerManager.broadcastUnpin(messageId);
ui.onPipExit = () => peerManager.handleTabVisibility(document.hidden);
ui.onModeratorAction = (action, peerId) => {
    if (action === 'stop-stream') peerManager.requestStopStream(peerId);
    else if (action === 'kick') peerManager.kickPeer(peerId);
    else if (action === 'ban') peerManager.banPeer(peerId, ui._peerNickname(peerId));
    else if (action === 'promote') peerManager.promotePeer(peerId);
    else if (action === 'demote') peerManager.demotePeer(peerId);
};
peerManager.onActiveSpeakerChange = (peerId) => ui.autoFocusTo(peerId);
peerManager.onSpeakingChange = (peerId, speaking) => ui.setSpeaking(peerId, speaking);

let socket;
let reconnectTimer;
let leavingRoom = false;
let roomPassword = sessionStorage.getItem('roomPassword') || null;
// `let`, not `const`: joining a code with no live session lazily creates the
// room, and the server mints + returns a creator token in 'init' — it must be
// adopted here so reconnects within this tab re-claim ownership. Falls back
// to the localStorage-backed ownerTokens store (survives a closed browser or
// restarted PC — sessionStorage alone doesn't) when this tab is a fresh
// session with nothing in sessionStorage: this matters even when the room
// never emptied out (another peer kept it alive), since the lazy-recreate
// path that would otherwise mint a fresh owner never triggers in that case.
let creatorToken = sessionStorage.getItem('creatorToken') || getOwnerToken(sessionId) || null;
if (creatorToken) {
    sessionStorage.setItem('creatorToken', creatorToken);
    setOwnerToken(sessionId, creatorToken);
}

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
            if (msg.reason === 'banned') {
                // leavingRoom stops the onclose auto-reconnect from
                // re-attempting the banned join.
                leavingRoom = true;
                location.href = '/?banned=1';
                return;
            }
            showPasswordPrompt();
            return;
        }
        if (msg.type === 'kicked' || msg.type === 'banned') {
            leavingRoom = true;
            clearTimeout(reconnectTimer);
            socket.close();
            location.href = msg.type === 'banned' ? '/?banned=1' : '/?kicked=1';
            return;
        }
        if (msg.type === 'init') {
            checkBuildId(msg.buildId);
            ui.setRoomMeta({ name: msg.roomName, code: sessionId, hasPassword: msg.hasPassword, maxPeers: msg.maxPeers });
            // Present only when this join lazily created the room, making us
            // its owner — persist like lobby.js does for /api/create-room.
            if (msg.creatorToken) {
                creatorToken = msg.creatorToken;
                sessionStorage.setItem('creatorToken', msg.creatorToken);
                setOwnerToken(sessionId, msg.creatorToken);
            }
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

// Composer "+" dropup — folds attach-file/create-poll into one menu instead of
// two permanent buttons flanking the textarea. The two actions' own click
// handlers (above, and in the poll IIFE below) are unchanged; this only owns
// opening/closing the menu around them.
(function initComposerPlusMenu() {
    const btn = document.getElementById('composer-plus-btn');
    const menu = document.getElementById('composer-plus-menu');
    if (!btn || !menu) return;

    const close = () => menu.classList.add('hidden');

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.toggle('hidden');
    });
    menu.querySelectorAll('button').forEach(option => {
        option.addEventListener('click', close);
    });
    document.addEventListener('click', (e) => {
        if (menu.classList.contains('hidden')) return;
        if (menu.contains(e.target) || e.target === btn) return;
        close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !menu.classList.contains('hidden')) close();
    });
})();

function insertAtCaret(el, text) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + text.length;
}

document.getElementById('composer-emoji-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    // Anchor to the persistent "+" trigger, not this button itself — by the
    // time this listener runs, initComposerPlusMenu's own generic
    // close-on-any-option-click listener (registered first, so it runs
    // first) has already hidden the menu this button lives in, which would
    // zero out this button's own getBoundingClientRect().
    openEmojiPicker(document.getElementById('composer-plus-btn'), (emoji) => {
        insertAtCaret(input, emoji);
        autoGrowMessageInput();
        input.focus();
    });
});

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
        const nickname = (localStorage.getItem('nickname') || 'Anonymous').trim();
        ui.addPollMessage(nickname, pollId, question, options, peerManager.peerId, true, peerManager.peerId);
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

// Clicking anywhere in the composer bar (its padding, the gap between the
// +/send buttons and the textarea, etc.) focuses the message input — not
// just clicking the textarea's own rendered box, which can be much shorter
// than the full bar height/width. Excludes the +/send buttons and the "+"
// dropup menu's own options so their clicks aren't hijacked into a focus.
document.getElementById('chat-input')?.addEventListener('click', (e) => {
    if (e.target.closest('.composer-plus-wrap, #send-message-btn')) return;
    input.focus();
});

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

// Auto-grow the composer as you type multi-line/markdown messages, up to
// .chat-composer-input's existing `max-height: 6em` — the textarea's default
// overflow:auto takes over (internal scroll) once content exceeds that, so
// there's nothing to clamp here beyond letting the CSS cap do its job.
function autoGrowMessageInput() {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
}

input.addEventListener('input', () => {
    autoGrowMessageInput();
    sendTypingStatus(true);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => sendTypingStatus(false), 2000);
});

// Discord-style: Enter inside an unclosed ``` fence inserts a newline instead
// of sending, since a fenced code block is the one case where you actually
// want multiple lines without reaching for Shift+Enter every time.
function isInsideOpenCodeFence(text, caretPos) {
    const fenceCount = (text.slice(0, caretPos).match(/```/g) || []).length;
    return fenceCount % 2 === 1;
}

// Handle enter + shift logic
input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        if (isInsideOpenCodeFence(input.value, input.selectionStart)) return;
        e.preventDefault();
        sendMessage();
    }
});

document.getElementById('send-message-btn').addEventListener('click', () => sendMessage());

function sendMessage() {
    const text = input.value.trim();
    const nickname = (localStorage.getItem('nickname') || 'Anonymous').trim();
    const pendingFiles = ui.getPendingFiles();
    const reply = ui.getReplyTo();
    const messageId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);

    // Files (with an optional caption) and a lone text message are mutually
    // exclusive sends: a caption typed alongside staged attachments rides along
    // in the file-offer metadata as one combined bubble instead of going out as
    // its own separate chat message immediately followed by the file(s).
    if (pendingFiles.length) {
        ui.clearPendingFiles();
        peerManager.sendFilesWithCaption(pendingFiles, text || null, reply || null, messageId);
        ui.clearReply();
        input.value = '';
        autoGrowMessageInput();
    } else if (text) {
        peerManager.broadcastChat(text, nickname, messageId, reply || null);
        ui.addChatMessage(nickname, text, messageId, reply, true, peerManager.peerId);
        ui.clearReply();
        input.value = '';
        autoGrowMessageInput();
    }

    clearTimeout(typingTimer);
    sendTypingStatus(false);
}

function updateShareButton() {
    // Inline style, not the `.hidden` utility class: `.dock-btn` (tailwind.css, unlayered
    // custom rule) sets `display:flex` and beats Tailwind's layered `.hidden` utility in
    // the cascade regardless of source order — see CLAUDE.md's cascade-layers gotcha.
    document.getElementById('stop-share-button').style.display = peerManager.isSharing ? '' : 'none';
    document.getElementById('share-toggle').dataset.tip = peerManager.isSharing ? 'Share a different window' : 'Share screen';
}

function updateCamUI(enabled) {
    document.getElementById('cam-off-icon').classList.toggle('hidden', enabled);
    document.getElementById('cam-on-icon').classList.toggle('hidden', !enabled);
    document.getElementById('cam-toggle').dataset.tip = enabled ? 'Turn off Camera' : 'Turn on Camera';
    document.getElementById('switch-cam-button').style.display = (enabled && hasMultipleCameras) ? '' : 'none';
}

document.getElementById('cam-toggle').addEventListener('click', async () => {
    const enabled = await peerManager.toggleCam();
    // enumerateDevices() at page load (below) runs before camera permission has ever
    // been granted — on mobile browsers (notably iOS Safari) device labels/count for a
    // given media kind are withheld until that kind's permission is granted at least
    // once, so the initial hasMultipleCameras check can undercount. Re-check now that
    // getUserMedia({video}) has actually resolved and permission is confirmed granted.
    if (enabled) {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            hasMultipleCameras = devices.filter(d => d.kind === 'videoinput').length > 1;
        } catch { /* keep whatever the page-load check found */ }
    }
    updateCamUI(enabled);
});

document.getElementById('switch-cam-button').addEventListener('click', () => {
    peerManager.switchCamera();
});

// getDisplayMedia (screen share) isn't implemented in any mobile browser (iOS WebKit
// or Android) — hide the button entirely rather than let it silently no-op on click.
if (!navigator.mediaDevices?.getDisplayMedia) {
    document.getElementById('share-toggle').style.display = 'none';
}

// Only worth offering camera switching if the device actually has more than one.
let hasMultipleCameras = false;
navigator.mediaDevices?.enumerateDevices?.().then(devices => {
    hasMultipleCameras = devices.filter(d => d.kind === 'videoinput').length > 1;
    updateCamUI(peerManager.camEnabled);
}).catch(() => {});

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
    // Don't let this room's password/creator-token survive into whatever room
    // gets created/joined next in this tab — see lobby.html's create/join
    // handlers for the matching set-or-clear fix on the other end of this bug.
    sessionStorage.removeItem('roomPassword');
    sessionStorage.removeItem('creatorToken');
    window.location.href = '/';
});

// Manual mic toggle — the mic button's click and the Toggle Mute keybind
// (below) both call this. Mirrors toggleDeafen()'s click+keybind sharing.
async function toggleMicManual() {
    // In a push-to-talk room the button/key can only mute — opening the mic
    // is exclusively hold-the-keybind, so this can't sidestep the room rule.
    // (Local-only toast, not a system message: nothing room-visible happened.)
    if (peerManager.micPolicy === 'ptt' && !peerManager.micEnabled) {
        ui.showToast('This room is push-to-talk — hold your Push to Talk keybind to talk');
        return;
    }
    const enabled = await peerManager.toggleMic();
    updateMicUI(enabled);
}

document.getElementById('mic-toggle').addEventListener('click', toggleMicManual);

// Applies deafened state to the DOM: incoming-audio muting, the deafen
// button's icon/tooltip, the participant-card badge, and the mic button
// (peerManager.setDeafened may have hard-muted/restored the mic alongside
// the deafen itself, so the mic icon needs to stay in sync too).
function setDeafenUI(deafened) {
    document.querySelectorAll('audio').forEach(a => { a.muted = deafened; });
    document.getElementById('deafen-off-icon').classList.toggle('hidden', deafened);
    document.getElementById('deafen-on-icon').classList.toggle('hidden', !deafened);
    document.getElementById('deafen-toggle').dataset.tip = deafened ? 'Undeafen' : 'Deafen';
    // Same reused `.dock-btn-active-red` treatment as the mic button (see updateMicUI).
    document.getElementById('deafen-toggle').classList.toggle('dock-btn-active-red', deafened);
    if (peerManager.peerId) ui.updateParticipantDeafen(peerManager.peerId, deafened);
    updateMicUI(peerManager.micEnabled);
}

// Manual deafen toggle — the button click and the global keybind below both
// call this. Never used for the auto-deafen-on-away path, which calls
// peerManager.setDeafened directly with {auto: true} so a manual toggle here
// always clears that flag (see setDeafened's opts doc).
function toggleDeafen() {
    peerManager.setDeafened(!peerManager.deafened);
    setDeafenUI(peerManager.deafened);
}

document.getElementById('deafen-toggle').addEventListener('click', toggleDeafen);

// Raise hand — a pure presence signal (no media side effects): broadcasts over
// the same WS relay path as mic/deafen status, lights the dock button amber
// while up, and PeerManager mirrors it onto our own participant card + the
// sidebar's raised-hands queue via ui.updateParticipantHand.
document.getElementById('raise-hand-toggle').addEventListener('click', () => {
    const raised = !peerManager.handRaised;
    peerManager.setHandRaised(raised);
    const btn = document.getElementById('raise-hand-toggle');
    btn.classList.toggle('dock-btn-active-amber', raised);
    btn.dataset.tip = raised ? 'Lower hand' : 'Raise hand';
});

// --- Quick popovers off the dock buttons (deafen volume, screen/cam
// quality+fps, mic options) — all share one caret+popover pattern, and all
// close each other when one opens, so the controls bar never shows two of
// these stacked on top of each other ("clicked cam quality, screen quality
// was still open" was reported and is exactly what _quickPopovers fixes).

const _quickPopovers = [];

/**
 * Wires a caret button to show/hide its popover, closing every other
 * registered quick popover first (see _quickPopovers above), and closing on
 * any outside click. `onOpen` (if given) runs every time the popover is
 * about to become visible, so callers can resync their controls from
 * localStorage — values can have changed via another surface (full
 * Settings, QuickRoomSettings) since this popover was last opened.
 * @param {string} caretId
 * @param {string} popoverId
 * @param {() => void} [onOpen]
 * @returns {void}
 */
function wireQuickPopover(caretId, popoverId, onOpen) {
    const caret = document.getElementById(caretId);
    const popover = document.getElementById(popoverId);
    if (!caret || !popover) return;
    _quickPopovers.push(popover);
    caret.addEventListener('click', (e) => {
        e.stopPropagation();
        const opening = popover.classList.contains('hidden');
        _quickPopovers.forEach(p => { if (p !== popover) p.classList.add('hidden'); });
        if (opening) {
            onOpen?.();
            popover.classList.remove('hidden');
        } else {
            popover.classList.add('hidden');
        }
    });
    popover.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', (e) => {
        if (!popover.contains(e.target) && !caret.contains(e.target)) {
            popover.classList.add('hidden');
        }
    });
}

// Deafen-button volume popover — second surface for the same `masterCallVolume`
// value the Settings panel controls, for in-call quick access. Not a second
// data model: same ui.setMasterCallVolume()/localStorage key.
const deafenVolumeSlider = document.getElementById('deafen-volume-slider');
const deafenVolumeValue = document.getElementById('deafen-volume-value');
wireQuickPopover('deafen-volume-caret', 'deafen-volume-popover', () => {
    if (deafenVolumeSlider) deafenVolumeSlider.value = String(ui.masterCallVolume);
    if (deafenVolumeValue) deafenVolumeValue.textContent = `${Math.round(ui.masterCallVolume * 100)}%`;
});
deafenVolumeSlider?.addEventListener('input', (e) => {
    e.stopPropagation();
    const value = parseFloat(e.target.value);
    if (deafenVolumeValue) deafenVolumeValue.textContent = `${Math.round(value * 100)}%`;
    ui.setMasterCallVolume(value);
});
deafenVolumeSlider?.addEventListener('click', (e) => e.stopPropagation());

/**
 * Wires one segmented button-group (buttons with `data-value`) to a
 * localStorage key: clicking a button selects it, persists it, and calls
 * `onChange` with the new value.
 * @param {string} containerId
 * @param {string} storageKey
 * @param {(value: string) => void} [onChange]
 * @returns {() => void} a refresh function that resyncs `.active` state from
 *   localStorage — call it whenever the popover containing this picker opens,
 *   since the same key can change via another surface while it's closed.
 */
function wireSegmentedPicker(containerId, storageKey, onChange) {
    const container = document.getElementById(containerId);
    const buttons = container ? Array.from(container.querySelectorAll('button[data-value]')) : [];
    const refresh = () => {
        const current = localStorage.getItem(storageKey);
        buttons.forEach(b => b.classList.toggle('active', b.dataset.value === current));
    };
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            localStorage.setItem(storageKey, btn.dataset.value);
            refresh();
            onChange?.(btn.dataset.value);
        });
    });
    refresh();
    return refresh;
}

const refreshShareRes = wireSegmentedPicker('share-quality-res-picker', 'screenShareRes', () => peerManager.applyQualitySettings());
const refreshShareFps = wireSegmentedPicker('share-quality-fps-picker', 'screenShareFps', () => peerManager.applyQualitySettings());
wireQuickPopover('share-quality-caret', 'share-quality-popover', () => { refreshShareRes(); refreshShareFps(); });

const refreshCamRes = wireSegmentedPicker('cam-quality-res-picker', 'camRes', () => peerManager.applyCamQualitySettings());
const refreshCamFps = wireSegmentedPicker('cam-quality-fps-picker', 'camFps', () => peerManager.applyCamQualitySettings());
wireQuickPopover('cam-quality-caret', 'cam-quality-popover', () => { refreshCamRes(); refreshCamFps(); });

// Mic options popover: mode picker + sensitivity slider, the same two
// controls as Settings' Audio & Mic mic-mode section, duplicated here as a
// quick surface. Keybind capture used to be a third duplicated control here
// too — now it's a link straight into Settings' consolidated Keybinds tab
// (see the click handler below), rather than a fourth copy of the capture UI.
function refreshMicOptionsRows() {
    // Effective mode, not the stored preference — a 'ptt' room rule forces push-to-talk.
    const micMode = peerManager._effectiveMicMode();
    const thresholdRow = document.getElementById('mic-options-threshold-row');
    if (thresholdRow) thresholdRow.classList.toggle('hidden', micMode !== 'voice-activity');

    const threshold = parseFloat(localStorage.getItem('micThreshold')) || 0.03;
    const thresholdInput = document.getElementById('mic-options-threshold');
    if (thresholdInput) thresholdInput.value = String(threshold);
    updateMicOptionsThresholdLabel(threshold);
}

function updateMicOptionsThresholdLabel(threshold) {
    const label = document.getElementById('mic-options-threshold-value');
    if (label) label.textContent = threshold <= 0.02 ? 'High' : threshold <= 0.06 ? 'Medium' : 'Low';
}

const refreshMicOptionsMode = wireSegmentedPicker('mic-options-mode-picker', 'micMode', (value) => {
    ui.updateMicModeBadge(value);
    refreshMicOptionsRows();
});

// Room mic rule: while the room enforces push-to-talk, the quick popover's
// mode picker is locked (buttons disabled, PTT highlighted, a "Room rule"
// note shown) rather than hidden — the user should see WHY their stored
// preference isn't in effect. Their localStorage setting is never touched,
// so leaving the room restores it untouched.
function refreshMicPolicyLock() {
    const enforced = peerManager.micPolicy === 'ptt';
    const container = document.getElementById('mic-options-mode-picker');
    container?.querySelectorAll('button[data-value]').forEach(b => {
        b.disabled = enforced;
        if (enforced) b.classList.toggle('active', b.dataset.value === 'push-to-talk');
    });
    const note = document.getElementById('mic-options-room-rule');
    if (note) note.style.display = enforced ? '' : 'none';
    if (!enforced) refreshMicOptionsMode();
}

wireQuickPopover('mic-options-caret', 'mic-options-popover', () => { refreshMicOptionsMode(); refreshMicOptionsRows(); refreshMicPolicyLock(); });

// Fires on 'init' and every creator rule change (PeerManager also passes an
// isInitial flag, unused here — the inline system message for changes comes
// from its 'mic-policy-update' handler; this callback only owns the DOM
// consequences, identical in both cases).
peerManager.onMicPolicy = (policy) => {
    ui.updateMicModeBadge(policy === 'ptt' ? 'push-to-talk' : (localStorage.getItem('micMode') || 'toggle'));
    refreshMicPolicyLock();
    refreshMicOptionsRows();
    if (policy === 'ptt') {
        // The rule takes effect immediately: an open mic gets muted rather than
        // staying live until the next manual toggle.
        if (peerManager.micEnabled) {
            peerManager.toggleMic().then(enabled => updateMicUI(enabled));
        }
        if (!localStorage.getItem('keybindPushToTalk')) {
            ui.addSystemMessage('This room uses push-to-talk — set a Push to Talk keybind via Settings → Keybinds', 'info');
        }
    }
};

document.getElementById('mic-options-threshold')?.addEventListener('input', (e) => {
    localStorage.setItem('micThreshold', e.target.value);
    updateMicOptionsThresholdLabel(parseFloat(e.target.value));
});

// Jumps straight to Settings' consolidated Keybinds tab rather than opening
// yet another copy of the capture UI here.
document.getElementById('mic-options-keybinds-link')?.addEventListener('click', () => {
    document.getElementById('mic-options-popover')?.classList.add('hidden');
    settingsPanel.open('keybinds');
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

// Idle/away auto-detection: flips status to the real (yellow) Away after a
// configurable span (Settings → Profile's "Away after", default 15 minutes)
// of no mouse/keyboard/touch input — distinct from tab-visibility's green
// "Not in focus" (see PeerManager._reconcilePresenceStatus) — never
// overrides a manually-chosen DND, and restores whatever status was manually
// chosen before (not hardcoded 'online') once activity resumes. Same timer
// also drives the opt-in "Auto-deafen when away" setting (Settings → Audio &
// Mic) — deafening (and undeafening on return) piggybacks on this signal
// rather than a separate timer, so it fires exactly when the away status
// itself would.
function getIdleTimeoutMs() {
    const minutes = parseFloat(localStorage.getItem('awayTimeoutMinutes')) || 15;
    return minutes * 60 * 1000;
}
let idleTimer = null;
let isIdle = false;
function resetIdleTimer() {
    if (isIdle) {
        isIdle = false;
        peerManager.handleIdleChange(false);
        // Only auto-undeafen if this feature is what deafened us — never
        // undoes a manual deafen the user set before stepping away.
        if (peerManager._autoDeafened) {
            peerManager.setDeafened(false, { auto: true });
            setDeafenUI(false);
        }
    }
    clearTimeout(idleTimer);
    // Read fresh on every reset (not cached) since the Settings dropdown is
    // the only writer and should take effect on the very next reset, not
    // require a reload.
    idleTimer = setTimeout(() => {
        isIdle = true;
        peerManager.handleIdleChange(true);
        if (localStorage.getItem('autoDeafenOnAway') === '1' && !peerManager.deafened) {
            peerManager.setDeafened(true, { auto: true });
            setDeafenUI(true);
        }
    }, getIdleTimeoutMs());
}
['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach((evt) => {
    document.addEventListener(evt, resetIdleTimer, { passive: true });
});
// Talking counts as presence too — alt-tabbing to work in another window
// while still mid-conversation produces zero mouse/keyboard events on this
// document, so without this someone actively speaking still got flipped to
// Away (and, with auto-deafen on, deafened mid-sentence). Reuses
// pollSelfMicActivity() — the same production speaking-detection algorithm
// the active-speaker ring runs — rather than a separate heuristic. Web Audio
// analysers keep running in a backgrounded tab (unlike rAF), so this still
// fires even while unfocused; a muted mic still can't prove presence this
// way, but that's an inherent limit of an audio-based signal, not a bug.
setInterval(() => {
    if (peerManager.pollSelfMicActivity().speaking) resetIdleTimer();
}, 2000);
resetIdleTimer();


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

// Reuses the exact open/close toggle logic (mobile drawer + desktop
// hidden/collapsed) already wired to the edge tabs below, rather than
// duplicating it — these buttons only ever render while the panel is open,
// so "toggle" always means "close" here.
document.getElementById('chat-close-btn')?.addEventListener('click', () => {
    document.getElementById('togglechat')?.click();
});
document.getElementById('members-close-btn')?.addEventListener('click', () => {
    document.getElementById('toggle-members')?.click();
});

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
            document.getElementById('new-message-indicator')?.classList.add('hidden');
            document.getElementById('mention-indicator')?.classList.add('hidden');
        }
    } else {
        const isHidden = chatBox.classList.toggle('hidden');
        if (handle) handle.style.display = isHidden ? 'none' : '';
        localStorage.setItem('chatHidden', isHidden ? '1' : '0');
        if (!isHidden) {
            document.getElementById('new-message-indicator')?.classList.add('hidden');
            document.getElementById('mention-indicator')?.classList.add('hidden');
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
function initChatResize() {
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
}
initChatResize();

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
    // Applying the saved width unconditionally would set an inline style that beats
    // the .collapsed class's `width: 0` rule — a panel that was closed before a
    // refresh would render open (at its old width) while the handle (hidden by the
    // collapsed-state check above) stayed undraggable, until the toggle button was
    // clicked to reconcile the two.
    if (savedW && !isMobile() && !panel.classList.contains('collapsed')) panel.style.width = savedW + 'px';
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
// The standalone gear button that used to open this directly is gone
// (2026-07-08) — it's now reached via the top-bar identity dropdown's
// "Settings" item, see TopbarIdentity.js.
const settingsPanel = new SettingsPanel({ ui, peerManager });

// --- Quick room settings popover (file-trust/follow-speaker/quality) ---
new QuickRoomSettings({ ui, peerManager });

// --- Top-bar identity dropdown (status + Settings) ---
new TopbarIdentity({ peerManager, settingsPanel });

function updateMicUI(enabled) {
    document.getElementById('mic-off-icon').classList.toggle('hidden', enabled);
    document.getElementById('mic-on-icon').classList.toggle('hidden', !enabled);
    document.getElementById('mic-toggle').dataset.tip = enabled ? 'Mute Microphone' : 'Unmute Microphone';
    // Same solid-red fill `#stop-share-button` uses while sharing (`.dock-btn-active-red`,
    // tailwind.css) — reused here as a toggled state instead of a permanent one, so a
    // muted mic reads as unmistakably "off" at a glance, Discord-style.
    document.getElementById('mic-toggle').classList.toggle('dock-btn-active-red', !enabled);
    if (peerManager.peerId) ui.updateParticipantMic(peerManager.peerId, enabled);
}

// Push-to-talk / push-to-mute keydown/keyup — each has its own independent
// keybind now (Settings → Keybinds), read fresh from localStorage rather than
// cached in a module variable, since the settings UI is the only writer.
// Only one of the two is "active" at a time, picked by effective mic mode:
// Push to Talk is hold-to-open, Push to Mute is hold-to-force-mute — a
// modifier on top of Toggle/Voice-Activity mode, not a mode of its own.
window.addEventListener('keydown', (e) => {
    if (settingsPanel.isKeybindListening()) return;
    // Effective mode — a 'ptt' room rule forces push-to-talk over the stored preference.
    const micMode = peerManager._effectiveMicMode();
    const boundKey = localStorage.getItem(micMode === 'push-to-talk' ? 'keybindPushToTalk' : 'keybindPushToMute') || '';
    if (!boundKey || e.code !== boundKey) return;
    if (e.repeat) return;
    const focused = document.activeElement;
    if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.tagName === 'SELECT')) return;

    if (micMode === 'push-to-talk') {
        if (!peerManager.micStream) {
            peerManager.toggleMic().then(enabled => updateMicUI(enabled));
        } else if (!peerManager.micEnabled) {
            peerManager.toggleMic().then(enabled => updateMicUI(enabled));
        }
    } else {
        // Toggle or voice-activity: hold to force-mute. Doesn't touch
        // micEnabled/toggleMic — _reconcileMicGate gates transmission on
        // ptmHeld independently, so the user's toggle preference is
        // untouched and instantly restored on keyup. broadcastMicStatus()
        // is called explicitly (not left to the 200ms gate-reconcile poll)
        // so peers see the mute the same frame as the local UI does.
        peerManager.ptmHeld = true;
        peerManager.broadcastMicStatus();
        updateMicUI(false);
    }
});

window.addEventListener('keyup', (e) => {
    if (settingsPanel.isKeybindListening()) return;
    const micMode = peerManager._effectiveMicMode();
    const boundKey = localStorage.getItem(micMode === 'push-to-talk' ? 'keybindPushToTalk' : 'keybindPushToMute') || '';
    if (!boundKey || e.code !== boundKey) return;
    const focused = document.activeElement;
    if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.tagName === 'SELECT')) return;

    if (micMode === 'push-to-talk') {
        if (peerManager.micEnabled) {
            peerManager.toggleMic().then(enabled => updateMicUI(enabled));
        }
    } else {
        peerManager.ptmHeld = false;
        peerManager.broadcastMicStatus();
        updateMicUI(peerManager.micEnabled);
    }
});

// Toggle Mute keybind (Settings → Keybinds) — a plain tap, same as clicking
// the mic button, regardless of mic mode. Independent of the hold-based PTT/
// PTM keys above: previously the only way to do this was a mouse click.
window.addEventListener('keydown', (e) => {
    if (settingsPanel.isKeybindListening()) return;
    const boundKey = localStorage.getItem('keybindToggleMute') || '';
    if (!boundKey || e.code !== boundKey) return;
    if (e.repeat) return;
    const focused = document.activeElement;
    if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.tagName === 'SELECT')) return;
    e.preventDefault();

    toggleMicManual();
});

// Global deafen keybind (Settings → Audio & Mic) — independent of mic mode,
// always a plain toggle (no push-to-talk-style hold). Only fires while this
// tab has focus — a true system-wide hotkey needs the planned Electron shell
// (see project memory), since a background browser tab can't see keydown at all.
// preventDefault() stops most keys' native browser behavior (e.g. Space
// scrolling the page), but NOT a handful of browser/OS-reserved shortcuts —
// F11 (fullscreen), F5/Ctrl+R (reload), Ctrl+W/Ctrl+T (close/new tab), and
// similar are deliberately un-overridable by any webpage's JS, for every
// browser, as a security/usability guarantee. Binding the keybind to one of
// those will still fire our toggle *and* the browser's own action — pick a
// different key in Settings to avoid the conflict.
window.addEventListener('keydown', (e) => {
    if (settingsPanel.isKeybindListening()) return;
    const deafenKeybind = localStorage.getItem('deafenKeybind') || '';
    if (!deafenKeybind || e.code !== deafenKeybind) return;
    if (e.repeat) return;
    const focused = document.activeElement;
    if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.tagName === 'SELECT')) return;
    e.preventDefault();

    toggleDeafen();
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