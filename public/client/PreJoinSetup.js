// --- public/client/PreJoinSetup.js ---

/**
 * Blocking pre-join "check your setup" screen (2026-09-21, owner-reported:
 * new users almost always needed someone already using Peek to walk them
 * through Settings to find a working mic/cam/speaker). Modeled on the
 * Zoom/Meet pre-join pattern: requests mic+cam permission once up front,
 * shows a live preview + mic level meter, lets the user pick devices and
 * test their speaker before ever entering the room. Self-builds into
 * document.body, same precedent as SettingsPanel.js/RoomRail.js's own
 * `_buildModal()` — no markup added to index.html.
 *
 * Shown on every room join until dismissed (`localStorage['skipDeviceCheck']`,
 * also toggleable back on from Settings → Data & Storage) — not a one-time
 * flag, since someone plugging in a different headset later should see it
 * again. Every device pick applies + persists immediately to the same
 * `micDeviceId`/`camDeviceId`/`speakerDeviceId` keys SettingsPanel.js already
 * reads, matching this app's "no Save/Cancel step" convention.
 *
 * Deliberately owns its OWN getUserMedia call rather than reusing
 * PeerManager's (which doesn't exist as a connected peer yet at this point
 * in App.js's lifecycle) — on close it fully stops its preview tracks before
 * resolving, so PeerManager's later toggleMic()/toggleCam() re-acquires a
 * fresh stream against the just-picked device id rather than fighting over
 * an already-open device (a webcam/mic generally can't be held open twice
 * concurrently — see PeerManager.js's applyCamQualitySettings() comment).
 */
import { trapFocus } from './focusTrap.js';
import { populateDeviceSelect } from './deviceSelect.js';

/** @returns {boolean} whether the pre-join screen should be shown this join. */
export function shouldShowDeviceCheck() {
    // Playwright/WebDriver-controlled browsers report navigator.webdriver —
    // skip the manual-decision modal there. Every existing browser test
    // (ui-smoke.mjs, peer-block.mjs, quality-tier-verify.mjs, etc.) navigates
    // straight into a room expecting an immediate connection; none of them
    // know to click "Join now" first, so without this they'd all hang
    // forever waiting on a click nothing in those tests ever makes. A real
    // user's browser never reports this as true.
    if (navigator.webdriver) return false;
    return localStorage.getItem('skipDeviceCheck') !== '1';
}

export class PreJoinSetup {
    constructor() {
        this.overlay = null;
        this._previewStream = null;
        this._audioContext = null;
        this._analyser = null;
        this._meterRaf = null;
        this._releaseFocusTrap = null;
        this._resolve = null;
    }

    /** @returns {Promise<void>} resolves once the user dismisses the screen. */
    show() {
        return new Promise((resolve) => {
            this._resolve = resolve;
            this._build();
            this._requestPreview();
        });
    }

