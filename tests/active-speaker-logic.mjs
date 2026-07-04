// Unit tests for PeerManager's speaker-detection logic — no browser/WebRTC needed,
// this is pure decision logic over synthetic audio levels and timestamps.
//
// Run with: node tests/active-speaker-logic.mjs

import { PeerManager } from '../public/client/PeerManager.js';

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

// --- _updateSpeakingStates: adaptive noise-floor VAD ---
// A fixed threshold reads a mic with a high self-noise floor as "always speaking."
// The floor must adapt to each peer's own ambient level while they're not flagged
// speaking, so only a rise clearly above THEIR floor counts.
(function testAdaptiveNoiseFloor() {
    const pm = new PeerManager(null, {});

    // Peer N has a noisy mic sitting at a steady 0.2 — after enough ticks at a
    // constant level, the floor should adapt up to match it and stop reading as speech.
    let t = 0;
    let speaking;
    for (let i = 0; i < 30; i++) {
        speaking = pm._updateSpeakingStates({ N: 0.2 }, t);
        t += 200;
    }
    assert(speaking.N === false, 'a peer with a constant 0.2 noise floor is not perpetually "speaking"');

    // Now N actually talks — a clear rise above their own learned floor
    speaking = pm._updateSpeakingStates({ N: 0.4 }, t);
    assert(speaking.N === true, 'a rise clearly above the learned floor registers as speech');

    // Silence afterward — release window keeps it on briefly, then clears
    speaking = pm._updateSpeakingStates({ N: 0.2 }, t + 100);
    assert(speaking.N === true, 'still counted speaking within the release window');
    speaking = pm._updateSpeakingStates({ N: 0.2 }, t + 500);
    assert(speaking.N === false, 'clears once the release window elapses');
})();

(function testQuietMicStillDetected() {
    const pm = new PeerManager(null, {});
    let t = 0;
    // A very quiet mic sitting near 0.01 at rest
    for (let i = 0; i < 10; i++) {
        pm._updateSpeakingStates({ Q: 0.01 }, t);
        t += 200;
    }
    // A modest rise (0.05) — well below a flat 0.04-style threshold's "loud" range,
    // but clearly above THIS peer's own near-zero floor.
    const speaking = pm._updateSpeakingStates({ Q: 0.05 }, t);
    assert(speaking.Q === true, 'a quiet mic\'s modest rise above its own floor still registers as speech');
})();

// --- _pickActiveSpeaker: hold-time + hysteresis over the debounced speaking signal ---
(function testActiveSpeakerSelection() {
    const pm = new PeerManager(null, {});

    let speaker = pm._pickActiveSpeaker({ A: true }, 0);
    assert(speaker === null, 'no active speaker yet at t=0 (hold time not met)');

    speaker = pm._pickActiveSpeaker({ A: true }, 400);
    assert(speaker === null, 'still no switch at t=400 (under hold time)');

    speaker = pm._pickActiveSpeaker({ A: true }, 600);
    assert(speaker === 'A', 'A becomes active speaker after hold time elapses');

    speaker = pm._pickActiveSpeaker({ A: false, B: true }, 700);
    assert(speaker === 'A', 'no switch to B yet — min switch gap not satisfied');

    speaker = pm._pickActiveSpeaker({ A: false, B: true }, 1300);
    assert(speaker === 'A', 'still A — gap since last switch under 1500ms');

    speaker = pm._pickActiveSpeaker({ A: false, B: true }, 2200);
    assert(speaker === 'B', 'switches to B once both hold-time and min-gap are satisfied');

    speaker = pm._pickActiveSpeaker({ A: false, B: false }, 2300);
    assert(speaker === 'B', 'silence keeps the last active speaker, no flicker to null');

    speaker = pm._pickActiveSpeaker({ A: true, B: true }, 4000);
    assert(speaker === 'B', 'two peers speaking at once does not force a guess — holds last speaker');
})();

console.log('All active-speaker selection logic checks passed.');
