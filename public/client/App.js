// --- public/client/App.js ---
import { PeerManager } from './PeerManager.js';
import { UIController } from './UIController.js';
import { DebugPanel } from './DebugPanel.js';

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

document.getElementById('start-share').onclick = () => {
    peerManager.startSharing();
};

document.getElementById('grid-button').addEventListener('click', () => {
    ui.toggleViewMode();
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
    if (chatBox) {
        const isHidden = chatBox.classList.toggle('hidden');
        localStorage.setItem('chatHidden', isHidden ? '1' : '0');
    }
});

const chatBox = document.getElementById('chat');
if (localStorage.getItem('chatHidden') === '1') {
    chatBox.classList.add('hidden');
} else {
    chatBox.classList.remove('hidden');
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