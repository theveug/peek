const Sounds = {
    volume: 1,
    streamUp: new Audio('/assets/sfx/stream-up.mp3'),
    streamDown: new Audio('/assets/sfx/stream-down.mp3'),
    newMessage: new Audio('/assets/sfx/new-message.mp3'),
    peerJoin: new Audio('/assets/sfx/peer-join.mp3'),
    peerLeft: new Audio('/assets/sfx/peer-left.mp3'),
    muted: new Audio('/assets/sfx/muted.mp3'),
    unmuted: new Audio('/assets/sfx/unmuted.mp3'),
};

let soundQueue = [];
let isPlaying = false;
let audioUnlocked = false;

function unlockAudio() {
    if (audioUnlocked) return;
    Object.values(Sounds).forEach(s => {
        if (s instanceof Audio) {
            s.muted = true;
            s.play().then(() => {
                s.pause();
                s.currentTime = 0;
                s.muted = false;
            }).catch(() => {
                s.muted = false;
            });
        }
    });
    audioUnlocked = true;
}

['click', 'keydown', 'touchstart'].forEach(evt => {
    document.addEventListener(evt, unlockAudio, { once: true });
});

export function playSound(soundName) {
    const muteToggle = localStorage.getItem('muteSounds') === '1';
    const volume = parseFloat(localStorage.getItem('soundVolume') || Sounds.volume);
    const sound = Sounds[soundName];

    if (!sound || muteToggle) return;

    soundQueue.push(() => {
        sound.currentTime = 0;
        sound.volume = volume;

        sound.play().then(() => {
            sound.onended = () => {
                isPlaying = false;
                processQueue();
            };
        }).catch(() => {
            isPlaying = false;
            processQueue();
        });
    });

    if (!isPlaying) {
        processQueue();
    }
}

function processQueue() {
    if (soundQueue.length === 0) return;
    const next = soundQueue.shift();
    isPlaying = true;
    next();
}
