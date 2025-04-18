const Sounds = {
    volume: 1,
    streamUp: new Audio('/assets/sfx/stream-up.mp3'),
    streamDown: new Audio('/assets/sfx/stream-down.mp3'),
    newMessage: new Audio('/assets/sfx/new-message.mp3'),
    peerJoin: new Audio('/assets/sfx/peer-join.mp3'),
    peerLeft: new Audio('/assets/sfx/peer-left.mp3'),
};

let soundQueue = [];
let isPlaying = false;

export function playSound(soundName) {
    const muteToggle = localStorage.getItem('muteSounds') === '1';
    const volume = parseFloat(localStorage.getItem('soundVolume') || Sounds.volume);
    const sound = Sounds[soundName];

    if (!sound || muteToggle) return;

    soundQueue.push(() => {
        try {
            sound.currentTime = 0;
            sound.volume = volume;

            sound.play().then(() => {
                console.log(`[SoundPlayer] Playing "${soundName}" at volume ${volume}`);
            }).catch(err => {
                console.warn(`[SoundPlayer] Failed to play "${soundName}"`, err);
            });

            sound.onended = () => {
                isPlaying = false;
                processQueue();
            };
        } catch (e) {
            console.warn(`[SoundPlayer] Queue playback error for "${soundName}"`, e);
            isPlaying = false;
            processQueue();
        }
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