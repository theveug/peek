// --- public/client/rnnoise-worklet-processor.js ---

/**
 * AudioWorkletProcessor that denoises a mono mic track via RNNoise, running
 * entirely in-browser (self-hosted WASM, `public/assets/vendor/rnnoise/`,
 * Apache-2.0) — same "nothing leaves the browser" model as VirtualBackground.js's
 * webcam blur. Adapted from jitsi-meet's own noise-suppression worklet
 * (react/features/stream-effects/rnnoise/RnnoiseProcessor.ts +
 * .../noise-suppression/NoiseSuppressorWorklet.ts, Apache-2.0) — that's the
 * exact shipped algorithm behind Jitsi Meet's own noise suppression, so this
 * reuses proven logic rather than re-deriving the frame-buffering math from
 * scratch. `createRNNWasmModuleSync` (the base64-inlined WASM build, needed
 * because AudioWorkletGlobalScope's `addModule()` doesn't await promises) is
 * imported straight from the vendored file — vendor file itself is untouched.
 */
import createRNNWasmModuleSync from '/assets/vendor/rnnoise/rnnoise-sync.js';

/** Rnnoise's fixed frame size; samples of any other length won't work. */
const RNNOISE_SAMPLE_LENGTH = 480;
/** Rnnoise takes 480 float32 samples per frame, thus 480*4 bytes. */
const RNNOISE_BUFFER_SIZE = RNNOISE_SAMPLE_LENGTH * 4;
/** Rnnoise expects samples scaled to 16-bit PCM range, not the Web Audio -1..1 float range. */
const SHIFT_16_BIT_NR = 32768;

/** Adapts the raw WASM exports (malloc'd memory + rnnoise_* calls) into a per-frame denoise() call. */
class RnnoiseProcessor {
    constructor(wasmInterface) {
        this._destroyed = false;
        try {
            this._wasmInterface = wasmInterface;
            // Allocated once and reused across every frame.
            this._wasmPcmInput = this._wasmInterface._malloc(RNNOISE_BUFFER_SIZE);
            this._wasmPcmInputF32Index = this._wasmPcmInput >> 2;
            if (!this._wasmPcmInput) throw new Error('Failed to create wasm input memory buffer!');
            this._context = this._wasmInterface._rnnoise_create();
        } catch (error) {
            this.destroy();
            throw error;
        }
    }

    /** Releases the malloc'd buffer and rnnoise context. */
    destroy() {
        if (this._destroyed) return;
        if (this._wasmPcmInput) this._wasmInterface._free(this._wasmPcmInput);
        if (this._context) this._wasmInterface._rnnoise_destroy(this._context);
        this._destroyed = true;
    }

    /**
     * Denoises exactly RNNOISE_SAMPLE_LENGTH (480) float32 samples in place.
     * @param {Float32Array} pcmFrame - also the output, when denoising.
     * @returns {number} VAD score (0-1), unused here but part of rnnoise's API.
     */
    processAudioFrame(pcmFrame) {
        for (let i = 0; i < RNNOISE_SAMPLE_LENGTH; i++) {
            this._wasmInterface.HEAPF32[this._wasmPcmInputF32Index + i] = pcmFrame[i] * SHIFT_16_BIT_NR;
        }
        // Same buffer for input/output; rnnoise supports in-place processing.
        const vadScore = this._wasmInterface._rnnoise_process_frame(
            this._context, this._wasmPcmInput, this._wasmPcmInput
        );
        for (let i = 0; i < RNNOISE_SAMPLE_LENGTH; i++) {
            pcmFrame[i] = this._wasmInterface.HEAPF32[this._wasmPcmInputF32Index + i] / SHIFT_16_BIT_NR;
        }
        return vadScore;
    }
}

/**
 * Bridges AudioWorklet's fixed 128-sample render quantum to rnnoise's
 * required 480-sample frames via a circular buffer sized to
 * lcm(128, 480) = 1920 samples — hardcoded rather than computed generically
 * since neither number ever changes (128 is a Web Audio spec constant, 480
 * is fixed by the rnnoise model). Sizing the buffer to the lcm guarantees
 * that whenever the buffer wraps around, the "residue" of not-yet-emitted
 * denoised samples is never split across the wrap boundary.
 */
class NoiseSuppressorProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._denoiseProcessor = new RnnoiseProcessor(createRNNWasmModuleSync());
        this._circularBufferLength = 1920;
        this._circularBuffer = new Float32Array(this._circularBufferLength);
        this._inputBufferLength = 0;
        this._denoisedBufferLength = 0;
        this._denoisedBufferIndx = 0;
    }

    process(inputs, outputs) {
        // Mono only -- if a stereo track is ever passed in, only channel 0 gets denoised.
        const inData = inputs[0][0];
        const outData = outputs[0][0];
        if (!inData) return true; // input node not connected/disconnected yet

        this._circularBuffer.set(inData, this._inputBufferLength);
        this._inputBufferLength += inData.length;

        for (; this._denoisedBufferLength + RNNOISE_SAMPLE_LENGTH <= this._inputBufferLength;
             this._denoisedBufferLength += RNNOISE_SAMPLE_LENGTH) {
            const denoiseFrame = this._circularBuffer.subarray(
                this._denoisedBufferLength, this._denoisedBufferLength + RNNOISE_SAMPLE_LENGTH
            );
            this._denoiseProcessor.processAudioFrame(denoiseFrame);
        }

        let unsentDenoisedDataLength;
        if (this._denoisedBufferIndx > this._denoisedBufferLength) {
            unsentDenoisedDataLength = this._circularBufferLength - this._denoisedBufferIndx;
        } else {
            unsentDenoisedDataLength = this._denoisedBufferLength - this._denoisedBufferIndx;
        }

        if (unsentDenoisedDataLength >= outData.length) {
            const denoisedFrame = this._circularBuffer.subarray(
                this._denoisedBufferIndx, this._denoisedBufferIndx + outData.length
            );
            outData.set(denoisedFrame, 0);
            this._denoisedBufferIndx += outData.length;
        }

        if (this._denoisedBufferIndx === this._circularBufferLength) this._denoisedBufferIndx = 0;
        if (this._inputBufferLength === this._circularBufferLength) {
            this._inputBufferLength = 0;
            this._denoisedBufferLength = 0;
        }

        return true;
    }
}

registerProcessor('rnnoise-processor', NoiseSuppressorProcessor);
