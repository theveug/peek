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
//
// Also covers the receive-side (incoming) noise-suppression feature added
// alongside the consolidated participant context menu: the global-default/
// per-peer-override precedence, the hot-swap on override, per-peer teardown
// in removePeer(), and that screen-share audio is never touched.

const storage = new Map();
globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
};
globalThis.RTCSessionDescription = class {
    constructor(init) { Object.assign(this, init); }
};

// Minimal RTCPeerConnection stub — just enough surface for
// PeerManager.createPeerConnection() to run without a real WebRTC stack, so
// the pc.ontrack closure (where incoming noise suppression is gated to
// mic-only) can be exercised directly.
class FakeRTCPeerConnection {
    createDataChannel() {
        return { binaryType: null, onopen: null, onclose: null, onmessage: null };
    }
    close() {}
}
globalThis.RTCPeerConnection = FakeRTCPeerConnection;

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

async function testMuteStatePreservedAcrossLiveToggle() {
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
}

async function testRawStreamNeverStopped() {
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
}

async function testOldProcessedStreamIsStopped() {
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
}

async function testEffectiveIncomingSuppressionPrecedence() {
    const pm = new PeerManager(null, { showToast: () => {} });
    localStorage.setItem('noiseSuppressionIncoming', '0');

    assert(pm._effectiveIncomingNoiseSuppression('X') === false,
        'defaults to off when nothing is set');

    localStorage.setItem('noiseSuppressionIncoming', '1');
    assert(pm._effectiveIncomingNoiseSuppression('X') === true,
        'follows the global default when no per-peer override exists');

    pm.peerNoiseSuppressionOverrides.set('X', false);
    assert(pm._effectiveIncomingNoiseSuppression('X') === false,
        'a false per-peer override wins over an on global default');

    localStorage.setItem('noiseSuppressionIncoming', '0');
    pm.peerNoiseSuppressionOverrides.set('X', true);
    assert(pm._effectiveIncomingNoiseSuppression('X') === true,
        'a true per-peer override wins over an off global default');

    localStorage.setItem('noiseSuppressionIncoming', '0'); // reset for later tests
}

async function testApplyIncomingNoiseSuppressionNoOpWhenDisabled() {
    const pm = new PeerManager(null, { showToast: () => {} });
    localStorage.setItem('noiseSuppressionIncoming', '0');

    const rawTrack = makeFakeTrack(true);
    const result = await pm._applyIncomingNoiseSuppression('P1', rawTrack);

    assert(result === rawTrack,
        'returns the raw track unchanged when incoming suppression is off and no override exists');
    assert(pm._peerRawMicTracks.get('P1') === rawTrack,
        'still records the raw track for later per-peer override use, even while currently off');
    assert(!pm.peerIncomingNoiseSuppressors.has('P1'),
        'no NoiseSuppressor instance is created while disabled');
}

async function testSetPeerNoiseSuppressionOverrideHotSwapsAudio() {
    const pm = new PeerManager(null, { showToast: () => {} });
    const addAudioCalls = [];
    pm.ui = { addAudio: (...args) => addAudioCalls.push(args), showToast: () => {} };

    const rawTrack = makeFakeTrack(true);
    pm._peerRawMicTracks.set('P1', rawTrack);
    const processedTrack = makeFakeTrack(true);
    let capturedTrack = null;
    pm._applyIncomingNoiseSuppression = async (peerId, track) => { capturedTrack = track; return processedTrack; };

    await pm.setPeerNoiseSuppressionOverride('P1', true);

    assert(pm.peerNoiseSuppressionOverrides.get('P1') === true, 'override is recorded');
    assert(capturedTrack === rawTrack, 're-derives from the stored raw track, not a stale processed one');
    assert(addAudioCalls.length === 1 && addAudioCalls[0][0] === 'P1' && addAudioCalls[0][1] === processedTrack,
        'ui.addAudio() is re-invoked with the newly processed track (hot-swap)');

    await pm.setPeerNoiseSuppressionOverride('P1', null);
    assert(!pm.peerNoiseSuppressionOverrides.has('P1'), 'passing null clears the override');

    const callsBefore = addAudioCalls.length;
    await pm.setPeerNoiseSuppressionOverride('NEVER_SEEN', true);
    assert(addAudioCalls.length === callsBefore,
        'no-op when no raw track has ever been recorded for that peer (never joined with audio)');
}

async function testRemovePeerCleansUpIncomingSuppression() {
    const pm = new PeerManager(null, { showToast: () => {}, removeStream: () => {}, removeAudio: () => {} });
    pm.peers = {};

    let stopped = false;
    pm.peerIncomingNoiseSuppressors.set('P1', { stop: () => { stopped = true; } });
    pm.peerNoiseSuppressionOverrides.set('P1', true);
    pm._peerRawMicTracks.set('P1', makeFakeTrack(true));

    pm.removePeer('P1');

    assert(stopped, "removePeer() stops the departing peer's incoming NoiseSuppressor instance");
    assert(!pm.peerIncomingNoiseSuppressors.has('P1'), 'removePeer() clears the suppressor map entry');
    assert(!pm.peerNoiseSuppressionOverrides.has('P1'), 'removePeer() clears the per-peer override');
    assert(!pm._peerRawMicTracks.has('P1'), 'removePeer() clears the stored raw track');
}

async function testOntrackNeverAppliesSuppressionToScreenAudio() {
    const pm = new PeerManager(null, { showToast: () => {}, addAudio: () => {}, addStream: () => {} });
    pm._startStatsPolling = () => {};
    pm._startSpeakerPolling = () => {};

    let suppressionCalls = 0;
    pm._applyIncomingNoiseSuppression = async (peerId, track) => { suppressionCalls++; return track; };

    const pc = pm.createPeerConnection('P1');
    pm.peerScreenStreamIds['P1'] = 'screen-stream-id';

    // Screen-share audio: e.streams[0].id matches the peer's announced screen stream.
    pc.ontrack({ track: { kind: 'audio' }, streams: [{ id: 'screen-stream-id' }] });
    await Promise.resolve();
    assert(suppressionCalls === 0, 'screen-share audio is never routed through incoming noise suppression');

    // Regular mic audio: stream id doesn't match the announced screen stream.
    pc.ontrack({ track: { kind: 'audio' }, streams: [{ id: 'mic-stream-id' }] });
    await Promise.resolve();
    assert(suppressionCalls === 1, 'non-screen mic audio IS routed through incoming noise suppression');
}

(async () => {
    await testMuteStatePreservedAcrossLiveToggle();
    await testRawStreamNeverStopped();
    await testOldProcessedStreamIsStopped();
    await testEffectiveIncomingSuppressionPrecedence();
    await testApplyIncomingNoiseSuppressionNoOpWhenDisabled();
    await testSetPeerNoiseSuppressionOverrideHotSwapsAudio();
    await testRemovePeerCleansUpIncomingSuppression();
    await testOntrackNeverAppliesSuppressionToScreenAudio();
    console.log('All noise-suppression lifecycle checks passed.');
})().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
