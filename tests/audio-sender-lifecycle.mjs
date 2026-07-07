// Pure logic test for the two outbound-audio-sender lifecycle bugs fixed 2026-07-08 —
// no browser/WebRTC needed, same style as mic-gate-logic.mjs.
//
// Bug 1: removePeerStream (the 'stop-sharing' handler) called pc.removeTrack() on
//        our OWN outbound senders to the ex-sharer — silently killing mic/cam audio
//        toward them with no renegotiation and no error.
// Bug 2: receiveOffer checked for an existing mic sender via pc.getSenders() track
//        kinds — a sender gated closed by _reconcileMicGate has .track === null, so
//        the check missed it and re-added the mic, overwriting senders[from]
//        ['mic-audio'] with a never-negotiated duplicate while the real sender
//        stayed stranded at replaceTrack(null).

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

function makeFakePc() {
    return {
        addTrackCalls: [],
        removeTrackCalls: [],
        _senders: [],
        addTrack(track, stream) {
            this.addTrackCalls.push({ track, stream });
            const sender = { track, replaceTrack: async () => {} };
            this._senders.push(sender);
            return sender;
        },
        removeTrack(sender) { this.removeTrackCalls.push(sender); },
        getSenders() { return this._senders; },
        async setRemoteDescription() {},
        async createAnswer() { return { type: 'answer', sdp: '' }; },
        async setLocalDescription() {},
        close() {},
    };
}

(function testRemovePeerStreamNeverTouchesOwnSenders() {
    const removedStreams = [];
    const pm = new PeerManager(null, { removeStream: (key) => removedStreams.push(key) });
    const pc = makeFakePc();
    // Our live outbound senders to peer A, exactly what a call in progress looks like.
    pc._senders.push({ track: { kind: 'audio' } }, { track: { kind: 'video' } });
    pm.peers = { A: pc };

    pm.removePeerStream('A'); // what the 'stop-sharing' handler calls

    assert(pc.removeTrackCalls.length === 0, "a peer stopping their share never removes OUR outbound senders to them (Bug 1: mic/cam silently killed toward the ex-sharer)");
    assert(removedStreams.includes('A'), "removePeerStream still removes the ex-sharer's video tile");
})();

(async function testReceiveOfferSkipsMicWhenSenderGatedClosed() {
    const pm = new PeerManager(null, {});
    pm.send = () => {};
    const pc = makeFakePc();
    pm.peers = { A: pc };

    const liveTrack = { id: 'live-mic', kind: 'audio' };
    pm.micStream = { getTracks: () => [liveTrack], getAudioTracks: () => [liveTrack] };
    pm.micEnabled = true;

    // The connection already has a negotiated mic sender, but it's gated closed
    // (replaceTrack(null) from voice-activity silence or manual mute) — so its
    // .track is null and a pc.getSenders() track-kind check cannot see it.
    const gatedSender = { track: null, replaceTrack: async () => {} };
    pc._senders.push(gatedSender);
    pm.senders = { A: { 'mic-audio': gatedSender } };

    await pm.receiveOffer('A', { type: 'offer', sdp: '' });

    assert(pc.addTrackCalls.length === 0, 'a renegotiation offer arriving while the mic gate is closed does not re-add the mic (Bug 2: duplicate unnegotiated sender)');
    assert(pm.senders.A['mic-audio'] === gatedSender, 'the senders map still points at the real negotiated mic sender, so the gate can reopen it');
})().then(async () => {

    // Control case: a genuinely mic-less connection (fresh inbound offer, no
    // sender recorded yet) must still get the mic added.
    const pm = new PeerManager(null, {});
    pm.send = () => {};
    const pc = makeFakePc();
    pm.peers = { B: pc };

    const liveTrack = { id: 'live-mic', kind: 'audio' };
    pm.micStream = { getTracks: () => [liveTrack], getAudioTracks: () => [liveTrack] };
    pm.micEnabled = true;

    await pm.receiveOffer('B', { type: 'offer', sdp: '' });

    assert(pc.addTrackCalls.some(c => c.track === liveTrack), 'a connection with no recorded mic sender still gets the mic added on receiveOffer');
    assert(pm.senders.B?.['mic-audio']?.track === liveTrack, 'the new mic sender is recorded in the senders map for the gate to manage');

    console.log('All audio-sender lifecycle checks passed.');
}).catch((err) => {
    console.error(err.message);
    process.exit(1);
});
