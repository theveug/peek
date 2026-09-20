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
 *
 * Makeup gain (2026-09-21, owner-reported: a suppressed voice sounded
 * noticeably quieter to the remote peer): RNNoise strips low-level energy
 * it classifies as noise floor, but the browser's own `autoGainControl`
 * (on by default) only ever sees and calibrates against the *raw* capture
 * upstream of this graph -- it never re-runs on the denoised output, so
 * nothing compensates for the loudness RNNoise just removed. A fixed
 * makeup `GainNode` after the worklet restores perceived loudness; a
 * `DynamicsCompressorNode` after that acts as a brick-wall-ish limiter so
 * the makeup gain can't clip a naturally loud talker.
 */
export class NoiseSuppressor {
    constructor() {
        this._audioContext = null;
        this._sourceNode = null;
        this._workletNode = null;
        this._makeupGainNode = null;
        this._limiterNode = null;
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
        this._makeupGainNode = this._audioContext.createGain();
        this._makeupGainNode.gain.value = 1.6; // ~+4dB, empirical -- restores RNNoise's typical perceived loudness drop
        this._limiterNode = this._audioContext.createDynamicsCompressor();
        this._limiterNode.threshold.value = -3;
        this._limiterNode.knee.value = 0;
        this._limiterNode.ratio.value = 20;
        this._limiterNode.attack.value = 0.003;
        this._limiterNode.release.value = 0.1;
        this._destinationNode = this._audioContext.createMediaStreamDestination();
        // Force genuinely single-channel output (2026-09-21, owner-reported: a
        // remote peer heard the suppressed voice as spatially displaced --
        // "rear right" instead of centered). MediaStreamAudioDestinationNode
        // defaults to 2 channels; even with identical L/R samples, that's still
        // a structural stereo pair, and OS-level spatial virtualizers (Windows
        // Sonic, Dolby Atmos/DTS:X for Headphones) matrix-decode stereo content
        // the same way Dolby Pro Logic does -- correlated content maps to
        // center, but any per-channel difference (even float-rounding noise
        // from how each channel gets written) reads as "ambience" and gets
        // steered to a rear/side virtual speaker. The raw, non-suppressed mic
        // track is genuinely mono and never hits this; only this synthesized
        // Web Audio graph output was structurally stereo. Setting channelCount
        // to 1 here removes the L/R pair entirely, so there's nothing left for
        // a spatializer to matrix-decode.
        this._destinationNode.channelCount = 1;
        this._destinationNode.channelCountMode = 'explicit';
        this._destinationNode.channelInterpretation = 'discrete';
        this._sourceNode.connect(this._workletNode)
            .connect(this._makeupGainNode)
            .connect(this._limiterNode)
            .connect(this._destinationNode);

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
        this._makeupGainNode?.disconnect();
        this._limiterNode?.disconnect();
        this._destinationNode?.disconnect();
        // Known Chromium limitation (also hit by jitsi-meet's own noise-suppression
        // effect): closing the context doesn't reliably release the worklet's WASM
        // memory (https://bugs.chromium.org/p/chromium/issues/detail?id=1298955).
        // Harmless here since this only leaks per toggle-off, not per frame.
        this._audioContext?.close();
        this._audioContext = null;
        this._sourceNode = null;
        this._workletNode = null;
        this._makeupGainNode = null;
        this._limiterNode = null;
        this._destinationNode = null;
        this._outputStream = null;
    }
}
