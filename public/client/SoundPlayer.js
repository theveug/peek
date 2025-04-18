const Sounds = {
    volume: 1,
    streamUp: new Audio('/assets/sfx/stream-up.mp3'),
    streamDown: new Audio('/assets/sfx/stream-down.mp3'),
    newMessage: new Audio('/assets/sfx/new-message.mp3'),
};

const muteToggle = localStorage.getItem('mute-sounds');
const volume = parseFloat(localStorage.getItem('soundVolume') || Sounds.volume);

export function playSound(soundName) {
    try {
        if (muteToggle) return;
        Sounds[soundName].currentTime = 0;
        Sounds[soundName].volume = volume;
        Sounds[soundName].play().catch(() => { });
        console.log(`[SoundPlayer] Playing "${soundName}" sound`);
    } catch (e) {
        console.warn(`[SoundPlayer] Failed to play "${soundName}"`, e);
    }
}
