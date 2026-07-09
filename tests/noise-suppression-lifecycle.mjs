// Pure logic test for PeerManager's mic noise-suppression toggle
// (setNoiseSuppression) -- no browser/WebAudio needed, same style as
// mic-gate-logic.mjs / audio-sender-lifecycle.mjs.
//
// Guards two easy-to-regress invariants from the RNNoise feature (2026-07-10):
// 1. Toggling suppression live must preserve the previous track's `.enabled`
//    (mute) state across the replaceTrack swap -- a live toggle while muted
//    must not un-mute the mic as a side effect.
// 2. The raw hardware stream must never be stopped while still in use --
//    only the old *processed* stream is torn down, and only when it isn't
//    the raw stream itself.

const storage = new Map();
globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
};
globalThis.RTCSessionDescription = class {
    constructor(init) { Object.assign(this, init); }
};

const { PeerManager } = await import('../public/client/PeerManager.js');

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

function makeFakeTrack(enabled) {
    return { kind: 'audio', enabled, stopped: false, stop() { this.stopped = true; } };
}

function makeFakeStream(track) {
    return { getAudioTracks: () => [track], getTracks: () => [track] };
}

function makeFakeSender() {
    const sender = { replacedWith: [], async replaceTrack(t) { sender.replacedWith.push(t); } };
    return sender;
}

(async function testMuteStatePreservedAcrossLiveToggle() {
    const pm = new PeerManager(null, { showToast: () => {} });
    pm.micEnabled = true;
    pm._rawMicStream = makeFakeStream(makeFakeTrack(true));

    // Suppression already on: current micStream is a distinct "processed"
    // stream, currently muted.
    pm.micStream = makeFakeStream(makeFakeTrack(false));

    const newProcessedTrack = makeFakeTrack(true); // fresh track defaults to enabled
    pm._applyNoiseSuppression = async () => makeFakeStream(newProcessedTrack);

    const sender = makeFakeSender();
    pm.peers = { A: {} };
    pm.senders = { A: { 'mic-audio': sender } };

    await pm.setNoiseSuppression(false); // toggling off while muted

    assert(newProcessedTrack.enabled === false,
        'the new track is muted to match the previous track, not left at its own default');
    assert(sender.replacedWith.at(-1) === newProcessedTrack,
        'the sender got replaceTrack called with the new track');
})();

(async function testRawStreamNeverStopped() {
    const pm = new PeerManager(null, { showToast: () => {} });
    pm.micEnabled = true;

    const rawTrack = makeFakeTrack(true);
    const rawStream = makeFakeStream(rawTrack);
    pm._rawMicStream = rawStream;
    pm.micStream = rawStream; // suppression currently off: micStream IS the raw stream

    pm._applyNoiseSuppression = async () => makeFakeStream(makeFakeTrack(true));
    pm.peers = {};
    pm.senders = {};

    await pm.setNoiseSuppression(true); // toggling on

    assert(!rawTrack.stopped, 'the raw hardware stream is never stopped, even though it was the previous micStream');
})();

(async function testOldProcessedStreamIsStopped() {
    const pm = new PeerManager(null, { showToast: () => {} });
    pm.micEnabled = true;
    pm._rawMicStream = makeFakeStream(makeFakeTrack(true));

    const oldProcessedTrack = makeFakeTrack(true);
    pm.micStream = makeFakeStream(oldProcessedTrack);

    pm._applyNoiseSuppression = async () => makeFakeStream(makeFakeTrack(true));
    pm.peers = {};
    pm.senders = {};

    await pm.setNoiseSuppression(true);

    assert(oldProcessedTrack.stopped, 'the old processed stream is stopped once replaced (it is not the raw stream)');

    console.log('All noise-suppression lifecycle checks passed.');
})().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
