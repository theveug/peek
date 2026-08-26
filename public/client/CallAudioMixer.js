// --- public/client/CallAudioMixer.js ---

/**
 * Mixes N live audio streams (the local mic + every consenting peer's
 * incoming audio) into one MediaStream, for CallRecorder.js's 'audio' and
 * 'composite' recording modes. Same start()/stop() lifecycle shape as
 * NoiseSuppressor.js, but connects many input sources into one
 * MediaStreamAudioDestinationNode instead of routing one input through a
 * processing worklet.
 *
 * Sources can be added/removed live via addStream()/removeStream() so the
 * mix stays correct as peers join/leave mid-recording — CallRecorder.js
 * drives this from a MutationObserver watching the room's <audio> elements.
 *
 * None of the input streams are ever stopped by this class — same "the
 * caller owns the stream's lifecycle" rule NoiseSuppressor.js documents.
 */
export class CallAudioMixer {
    constructor() {
        this._audioContext = null;
        this._destinationNode = null;
        this._sourceNodes = new Map(); // MediaStream -> MediaStreamAudioSourceNode
    }

    /**
     * @param {MediaStream[]} [initialStreams] - streams to connect immediately.
     * @returns {MediaStream} the mixed output stream.
     */
    start(initialStreams = []) {
        this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
        this._destinationNode = this._audioContext.createMediaStreamDestination();
        initialStreams.forEach(stream => this.addStream(stream));
        return this._destinationNode.stream;
    }

    /**
     * Connects one more input stream into the mix. No-ops for a stream
     * that's already connected, or one with no audio track (a video-only
     * placeholder stream), or a call before start().
     * @param {MediaStream} stream
     * @returns {void}
     */
    addStream(stream) {
        if (!this._audioContext || !stream || this._sourceNodes.has(stream)) return;
        if (stream.getAudioTracks().length === 0) return;
        const source = this._audioContext.createMediaStreamSource(stream);
        source.connect(this._destinationNode);
        this._sourceNodes.set(stream, source);
    }

    /**
     * Disconnects one input stream from the mix (a peer left, or opted out
     * of being recorded mid-call). No-op if it was never connected.
     * @param {MediaStream} stream
     * @returns {void}
     */
    removeStream(stream) {
        const source = this._sourceNodes.get(stream);
        if (!source) return;
        source.disconnect();
        this._sourceNodes.delete(stream);
    }

    /**
     * Disconnects every source and closes the AudioContext. Does NOT stop
     * any of the input streams — the caller (CallRecorder) owns those.
     * @returns {void}
     */
    stop() {
        this._sourceNodes.forEach(source => source.disconnect());
        this._sourceNodes.clear();
        this._destinationNode?.disconnect();
        this._audioContext?.close();
        this._audioContext = null;
        this._destinationNode = null;
    }
}
