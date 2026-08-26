// --- public/client/CallRecorder.js ---

import { CallAudioMixer } from './CallAudioMixer.js';

/**
 * Client-side local call recording — three selectable modes, no server
 * involvement (fits the "no info held on a server" principle the same way
 * VirtualBackground.js/NoiseSuppressor.js's client-only pipelines do):
 *  - 'local': just your own outgoing screen/cam + mic, straight to
 *    MediaRecorder, no mixing needed.
 *  - 'audio': every consenting peer's incoming audio + your own mic, mixed
 *    via CallAudioMixer into one audio file.
 *  - 'composite': the same audio mix plus a tiled canvas composite of every
 *    consenting peer's video (equal-size grid, not a mirror of the live
 *    grid/focus layout — a deliberate v1 simplification), recorded as one
 *    video file.
 *
 * "Consenting" means PeerManager.isRecordingAllowed(peerId) — a peer's own
 * broadcast opt-out (Settings' "Allow others to record you" toggle), honor-
 * system only, same enforcement tier as the room's mic-policy rule: a
 * modified client could ignore it. 'local' mode never checks consent since
 * it captures nobody but you.
 *
 * Not moderator-gated — any peer can record, same trust tier as the
 * existing session-recap export (only ever exports what you personally saw).
 */
export class CallRecorder {
    /**
     * @param {{peerManager: object, ui: object}} deps
     */
    constructor({ peerManager, ui }) {
        this.peerManager = peerManager;
        this.ui = ui;
        this.mode = null;
        this.recording = false;
        this._mediaRecorder = null;
        this._chunks = [];
        this._mixer = null;
        this._audioObserver = null;
        this._compositeCanvas = null;
        this._compositeCtx = null;
        this._compositeTiles = new Map(); // streamKey -> hidden <video>
        this._compositing = false;
    }

    /** @returns {boolean} */
    isRecording() {
        return this.recording;
    }

