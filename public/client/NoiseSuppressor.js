// --- public/client/NoiseSuppressor.js ---

/**
 * Client-side mic noise suppression via RNNoise (self-hosted,
 * `public/assets/vendor/rnnoise/`, Apache-2.0) — runs entirely in the
 * browser on your own raw mic track before it's ever sent to any peer. No
 * coordination with peers, no server round-trip: same "nothing leaves the
 * browser" model as VirtualBackground.js's webcam blur, and deliberately
 * built to the same start(rawStream)/stop() shape so PeerManager can treat
 * both processing pipelines identically.
 *
 * The raw mic stream passed into `start()` is never touched or stopped by
 * this class -- that's the caller's (PeerManager's) responsibility, since
 * the same raw stream may need to survive a suppression on/off toggle
 * without restarting the physical microphone.
 */
export class NoiseSuppressor {
    constructor() {
        this._audioContext = null;
        this._sourceNode = null;
        this._workletNode = null;
        this._destinationNode = null;
        this._outputStream = null;
    }

    /**
     * @param {MediaStream} rawStream - the raw mic stream; not modified or stopped by this class.
     * @returns {Promise<MediaStream>} a new stream whose audio track is denoised.
     */
    async start(rawStream) {
        this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
        await this._audioContext.audioWorklet.addModule('/client/rnnoise-worklet-processor.js');

        this._sourceNode = this._audioContext.createMediaStreamSource(rawStream);
        this._workletNode = new AudioWorkletNode(this._audioContext, 'rnnoise-processor');
        this._destinationNode = this._audioContext.createMediaStreamDestination();
        this._sourceNode.connect(this._workletNode).connect(this._destinationNode);

        this._outputStream = this._destinationNode.stream;
        return this._outputStream;
    }

    /**
     * Disconnects the processing graph and closes the AudioContext. Does
     * NOT touch the raw mic stream passed into `start()` -- the caller owns
     * that stream's lifecycle.
     * @returns {void}
     */
    stop() {
        this._sourceNode?.disconnect();
        this._workletNode?.disconnect();
        this._destinationNode?.disconnect();
        // Known Chromium limitation (also hit by jitsi-meet's own noise-suppression
        // effect): closing the context doesn't reliably release the worklet's WASM
        // memory (https://bugs.chromium.org/p/chromium/issues/detail?id=1298955).
        // Harmless here since this only leaks per toggle-off, not per frame.
        this._audioContext?.close();
        this._audioContext = null;
        this._sourceNode = null;
        this._workletNode = null;
        this._destinationNode = null;
        this._outputStream = null;
    }
}
