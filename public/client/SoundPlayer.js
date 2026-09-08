// Guarded so this module can be imported by the repo's Node-based pure-logic
// tests (several of which pull it in transitively via PeerManager.js) without
// a real browser's Audio/document globals — playSound() already no-ops on a
// missing sound, so `null` here is a correct, not just tolerated, fallback.
const hasAudio = typeof Audio !== 'undefined';

const Sounds = {
    volume: 1,
    streamUp: hasAudio ? new Audio('/assets/sfx/stream-up.mp3') : null,
    streamDown: hasAudio ? new Audio('/assets/sfx/stream-down.mp3') : null,
    newMessage: hasAudio ? new Audio('/assets/sfx/new-message.mp3') : null,
    peerJoin: hasAudio ? new Audio('/assets/sfx/peer-join.mp3') : null,
    peerLeft: hasAudio ? new Audio('/assets/sfx/peer-left.mp3') : null,
    muted: hasAudio ? new Audio('/assets/sfx/muted.mp3') : null,
    unmuted: hasAudio ? new Audio('/assets/sfx/unmuted.mp3') : null,
};

let soundQueue = [];
let isPlaying = false;
let audioUnlocked = false;

// While an outgoing screen/window share is capturing system audio, anything
// played through this tab's speakers (mute chime, new-message ping, etc.)
// gets picked up by that capture and broadcast to peers as part of the
// share's audio track — e.g. muting to go quiet then having your "muted"
// chime announce it to everyone watching. Suppress local SFX for the
// duration rather than trying to duck just the leak; see PeerManager's
// startSharing()/stopSharing() for the toggle.
let sharingWithAudio = false;

export function setSharingWithAudio(active) {
    sharingWithAudio = active;
}

function unlockAudio() {
    if (audioUnlocked) return;
    Object.values(Sounds).forEach(s => {
        if (hasAudio && s instanceof Audio) {
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

if (typeof document !== 'undefined') {
    ['click', 'keydown', 'touchstart'].forEach(evt => {
        document.addEventListener(evt, unlockAudio, { once: true });
    });
}

export function playSound(soundName) {
    const muteToggle = localStorage.getItem('muteSounds') === '1';
    const volume = parseFloat(localStorage.getItem('soundVolume') || Sounds.volume);
    const sound = Sounds[soundName];

    if (!sound || muteToggle || sharingWithAudio) return;

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
