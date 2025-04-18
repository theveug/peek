// --- public/client/App.js ---
import { PeerManager } from './PeerManager.js';
import { UIController } from './UIController.js';

const sessionId = location.pathname.split('/').pop();
const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
//const socket = new WebSocket(`${protocol}://${location.host}`);
const socket = new WebSocket(`ws://${location.host}/ws`);

const ui = new UIController();
const peerManager = new PeerManager(socket, ui);

// Load previous choices if they exist
const resSelect = document.getElementById('res');
const fpsSelect = document.getElementById('fps');

const savedRes = localStorage.getItem('screenShareRes');
const savedFps = localStorage.getItem('screenShareFps');

if (savedRes) resSelect.value = savedRes;
if (savedFps) fpsSelect.value = savedFps;

// Sounds
let Sounds = { volume: 0.3 };
Sounds.streamUp = new Audio('/assets/sfx/stream-up.mp3');
Sounds.streamDown = new Audio('/assets/sfx/stream-down.mp3');
Sounds.newMessage = new Audio('/assets/sfx/new-message.mp3');
// const muteToggle = document.getElementById('mute-sounds');
function playSound(sound) {
    // if (!muteToggle.checked) {
    Sounds[sound].currentTime = 0;
    Sounds[sound].volume = Sounds.volume;
    Sounds[sound].play().catch(() => { });
    // }
}

socket.onopen = () => {
    socket.send(JSON.stringify({ type: 'join', sessionId }));
};

socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'chat') {
        // Only show if it's NOT from me
        if (msg.from !== peerManager.peerId) {
            const displayName = msg.nickname || msg.from;
            ui.addChatMessage(displayName, msg.text);
        }
    } else {
        peerManager.handleSignal(msg);
    }
};

// Chat UI interactions
const input = document.getElementById('message');
const sendBtn = document.getElementById('send');

// Handle enter + shift logic
input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); // prevent newline
        sendMessage();
    }
});

const nicknameInput = document.getElementById('nickname');
const savedNick = localStorage.getItem('nickname');

if (savedNick) {
    nicknameInput.value = savedNick;
}

nicknameInput.addEventListener('input', () => {
    localStorage.setItem('nickname', nicknameInput.value.trim());
});


sendBtn.onclick = sendMessage;

function sendMessage() {
    const text = input.value.trim();
    const nickname = nicknameInput.value.trim() || 'Anonymous';

    if (text) {
        socket.send(JSON.stringify({ type: 'chat', text, nickname }));
        ui.addChatMessage('Me', text);
        input.value = '';
    }
}

document.getElementById('start-share').onclick = () => {
    peerManager.startSharing();
};

const handleFocusChange = () => {
    const blurred = document.hidden || !document.hasFocus();
    ui.handleVisibilityChange(blurred);
};

window.addEventListener('blur', handleFocusChange);
window.addEventListener('focus', handleFocusChange);
document.addEventListener('visibilitychange', handleFocusChange);

function updateWarning(includeWarning = false) {
    const res = document.getElementById('res').value;
    const fps = parseInt(document.getElementById('fps').value) || 30;

    const warningEl = document.getElementById('quality-warning');

    if (res === 'source') {
        warningEl.textContent = '⚠️ Unpredictable load';
        return;
    }

    let [w, h] = res !== 'default' ? res.split('x').map(Number) : [1280, 720];
    const pixelsPerSecond = w * h * fps;

    if (pixelsPerSecond > 1920 * 1080 * 30) {
        warningEl.textContent = '⚠️ High load';
    } else if (pixelsPerSecond > 1280 * 720 * 30) {
        warningEl.textContent = '🟠 Moderate load';
    } else {
        warningEl.textContent = '🟢 Low load';
    }
    if (includeWarning) {
        alert('Restart stream to apply changes.');
    }
}

function onSettingChange() {
    localStorage.setItem('screenShareRes', resSelect.value);
    localStorage.setItem('screenShareFps', fpsSelect.value);
    updateWarning();

    // If already sharing, confirm restart
    if (peerManager.isSharing) {
        const confirmRestart = confirm("Apply new quality settings? This will restart your screen share.");
        if (confirmRestart) {
            peerManager.startSharing();
        }
    }
}


// Save on change
resSelect.addEventListener('change', () => {
    onSettingChange();
    localStorage.setItem('screenShareRes', resSelect.value);
});
fpsSelect.addEventListener('change', () => {
    onSettingChange();
    localStorage.setItem('screenShareFps', fpsSelect.value);
});

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

document.addEventListener('DOMContentLoaded', () => {
    updateWarning(false);
}); 