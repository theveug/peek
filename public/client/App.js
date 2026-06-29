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

function connect() {
    socket = new WebSocket(`${protocol}://${location.host}`);
    peerManager.socket = socket;
    debug.setSocket(socket);

    socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'join', sessionId }));
    };

    socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'chat') {
            if (msg.from !== peerManager.peerId) {
                const displayName = msg.nickname || msg.from;
                ui.addChatMessage(displayName, msg.text);
            }
        } else {
            peerManager.handleSignal(msg);
        }
    };

    socket.onclose = () => {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 2000);
    };
}

connect();

// Chat UI interactions
const input = document.getElementById('message');

function generateFunnyNickname() {
    const adjectives = ['Funky', 'Silly', 'Smart', 'Sneaky', 'Zesty', 'Wiggly', 'Cheesy', 'Invincible', 'Fluffy', 'Sassy', 'Bouncy', 'Wacky', 'Jumpy', 'Quirky', 'Spicy', 'Nerdy', 'Chill', 'Epic', 'Crazy', 'Dizzy'];
    const animals = ['Penguin', 'Llama', 'Nugget', 'Pineapple', 'Walrus', 'Donkey', 'Taco', 'Otter', 'Sloth', 'Panda', 'Koala', 'Narwhal', 'Turtle', 'Dolphin', 'Giraffe', 'Platypus', 'Octopus', 'Raccoon', 'Kangaroo', 'Cactus', 'Dragon'];

    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const animal = animals[Math.floor(Math.random() * animals.length)];

    return `${adj}${animal}${Math.floor(Math.random() * 1000)}`;
}
// Handle enter + shift logic
input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); // prevent newline
        sendMessage();
    }
});

function sendMessage() {
    const text = input.value.trim();
    const nickname = (localStorage.getItem('nickname') || 'Anonymous').trim();

    if (text) {
        socket.send(JSON.stringify({ type: 'chat', text, nickname }));
        ui.addChatMessage('Me', text);
        input.value = '';
    }
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
    document.getElementById('mic-off-icon').classList.toggle('hidden', enabled);
    document.getElementById('mic-on-icon').classList.toggle('hidden', !enabled);
    document.getElementById('mic-toggle').title = enabled ? 'Mute Microphone' : 'Unmute Microphone';
});

document.getElementById('deafen-toggle').addEventListener('click', () => {
    peerManager.deafened = !peerManager.deafened;
    document.querySelectorAll('audio').forEach(a => { a.muted = peerManager.deafened; });
    document.getElementById('deafen-off-icon').classList.toggle('hidden', peerManager.deafened);
    document.getElementById('deafen-on-icon').classList.toggle('hidden', !peerManager.deafened);
    document.getElementById('deafen-toggle').title = peerManager.deafened ? 'Undeafen' : 'Deafen';
    peerManager.broadcastDeafenStatus();
});

const handleFocusChange = () => {
    const blurred = document.hidden || !document.hasFocus();
    ui.handleVisibilityChange(blurred);
};

window.addEventListener('blur', handleFocusChange);
window.addEventListener('focus', handleFocusChange);
document.addEventListener('visibilitychange', handleFocusChange);


const chatButton = document.getElementById('togglechat');
chatButton.addEventListener('click', () => {
    const chatBox = document.getElementById('chat');
    const handle = document.getElementById('chat-resize-handle');
    if (chatBox) {
        const isHidden = chatBox.classList.toggle('hidden');
        if (handle) handle.style.display = isHidden ? 'none' : '';
        localStorage.setItem('chatHidden', isHidden ? '1' : '0');
    }
});

const chatBox = document.getElementById('chat');
const chatHandle = document.getElementById('chat-resize-handle');
if (localStorage.getItem('chatHidden') === '1') {
    chatBox.classList.add('hidden');
    if (chatHandle) chatHandle.style.display = 'none';
} else {
    chatBox.classList.remove('hidden');
}

// Resizable chat panel (width persists to localStorage)
(function initChatResize() {
    const handle = document.getElementById('chat-resize-handle');
    const chat = document.getElementById('chat');
    if (!handle || !chat) return;
    const savedW = localStorage.getItem('chatWidth');
    if (savedW) chat.style.width = savedW + 'px';
    let startX, startW;
    handle.addEventListener('mousedown', (e) => {
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
if (membersToggle && membersSidebar) {
    if (localStorage.getItem('membersHidden') === '1') {
        membersSidebar.classList.add('collapsed');
    }
    membersToggle.addEventListener('click', () => {
        const collapsed = membersSidebar.classList.toggle('collapsed');
        localStorage.setItem('membersHidden', collapsed ? '1' : '0');
    });
}

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
    closeSettings();
});

document.getElementById('settings-button').addEventListener('click', openSettings);
document.getElementById('close-settings').addEventListener('click', closeSettings);
document.getElementById('cancel-settings').addEventListener('click', closeSettings);
document.getElementById('settings-backdrop').addEventListener('click', closeSettings);

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