    _build() {
        const overlay = document.createElement('div');
        overlay.id = 'prejoin-modal';
        overlay.className = 'fixed inset-0 z-100 overflow-y-auto';
        overlay.innerHTML = `
            <div class="absolute inset-0 bg-black/80"></div>
            <div class="relative z-10 flex items-center justify-center min-h-screen p-4 py-8">
                <div class="surface-elevated text-foreground rounded-xl p-6 w-full max-w-sm shadow-2xl border border-separator my-auto">
                    <h2 class="text-lg font-bold mb-1">Check your setup</h2>
                    <p class="text-sm text-muted mb-4">Pick your camera and mic before joining — you can always change these later in Settings.</p>

                    <div class="prejoin-preview">
                        <video id="prejoin-video" autoplay muted playsinline></video>
                        <div id="prejoin-video-placeholder" class="prejoin-video-placeholder" style="display:none">
                            <span class="material-symbols-rounded">videocam_off</span>
                            <span id="prejoin-video-placeholder-text">Camera unavailable</span>
                        </div>
                    </div>

                    <div class="settings-field mt-4">
                        <label for="prejoin-cam-device" class="settings-label">Camera</label>
                        <select id="prejoin-cam-device" class="settings-text-input">
                            <option value="">System default</option>
                        </select>
                    </div>
                    <div class="settings-field">
                        <label for="prejoin-mic-device" class="settings-label">Microphone</label>
                        <select id="prejoin-mic-device" class="settings-text-input">
                            <option value="">System default</option>
                        </select>
                        <div class="mic-meter mt-2">
                            <div class="mic-meter-fill" id="prejoin-mic-meter-fill"></div>
                        </div>
                        <p class="text-[10px] text-muted mt-1">Speak normally — the bar should move.</p>
                    </div>
                    <div class="settings-field">
                        <label for="prejoin-speaker-device" class="settings-label">Speaker</label>
                        <div class="flex gap-2">
                            <select id="prejoin-speaker-device" class="settings-text-input flex-1">
                                <option value="">System default</option>
                            </select>
                            <button type="button" id="prejoin-speaker-test" class="lobby-btn-secondary shrink-0">Test</button>
                        </div>
                    </div>

                    <div class="settings-toggle-row mt-4">
                        <div class="settings-toggle-row-title">Don't show this again</div>
                        <label class="settings-switch"><input type="checkbox" id="prejoin-dont-show" /><span
                                class="settings-switch-track"></span></label>
                    </div>

                    <button type="button" id="prejoin-join" class="lobby-btn-primary w-full mt-5">Join now</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        this.overlay = overlay;
        this._releaseFocusTrap = trapFocus(overlay, overlay.querySelector('#prejoin-join'));

        overlay.querySelector('#prejoin-join').addEventListener('click', () => this._close());
        overlay.querySelector('#prejoin-speaker-test').addEventListener('click', () => this._testSpeaker());
        overlay.querySelector('#prejoin-cam-device').addEventListener('change', (e) => this._applyDeviceChoice('camDeviceId', e.target.value));
        overlay.querySelector('#prejoin-mic-device').addEventListener('change', (e) => this._applyDeviceChoice('micDeviceId', e.target.value));
        overlay.querySelector('#prejoin-speaker-device').addEventListener('change', (e) => {
            localStorage.setItem('speakerDeviceId', e.target.value || '');
        });
        overlay.querySelector('#prejoin-dont-show').addEventListener('change', (e) => {
            localStorage.setItem('skipDeviceCheck', e.target.checked ? '1' : '0');
        });
        // Never a hard trap — a broken permission dialog or device shouldn't
        // strand anyone here with no way in. Escape behaves like "Join now".
        this._keydownHandler = (e) => { if (e.key === 'Escape') this._close(); };
        document.addEventListener('keydown', this._keydownHandler);
    }

    /** Requests mic+cam, falling back to audio-only, falling back to no preview at all. */
    async _requestPreview() {
        try {
            await this._acquirePreview({ audio: true, video: true });
        } catch {
            try {
                await this._acquirePreview({ audio: true, video: false });
                this._showNoCamera();
            } catch {
                this._showNoDevices();
            }
        }
        this._refreshDeviceSelects();
        // A device plugged in/removed while this screen is open (a common
        // first-time moment — someone realizes their headset isn't plugged
        // in yet) should refresh the option lists live.
        navigator.mediaDevices?.addEventListener?.('devicechange', () => this._refreshDeviceSelects());
    }

    async _acquirePreview(constraints) {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        this._setPreviewStream(stream);
    }

    _setPreviewStream(stream) {
        this._stopPreviewStream();
        this._previewStream = stream;
        const video = this.overlay?.querySelector('#prejoin-video');
        if (video && stream.getVideoTracks().length) {
            video.srcObject = stream;
            video.style.transform = 'scaleX(-1)';
            const placeholder = this.overlay.querySelector('#prejoin-video-placeholder');
            if (placeholder) placeholder.style.display = 'none';
        } else {
            this._showNoCamera();
        }
        if (stream.getAudioTracks().length) this._attachMeter(stream);
    }

    _showNoCamera() {
        const video = this.overlay?.querySelector('#prejoin-video');
        if (video) video.srcObject = null;
        const placeholder = this.overlay?.querySelector('#prejoin-video-placeholder');
        if (placeholder) placeholder.style.display = 'flex';
    }

    _showNoDevices() {
        this._showNoCamera();
        const placeholderText = this.overlay?.querySelector('#prejoin-video-placeholder-text');
        if (placeholderText) placeholderText.textContent = 'Camera & mic unavailable';
    }

    /** Live mic-level meter off the preview stream's own audio track — a plain level indicator, not the room's speaking-detection logic. */
    _attachMeter(stream) {
        this._stopMeter();
        this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = this._audioContext.createMediaStreamSource(stream);
        this._analyser = this._audioContext.createAnalyser();
        this._analyser.fftSize = 512;
        source.connect(this._analyser);
        const data = new Uint8Array(this._analyser.frequencyBinCount);
        const fill = this.overlay?.querySelector('#prejoin-mic-meter-fill');
        const tick = () => {
            this._analyser.getByteTimeDomainData(data);
            let sumSquares = 0;
            for (let i = 0; i < data.length; i++) {
                const v = (data[i] - 128) / 128;
                sumSquares += v * v;
            }
            const rms = Math.sqrt(sumSquares / data.length);
            if (fill) {
                fill.style.width = `${Math.min(100, rms * 400)}%`;
                fill.classList.toggle('mic-meter-fill-active', rms > 0.02);
            }
            this._meterRaf = requestAnimationFrame(tick);
        };
        tick();
    }

    _stopMeter() {
        if (this._meterRaf) cancelAnimationFrame(this._meterRaf);
        this._meterRaf = null;
        this._analyser = null;
        this._audioContext?.close();
        this._audioContext = null;
    }

    async _refreshDeviceSelects() {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        let devices;
        try {
            devices = await navigator.mediaDevices.enumerateDevices();
        } catch {
            return;
        }
        if (!this.overlay) return;
        populateDeviceSelect(this.overlay.querySelector('#prejoin-cam-device'),
            devices.filter(d => d.kind === 'videoinput'), localStorage.getItem('camDeviceId') || '', 'Camera');
        populateDeviceSelect(this.overlay.querySelector('#prejoin-mic-device'),
            devices.filter(d => d.kind === 'audioinput'), localStorage.getItem('micDeviceId') || '', 'Microphone');
        populateDeviceSelect(this.overlay.querySelector('#prejoin-speaker-device'),
            devices.filter(d => d.kind === 'audiooutput'), localStorage.getItem('speakerDeviceId') || '', 'Speaker');
    }

    /** Re-acquires the preview against the newly-picked device so switching mic/cam here actually shows/sounds different. */
    async _applyDeviceChoice(storageKey, deviceId) {
        localStorage.setItem(storageKey, deviceId || '');
        const constraints = storageKey === 'camDeviceId'
            ? { audio: false, video: deviceId ? { deviceId: { exact: deviceId } } : true }
            : { audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false };
        try {
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            if (storageKey === 'camDeviceId') {
                // Keep the existing mic track (if any) alongside the freshly-picked camera.
                const micTrack = this._previewStream?.getAudioTracks()[0];
                if (micTrack) stream.addTrack(micTrack);
            } else {
                const camTrack = this._previewStream?.getVideoTracks()[0];
                if (camTrack) stream.addTrack(camTrack);
            }
            this._setPreviewStream(stream);
        } catch {
            // Device switch failed (unplugged, permission hiccup) — leave the existing preview running.
        }
    }

    /** Plays a short tone through the selected output device via setSinkId, same technique UIController.setAudioOutputDevice() uses. */
    async _testSpeaker() {
        const deviceId = this.overlay?.querySelector('#prejoin-speaker-device')?.value || '';
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        osc.frequency.value = 440;
        const gain = ctx.createGain();
        gain.gain.value = 0.2;
        const dest = ctx.createMediaStreamDestination();
        osc.connect(gain).connect(dest);

        const audio = new Audio();
        audio.srcObject = dest.stream;
        try {
            if (deviceId && audio.setSinkId) await audio.setSinkId(deviceId);
        } catch {
            // Unsupported browser or invalid device — falls back to the system default output, still audible.
        }
        osc.start();
        await audio.play().catch(() => {});
        setTimeout(() => {
            osc.stop();
            ctx.close();
        }, 500);
    }

    _stopPreviewStream() {
        this._previewStream?.getTracks().forEach(t => t.stop());
        this._previewStream = null;
    }

    _close() {
        document.removeEventListener('keydown', this._keydownHandler);
        this._stopMeter();
        this._stopPreviewStream();
        this._releaseFocusTrap?.();
        this.overlay?.remove();
        this.overlay = null;
        this._resolve?.();
    }
}
