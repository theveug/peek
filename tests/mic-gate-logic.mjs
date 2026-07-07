// Pure logic test for PeerManager._reconcileMicGate — no browser/WebRTC needed.
// Verifies the voice-activation transmit gate calls replaceTrack correctly,
// without depending on flaky real fake-audio-device detection.

const storage = new Map();
globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
};

const { PeerManager } = await import('../public/client/PeerManager.js');

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

function makeFakeSender() {
    const calls = [];
    return { replaceTrack: async (t) => { calls.push(t); }, _calls: calls };
}

(function testGateOnlyAppliesInVoiceActivityMode() {
    const pm = new PeerManager(null, {});
    const liveTrack = { id: 'live' };
    pm.micStream = { getAudioTracks: () => [liveTrack] };
    pm.micEnabled = true;
    const senderA = makeFakeSender();
    pm.senders = { A: { 'mic-audio': senderA } };

    localStorage.setItem('micMode', 'toggle');
    pm._reconcileMicGate(false); // not speaking, but toggle mode should stay open
    assert(senderA._calls.at(-1) === liveTrack, 'toggle mode keeps the sender open regardless of speaking state');
})();

(function testGateClosesWhenSilentInVoiceActivityMode() {
    const pm = new PeerManager(null, {});
    const liveTrack = { id: 'live' };
    pm.micStream = { getAudioTracks: () => [liveTrack] };
    pm.micEnabled = true;
    const senderA = makeFakeSender();
    pm.senders = { A: { 'mic-audio': senderA } };

    localStorage.setItem('micMode', 'voice-activity');
    pm._reconcileMicGate(false);
    assert(senderA._calls.at(-1) === null, 'voice-activity mode closes the sender (replaceTrack(null)) while not speaking');

    pm._reconcileMicGate(true);
    assert(senderA._calls.at(-1) === liveTrack, 'voice-activity mode reopens the sender while speaking');
})();

(function testMutedOverridesVoiceActivity() {
    const pm = new PeerManager(null, {});
    const liveTrack = { id: 'live' };
    pm.micStream = { getAudioTracks: () => [liveTrack] };
    pm.micEnabled = false; // manually muted via the mic toggle
    const senderA = makeFakeSender();
    pm.senders = { A: { 'mic-audio': senderA } };

    localStorage.setItem('micMode', 'voice-activity');
    pm._reconcileMicGate(true); // even if "speaking" were somehow true
    // Since the "gate every mode" change (track.enabled = false still encodes and
    // transmits silence), manual mute must close the RTP sender too, not just
    // disable the track — regardless of the speaking signal.
    assert(senderA._calls.at(-1) === null, 'manual mute closes the sender in every mode (a disabled track still transmits silence otherwise)');

    localStorage.setItem('micMode', 'toggle');
    pm._reconcileMicGate(false);
    assert(senderA._calls.at(-1) === null, 'manual mute closes the sender in toggle mode too');

    pm.micEnabled = true;
    pm._reconcileMicGate(false);
    assert(senderA._calls.at(-1) === liveTrack, 'unmuting reopens the sender on the next tick');
})();

(function testNewSenderJoiningMidGateGetsReconciled() {
    const pm = new PeerManager(null, {});
    const liveTrack = { id: 'live' };
    pm.micStream = { getAudioTracks: () => [liveTrack] };
    pm.micEnabled = true;
    const senderA = makeFakeSender();
    pm.senders = { A: { 'mic-audio': senderA } };

    localStorage.setItem('micMode', 'voice-activity');
    pm._reconcileMicGate(false); // gate closes
    assert(senderA._calls.at(-1) === null, 'existing sender gated closed');

    // A new peer joins mid-gate — its sender starts out attached to the live track
    // (as _addTrackedStream would leave it), same as a fresh connection always does.
    const senderB = makeFakeSender();
    pm.senders.B = { 'mic-audio': senderB };
    senderB._calls.push(liveTrack); // simulate _addTrackedStream's initial addTrack

    pm._reconcileMicGate(false); // next 200ms poll tick, still not speaking
    assert(senderB._calls.at(-1) === null, 'a sender added mid-gate is brought in line on the next tick, not left open');
})();

(function testSwitchingOutOfVoiceActivityReopensGate() {
    const pm = new PeerManager(null, {});
    const liveTrack = { id: 'live' };
    pm.micStream = { getAudioTracks: () => [liveTrack] };
    pm.micEnabled = true;
    const senderA = makeFakeSender();
    pm.senders = { A: { 'mic-audio': senderA } };

    localStorage.setItem('micMode', 'voice-activity');
    pm._reconcileMicGate(false);
    assert(senderA._calls.at(-1) === null, 'gated closed while in voice-activity and silent');

    localStorage.setItem('micMode', 'toggle');
    pm._reconcileMicGate(false);
    assert(senderA._calls.at(-1) === liveTrack, 'switching back to toggle mode reopens a sender left gated closed');
})();

console.log('All mic-gate logic checks passed.');
