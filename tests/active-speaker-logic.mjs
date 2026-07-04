// Unit test for PeerManager._pickActiveSpeaker — the hysteresis logic behind
// active-speaker auto-focus. No browser/WebRTC needed: this is pure decision
// logic (given a map of peerId -> audio level and a timestamp, who's "speaking").
//
// Run with: node tests/active-speaker-logic.mjs

import { PeerManager } from '../public/client/PeerManager.js';

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

const pm = new PeerManager(null, {});

// t=0: A speaks just above the floor — shouldn't switch instantly (hold time)
let speaker = pm._pickActiveSpeaker({ A: 0.5 }, 0);
assert(speaker === null, 'no active speaker yet at t=0 (hold time not met)');

// t=400: still under the 500ms hold — should still not have switched
speaker = pm._pickActiveSpeaker({ A: 0.5 }, 400);
assert(speaker === null, 'still no switch at t=400 (under hold time)');

// t=600: A has been loudest for 600ms — should become active speaker
speaker = pm._pickActiveSpeaker({ A: 0.5 }, 600);
assert(speaker === 'A', 'A becomes active speaker after hold time elapses');

// t=700: B briefly louder, but min-switch-gap (1500ms) not met since last switch at t=600
speaker = pm._pickActiveSpeaker({ A: 0.1, B: 0.6 }, 700);
assert(speaker === 'A', 'no switch to B yet — min switch gap not satisfied');

// t=1300: B has now held loudest for 600ms, but gap since last switch (t=600) is only 700ms
speaker = pm._pickActiveSpeaker({ A: 0.1, B: 0.6 }, 1300);
assert(speaker === 'A', 'still A — gap since last switch under 1500ms');

// t=2200: gap satisfied (1600ms since last switch) and B held long enough — should switch
speaker = pm._pickActiveSpeaker({ A: 0.1, B: 0.6 }, 2200);
assert(speaker === 'B', 'switches to B once both hold-time and min-gap are satisfied');

// Silence below the floor — keeps last known speaker rather than flickering to nothing
speaker = pm._pickActiveSpeaker({ A: 0.01, B: 0.01 }, 2300);
assert(speaker === 'B', 'silence below floor keeps the last active speaker, no flicker to null');

console.log('All active-speaker selection logic checks passed.');