    /**
     * @param {'local'|'audio'|'composite'} mode
     * @returns {Promise<void>}
     */
    async start(mode) {
        if (this.recording) return;

        const outputStream = mode === 'local' ? this._buildLocalStream()
            : mode === 'audio' ? this._buildAudioMixStream()
                : this._buildCompositeStream();

        if (outputStream.getTracks().length === 0) {
            this._teardownAudioMix();
            this._teardownComposite();
            throw new Error('Nothing to record — turn on your mic, camera, or screen share first.');
        }

        this.mode = mode;
        const mimeType = this._pickMimeType(outputStream);
        this._chunks = [];
        this._mediaRecorder = new MediaRecorder(outputStream, mimeType ? { mimeType } : undefined);
        this._mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) this._chunks.push(e.data);
        };
        this._mediaRecorder.onstop = () => this._finish(mimeType);
        this._mediaRecorder.start();
        this.recording = true;

        if (mode !== 'local') this.peerManager.broadcastRecordingStatus(true);
    }

    /**
     * Stops recording. Resolves only after the recorder's own 'stop' event
     * has fired and the file has actually been handed to the browser as a
     * download — callers that need the file to survive a navigation (e.g.
     * leaveSession()) must await this before navigating.
     * @returns {Promise<void>}
     */
    stop() {
        if (!this.recording) return Promise.resolve();
        this.recording = false;
        if (this.mode !== 'local') this.peerManager.broadcastRecordingStatus(false);

        const finished = new Promise((resolve) => {
            this._mediaRecorder.addEventListener('stop', () => resolve(), { once: true });
        });
        this._mediaRecorder.stop();
        return finished.then(() => {
            this._teardownAudioMix();
            this._teardownComposite();
            this.mode = null;
        });
    }

    // --- 'local' mode ---

    _buildLocalStream() {
        const tracks = [];
        const videoStream = this.peerManager.isSharing ? this.peerManager.stream : this.peerManager.camStream;
        if (videoStream) tracks.push(...videoStream.getVideoTracks());
        if (this.peerManager.micStream) tracks.push(...this.peerManager.micStream.getAudioTracks());
        return new MediaStream(tracks);
    }

    // --- 'audio' mode ---

    _buildAudioMixStream() {
        this._mixer = new CallAudioMixer();
        const mixed = this._mixer.start(this._consentingAudioStreams());
        this._watchAudioElements();
        return mixed;
    }

    /** @returns {MediaStream[]} our own mic plus every consenting peer's currently-live inbound audio. */
    _consentingAudioStreams() {
        const streams = [];
        if (this.peerManager.micStream) streams.push(this.peerManager.micStream);
        document.querySelectorAll('audio[id^="audio-"]').forEach((audio) => {
            if (audio.srcObject && this.peerManager.isRecordingAllowed(this._peerIdFromAudioId(audio.id))) {
                streams.push(audio.srcObject);
            }
        });
        return streams;
    }

    /** `audio-${peerId}` (mic) and `audio-${peerId}-screen` (screen-share audio) both resolve to the same peerId — one consent flag covers both channels. */
    _peerIdFromAudioId(id) {
        return id.replace(/^audio-/, '').replace(/-screen$/, '');
    }

    /** Keeps the audio mixer in sync as peers' <audio> elements are added/removed mid-recording (join/leave). */
    _watchAudioElements() {
        this._audioObserver = new MutationObserver((mutations) => {
            mutations.forEach((m) => {
                m.addedNodes.forEach((node) => {
                    if (node.nodeType !== 1 || !node.matches?.('audio[id^="audio-"]')) return;
                    if (node.srcObject && this.peerManager.isRecordingAllowed(this._peerIdFromAudioId(node.id))) {
                        this._mixer.addStream(node.srcObject);
                    }
                });
                m.removedNodes.forEach((node) => {
                    if (node.nodeType === 1 && node.matches?.('audio[id^="audio-"]') && node.srcObject) {
                        this._mixer.removeStream(node.srcObject);
                    }
                });
            });
        });
        this._audioObserver.observe(document.body, { childList: true });
    }

    _teardownAudioMix() {
        this._audioObserver?.disconnect();
        this._audioObserver = null;
        this._mixer?.stop();
        this._mixer = null;
    }

    // --- 'composite' mode ---

    _buildCompositeStream() {
        this._compositeCanvas = document.createElement('canvas');
        this._compositeCanvas.width = 1280;
        this._compositeCanvas.height = 720;
        this._compositeCtx = this._compositeCanvas.getContext('2d');
        this._compositing = true;
        this._pumpComposite();

        const videoTrack = this._compositeCanvas.captureStream(30).getVideoTracks()[0];
        this._mixer = new CallAudioMixer();
        const audioStream = this._mixer.start(this._consentingAudioStreams());
        this._watchAudioElements();

        return new MediaStream([videoTrack, ...audioStream.getAudioTracks()]);
    }

    /** Self-scheduling rAF loop, same shape as VirtualBackground.js's _pump(). */
    _pumpComposite() {
        if (!this._compositing) return;
        this._drawCompositeFrame();
        requestAnimationFrame(() => this._pumpComposite());
    }

    /** Draws every consenting peer's video (plus our own) into a simple equal-size grid. */
    _drawCompositeFrame() {
        const ctx = this._compositeCtx;
        const { width, height } = this._compositeCanvas;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);

        const entries = Object.entries(this.ui.streams).filter(([key, stream]) => {
            if (stream.getVideoTracks().length === 0) return false;
            const isLocal = key === 'me' || key === 'me-cam';
            return isLocal || this.peerManager.isRecordingAllowed(key.replace(/-cam$/, ''));
        });
        if (entries.length === 0) return;

        const cols = Math.ceil(Math.sqrt(entries.length));
        const rows = Math.ceil(entries.length / cols);
        const tileW = width / cols;
        const tileH = height / rows;

        entries.forEach(([key, stream], i) => {
            let video = this._compositeTiles.get(key);
            if (!video || video.srcObject !== stream) {
                video = document.createElement('video');
                video.muted = true;
                video.playsInline = true;
                video.srcObject = stream;
                video.play().catch(() => {});
                this._compositeTiles.set(key, video);
            }
            if (video.readyState < 2) return; // not enough data for a frame yet
            const x = (i % cols) * tileW;
            const y = Math.floor(i / cols) * tileH;
            ctx.drawImage(video, x, y, tileW, tileH);
        });
    }

    _teardownComposite() {
        this._compositing = false;
        this._compositeTiles.forEach((video) => { video.pause(); video.srcObject = null; });
        this._compositeTiles.clear();
        this._compositeCanvas = null;
        this._compositeCtx = null;
    }

    // --- shared ---

    /** @param {MediaStream} outputStream @returns {string} best-supported mimeType, or '' to let the browser pick. */
    _pickMimeType(outputStream) {
        const candidates = outputStream.getVideoTracks().length > 0
            ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
            : ['audio/webm;codecs=opus', 'audio/webm'];
        return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || '';
    }

    /** Assembles the recorded chunks and triggers a browser download — same blob-URL + <a download> sequence UIController._downloadZip() uses. */
    _finish(mimeType) {
        const blob = new Blob(this._chunks, { type: mimeType || 'video/webm' });
        this._chunks = [];
        const roomCode = this.ui.roomCode || 'room';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `peek-recording-${roomCode}-${Date.now()}.webm`;
        a.click();
        URL.revokeObjectURL(url);
    }
}
