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

const savedNick = localStorage.getItem('nickname');

function sendMessage() {
    const text = input.value.trim();
    const nickname = savedNick.trim();

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

const settingsButton = document.getElementById('settings-button');
if (settingsButton) {
    settingsButton.addEventListener('click', () => {
        window.open('/settings', '_blank');
    });
}

const shareButton = document.getElementById('share-button');
if (shareButton) {
    shareButton.addEventListener('click', () => {
        const url = window.location.href;
        navigator.clipboard.writeText(url);
    });
}

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