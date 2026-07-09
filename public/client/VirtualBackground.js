// --- public/client/VirtualBackground.js ---

/**
 * Client-side webcam background blur via MediaPipe's Selfie Segmentation
 * model (self-hosted, `public/assets/vendor/mediapipe/`, Apache-2.0) — runs
 * entirely in the browser on your own raw webcam track before it's ever
 * sent to any peer. No coordination with peers, no server round-trip, and
 * nothing leaves the browser: fits the "no info held on a server" principle
 * the same way client-side markdown rendering or the QR code generator do.
 *
 * Segmentation produces a person/background mask per frame; the mask is
 * used to composite a sharp foreground (the person) over a blurred copy of
 * the same frame onto a `<canvas>`, whose `captureStream()` becomes the
 * outgoing video track. The raw camera stream passed into `start()` is
 * never touched or stopped by this class — that's the caller's (PeerManager's)
 * responsibility, since the same raw stream may need to survive a blur
 * on/off toggle without restarting the physical camera.
 */
export class VirtualBackground {
    constructor() {
        this._segmenter = null;
        this._video = null;
        this._canvas = null;
        this._ctx = null;
        this._sending = false;
        this._blurPx = 12;
        this._outputStream = null;
    }

    /**
     * @param {MediaStream} rawStream - the raw camera stream; not modified or stopped by this class.
     * @param {{blurPx?: number}} [options]
     * @returns {Promise<MediaStream>} a new stream whose video track is the blurred composite.
     */
    async start(rawStream, { blurPx = 12 } = {}) {
        if (typeof SelfieSegmentation === 'undefined') {
            throw new Error('Background blur unavailable (segmentation library failed to load)');
        }
        this._blurPx = blurPx;

        this._video = document.createElement('video');
        this._video.muted = true;
        this._video.playsInline = true;
        this._video.srcObject = rawStream;
        await this._video.play();

        this._canvas = document.createElement('canvas');
        this._canvas.width = this._video.videoWidth || 640;
        this._canvas.height = this._video.videoHeight || 480;
        this._ctx = this._canvas.getContext('2d');

        this._segmenter = new SelfieSegmentation({
            locateFile: (file) => `/assets/vendor/mediapipe/${file}`,
        });
        // modelSelection 0 ("general", 256x256) suits a typical close-framed
        // webcam self-view better than 1 ("landscape", 256x144, tuned for
        // when the person doesn't fill most of the frame).
        this._segmenter.setOptions({ modelSelection: 0, selfieMode: false });
        this._segmenter.onResults((results) => this._onResults(results));
        await this._segmenter.initialize();

        this._sending = true;
        this._pump();

        this._outputStream = this._canvas.captureStream(30);
        return this._outputStream;
    }

    /**
     * Composites one segmentation result onto the canvas: sharp person
     * pixels (via the mask) over a blurred copy of the full frame. This is
     * the standard MediaPipe background-blur recipe — mask drawn first as
     * an alpha shape, `source-in` keeps only the sharp frame where the mask
     * is opaque, `destination-over` then fills in everything else with a
     * blurred copy of the same frame.
     * @param {{image: CanvasImageSource, segmentationMask: CanvasImageSource}} results
     * @returns {void}
     */
    _onResults(results) {
        const ctx = this._ctx;
        const { width: w, height: h } = this._canvas;
        ctx.save();
        ctx.clearRect(0, 0, w, h);
        ctx.filter = 'none';
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(results.segmentationMask, 0, 0, w, h);
        ctx.globalCompositeOperation = 'source-in';
        ctx.drawImage(results.image, 0, 0, w, h);
        ctx.globalCompositeOperation = 'destination-over';
        ctx.filter = `blur(${this._blurPx}px)`;
        ctx.drawImage(results.image, 0, 0, w, h);
        ctx.restore();
    }

    /** Drives the segmentation loop for as long as `_sending` is true. */
    async _pump() {
        if (!this._sending) return;
        try {
            await this._segmenter.send({ image: this._video });
        } catch {
            // A dropped/failed frame shouldn't kill the whole call — keep going.
        }
        if (this._sending) requestAnimationFrame(() => this._pump());
    }

    /**
     * Stops the segmentation loop and releases the canvas track, segmenter,
     * and hidden video element. Does NOT touch the raw camera stream passed
     * into `start()` — the caller owns that stream's lifecycle.
     * @returns {void}
     */
    stop() {
        this._sending = false;
        this._outputStream?.getTracks().forEach((t) => t.stop());
        this._outputStream = null;
        this._segmenter?.close();
        this._segmenter = null;
        if (this._video) {
            this._video.pause();
            this._video.srcObject = null;
            this._video = null;
        }
        this._canvas = null;
        this._ctx = null;
    }
}
