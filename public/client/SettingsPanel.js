// --- public/client/SettingsPanel.js ---
// Full-frame settings overlay (redesign Phase 3). Every control here applies +
// persists immediately on change — there's no Save/Cancel step, matching the
// design spec's interaction model (see CLAUDE.md's redesign notes).
import { setTheme, getEffectiveTheme } from './ThemeManager.js';
import { setAccent, getStoredAccent, accentPresetNames, presetColor } from './AccentManager.js';
import { setBackgroundTint, getStoredBackgroundTint, bgTintPresetNames, presetBgColor } from './BackgroundManager.js';

export class SettingsPanel {
    // ui/peerManager are optional — on the lobby (pre-room) there's neither, and
    // every field still needs to load/persist to localStorage for whatever room
    // is joined next. Anything that only makes sense with a live connection
    // (status, live quality application, nickname broadcast) is guarded.
    constructor({ ui = null, peerManager = null } = {}) {
        this.ui = ui;
        this.peerManager = peerManager;
        this._keybindListening = false;

        this.modal = document.getElementById('settings-modal');
        if (!this.modal) return;

        this._buildAccentSwatches();
        this._buildBackgroundSwatches();
        this._wireNav();
        this._wireProfile();
        this._wireAppearance();
        this._wireVideo();
        this._wireAudio();
        this._wirePrivacy();
        this._wireCloseHandlers();
    }

    isKeybindListening() {
        return this._keybindListening;
    }

    open() {
        if (!this.modal) return;
        this._refreshAll();
        this.modal.classList.remove('hidden');
        this._startMicMeter();
    }

    close() {
        if (!this.modal) return;
        this.modal.classList.add('hidden');
        this._stopMicMeter();
    }

    // --- Nav ---

    _wireNav() {
        const items = this.modal.querySelectorAll('.settings-nav-item');
        items.forEach(btn => {
            btn.addEventListener('click', () => {
                const section = btn.dataset.settingsSection;
                items.forEach(b => b.classList.toggle('active', b === btn));
                this.modal.querySelectorAll('.settings-section').forEach(panel => {
                    panel.classList.toggle('active', panel.dataset.settingsPanel === section);
                });
            });
        });
    }

    _wireCloseHandlers() {
        document.getElementById('close-settings')?.addEventListener('click', () => this.close());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.modal.classList.contains('hidden')) this.close();
        });
    }

    _refreshAll() {
        this._refreshProfile();
        this._refreshAppearance();
        this._refreshVideo();
        this._refreshAudio();
        this._refreshPrivacy();
    }

    // --- Profile ---

    _wireProfile() {
        const nickname = document.getElementById('settings-nickname');
        nickname?.addEventListener('change', () => {
            const value = nickname.value.trim();
            localStorage.setItem('nickname', value);
            this.peerManager?.broadcastNickname();
            if (this.peerManager?.peerId) {
                this.ui.updateParticipantNickname(this.peerManager.peerId, value);
            }
        });

        this.modal.querySelectorAll('#status-picker .status-pick').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!this.peerManager) return; // no live connection yet (lobby) — nothing to set status on
                this.peerManager.setManualStatus(btn.dataset.status);
                this._highlightStatus();
            });
        });
    }

    _refreshProfile() {
        const nickname = document.getElementById('settings-nickname');
        if (nickname) nickname.value = localStorage.getItem('nickname') || '';
        this._highlightStatus();
    }

    _highlightStatus() {
        const current = this.peerManager?.status || 'online';
        this.modal.querySelectorAll('#status-picker .status-pick').forEach(b => {
            const active = b.dataset.status === current;
            b.classList.toggle('ring-1', active);
            b.classList.toggle('ring-indigo-500', active);
        });
    }

    // --- Appearance ---

    _buildAccentSwatches() {
        const container = document.getElementById('settings-accent-picker');
        if (!container) return;
        accentPresetNames().forEach(name => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'settings-accent-swatch';
            btn.title = name.charAt(0).toUpperCase() + name.slice(1);
            btn.dataset.accent = name;
            btn.style.background = presetColor(name);
            btn.innerHTML = '<span class="material-symbols-rounded icon-filled">check</span>';
            btn.addEventListener('click', () => {
                setAccent(name);
                this._refreshAppearance();
            });
            container.appendChild(btn);
        });
    }

    _buildBackgroundSwatches() {
        const container = document.getElementById('settings-bg-picker');
        if (!container) return;
        bgTintPresetNames().forEach(name => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'settings-accent-swatch';
            btn.title = name.charAt(0).toUpperCase() + name.slice(1);
            btn.dataset.bg = name;
            btn.style.background = presetBgColor(name);
            btn.innerHTML = '<span class="material-symbols-rounded icon-filled">check</span>';
            btn.addEventListener('click', () => {
                setBackgroundTint(name, getEffectiveTheme() === 'light');
                this._refreshAppearance();
            });
            container.appendChild(btn);
        });
    }

    _wireAppearance() {
        this.modal.querySelectorAll('#settings-theme-picker button').forEach(btn => {
            btn.addEventListener('click', () => {
                setTheme(btn.dataset.theme);
                this._refreshAppearance();
            });
        });
    }

    _refreshAppearance() {
        // getEffectiveTheme() always resolves to 'dark'/'light' (it's what
        // actually gets painted) — but the picker also needs to distinguish
        // "explicitly light" from "currently resolves to light via the OS,"
        // so the System button highlights correctly instead of never lighting
        // up. No explicit localStorage['theme'] means the user is following
        // the system preference.
        const current = localStorage.getItem('theme') || 'system';
        this.modal.querySelectorAll('#settings-theme-picker button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === current);
        });

        const currentAccent = getStoredAccent();
        this.modal.querySelectorAll('#settings-accent-picker button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.accent === currentAccent);
        });

        const currentBgTint = getStoredBackgroundTint();
        this.modal.querySelectorAll('#settings-bg-picker button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.bg === currentBgTint);
        });
    }

    // --- Screen & Video ---

    _wireSegmented(containerId, storageKey, onApply) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                localStorage.setItem(storageKey, btn.dataset.value);
                container.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
                onApply?.();
            });
        });
    }

    _highlightSegmented(containerId, storageKey, fallback) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const current = localStorage.getItem(storageKey) || fallback;
        container.querySelectorAll('button').forEach(b => {
            b.classList.toggle('active', b.dataset.value === current);
        });
    }

    _wireVideo() {
        this._wireSegmented('settings-res-picker', 'screenShareRes', () => this.peerManager?.applyQualitySettings());
        this._wireSegmented('settings-fps-picker', 'screenShareFps', () => this.peerManager?.applyQualitySettings());
        this._wireSegmented('settings-cam-res-picker', 'camRes', () => this.peerManager?.applyCamQualitySettings());
        this._wireSegmented('settings-cam-fps-picker', 'camFps', () => this.peerManager?.applyCamQualitySettings());

        document.getElementById('settings-follow-speaker')?.addEventListener('change', (e) => {
            const checked = e.target.checked;
            localStorage.setItem('followActiveSpeaker', checked ? '1' : '0');
            if (checked && this.ui) this.ui.autoFocusPaused = false; // re-enabling counts as "resume following"
        });

        // setBackgroundBlur() itself persists the localStorage value and, if the
        // camera is already on, live-swaps the processing pipeline — see PeerManager.js.
        document.getElementById('settings-background-blur')?.addEventListener('change', (e) => {
            this.peerManager?.setBackgroundBlur(e.target.checked);
        });

        document.getElementById('settings-max-messages')?.addEventListener('change', (e) => {
            localStorage.setItem('maxMessages', e.target.value);
        });
    }

    _refreshVideo() {
        this._highlightSegmented('settings-res-picker', 'screenShareRes', '1280x720');
        this._highlightSegmented('settings-fps-picker', 'screenShareFps', '30');
        this._highlightSegmented('settings-cam-res-picker', 'camRes', '640x480');
        this._highlightSegmented('settings-cam-fps-picker', 'camFps', '30');

        const followSpeaker = document.getElementById('settings-follow-speaker');
        if (followSpeaker) followSpeaker.checked = localStorage.getItem('followActiveSpeaker') === '1';

        const backgroundBlur = document.getElementById('settings-background-blur');
        if (backgroundBlur) backgroundBlur.checked = localStorage.getItem('backgroundBlur') === '1';

        const maxMessages = document.getElementById('settings-max-messages');
        if (maxMessages) maxMessages.value = localStorage.getItem('maxMessages') || '100';
    }

    // --- Audio & Mic ---

    _wireAudio() {
        document.getElementById('settings-mute')?.addEventListener('change', (e) => {
            localStorage.setItem('muteSounds', e.target.checked ? '1' : '0');
        });

        const volume = document.getElementById('settings-volume');
        const volumeValue = document.getElementById('settings-volume-value');
        volume?.addEventListener('input', (e) => {
            if (volumeValue) volumeValue.textContent = `${Math.round(e.target.value * 100)}%`;
            localStorage.setItem('soundVolume', e.target.value);
        });

        const masterVolume = document.getElementById('settings-master-volume');
        const masterVolumeValue = document.getElementById('settings-master-volume-value');
        masterVolume?.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            if (masterVolumeValue) masterVolumeValue.textContent = `${Math.round(value * 100)}%`;
            this.ui?.setMasterCallVolume(value);
        });

        this.modal.querySelectorAll('#settings-mic-mode-picker button').forEach(btn => {
            btn.addEventListener('click', () => {
                localStorage.setItem('micMode', btn.dataset.micMode);
                this._refreshMicMode();
            });
        });

        const micThreshold = document.getElementById('settings-mic-threshold');
        micThreshold?.addEventListener('input', (e) => {
            localStorage.setItem('micThreshold', e.target.value);
            this._updateMicThresholdLabel(parseFloat(e.target.value));
        });

        const micHoldTime = document.getElementById('settings-mic-hold-time');
        micHoldTime?.addEventListener('input', (e) => {
            localStorage.setItem('micHoldTime', e.target.value);
            this._updateMicHoldTimeLabel(parseFloat(e.target.value));
        });

        const keybindInput = document.getElementById('settings-keybind');
        if (keybindInput) {
            keybindInput.addEventListener('click', () => {
                this._keybindListening = true;
                keybindInput.value = 'Press a key...';
                keybindInput.classList.add('ring-1', 'ring-indigo-500');
            });

            keybindInput.addEventListener('keydown', (e) => {
                if (!this._keybindListening) return;
                e.preventDefault();
                e.stopPropagation();
                localStorage.setItem('micKeybind', e.code);
                keybindInput.value = e.code;
                keybindInput.classList.remove('ring-1', 'ring-indigo-500');
                this._keybindListening = false;
            });

            keybindInput.addEventListener('blur', () => {
                if (this._keybindListening) {
                    keybindInput.value = localStorage.getItem('micKeybind') || '';
                    keybindInput.classList.remove('ring-1', 'ring-indigo-500');
                    this._keybindListening = false;
                }
            });
        }

        document.getElementById('keybind-clear')?.addEventListener('click', () => {
            localStorage.setItem('micKeybind', '');
            if (keybindInput) keybindInput.value = '';
        });
    }

    _refreshMicMode() {
        const micMode = localStorage.getItem('micMode') || 'toggle';
        this.modal.querySelectorAll('#settings-mic-mode-picker button').forEach(b => {
            b.classList.toggle('active', b.dataset.micMode === micMode);
        });
        const keybindRow = document.getElementById('keybind-row');
        if (keybindRow) keybindRow.classList.toggle('hidden', micMode !== 'push-to-talk' && micMode !== 'push-to-mute');
        const keybindInput = document.getElementById('settings-keybind');
        if (keybindInput) keybindInput.value = localStorage.getItem('micKeybind') || '';

        const thresholdRow = document.getElementById('mic-threshold-row');
        if (thresholdRow) thresholdRow.classList.toggle('hidden', micMode !== 'voice-activity');
        const threshold = parseFloat(localStorage.getItem('micThreshold')) || 0.03;
        const thresholdInput = document.getElementById('settings-mic-threshold');
        if (thresholdInput) thresholdInput.value = String(threshold);
        this._updateMicThresholdLabel(threshold);

        const holdTimeRow = document.getElementById('mic-hold-time-row');
        if (holdTimeRow) holdTimeRow.classList.toggle('hidden', micMode !== 'voice-activity');
        const holdTime = parseFloat(localStorage.getItem('micHoldTime')) || 400;
        const holdTimeInput = document.getElementById('settings-mic-hold-time');
        if (holdTimeInput) holdTimeInput.value = String(holdTime);
        this._updateMicHoldTimeLabel(holdTime);

        const meterRow = document.getElementById('mic-meter-row');
        if (meterRow) meterRow.classList.toggle('hidden', micMode !== 'voice-activity');

        this.ui?.updateMicModeBadge?.(micMode);
    }

    // Live mic-level meter + threshold marker, shown alongside the sensitivity
    // slider (voice-activity mode only) so tuning it isn't guesswork — speak
    // and watch where your level actually sits relative to the line. Runs for
    // as long as the Settings panel is open (cheap: one interval, one DOM
    // write), not just while the Audio & Mic section is the active tab.
    _startMicMeter() {
        this._stopMicMeter();
        if (!this.peerManager) return;
        this._micMeterInterval = setInterval(() => this._updateMicMeter(), 100);
        this._updateMicMeter();
    }

    _stopMicMeter() {
        if (this._micMeterInterval) {
            clearInterval(this._micMeterInterval);
            this._micMeterInterval = null;
        }
    }

    _updateMicMeter() {
        const fill = document.getElementById('mic-meter-fill');
        const thresholdLine = document.getElementById('mic-meter-threshold-line');
        const hint = document.getElementById('mic-meter-hint');
        if (!fill) return;

        // Rough ceiling for a normal speaking voice's RMS level on this
        // analyser (see PeerManager._localMicLevel) — not a hard limit, just
        // what maps to a "full" bar for a readable meter.
        const METER_MAX = 0.3;
        const threshold = parseFloat(localStorage.getItem('micThreshold')) || 0.03;
        if (thresholdLine) thresholdLine.style.left = `${Math.min(1, threshold / METER_MAX) * 100}%`;

        const hasLiveMic = !!this.peerManager?.micStream && this.peerManager.micEnabled;
        if (!hasLiveMic) {
            fill.style.width = '0%';
            fill.classList.remove('mic-meter-fill-active');
            if (hint) hint.textContent = 'Turn on your mic to see live levels while you tune this.';
            return;
        }

        const { level, speaking } = this.peerManager.pollSelfMicActivity();
        fill.style.width = `${Math.min(1, level / METER_MAX) * 100}%`;
        fill.classList.toggle('mic-meter-fill-active', speaking);
        if (hint) hint.textContent = "Speak normally — the bar should clear the vertical line while talking and settle below it at rest.";
    }

    _updateMicThresholdLabel(threshold) {
        const label = document.getElementById('settings-mic-threshold-value');
        if (!label) return;
        label.textContent = threshold <= 0.02 ? 'High' : threshold <= 0.06 ? 'Medium' : 'Low';
    }

    _updateMicHoldTimeLabel(ms) {
        const label = document.getElementById('settings-mic-hold-time-value');
        if (!label) return;
        label.textContent = `${(ms / 1000).toFixed(2).replace(/0$/, '')}s`;
    }

    _refreshAudio() {
        const mute = document.getElementById('settings-mute');
        if (mute) mute.checked = localStorage.getItem('muteSounds') === '1';

        const vol = localStorage.getItem('soundVolume') || '0.3';
        const volume = document.getElementById('settings-volume');
        const volumeValue = document.getElementById('settings-volume-value');
        if (volume) volume.value = vol;
        if (volumeValue) volumeValue.textContent = `${Math.round(vol * 100)}%`;

        const masterVol = this.ui?.masterCallVolume ?? 1;
        const masterVolume = document.getElementById('settings-master-volume');
        const masterVolumeValue = document.getElementById('settings-master-volume-value');
        if (masterVolume) masterVolume.value = String(masterVol);
        if (masterVolumeValue) masterVolumeValue.textContent = `${Math.round(masterVol * 100)}%`;

        this._refreshMicMode();
    }

    // --- Privacy & P2P ---

    _wirePrivacy() {
        document.getElementById('settings-auto-accept-files')?.addEventListener('change', (e) => {
            localStorage.setItem('autoAcceptFiles', e.target.checked ? '1' : '0');
        });

        // No confirm-before-destructive-action pattern exists elsewhere in the
        // app to reuse (removing a saved room / kicking a peer both fire
        // immediately) — this is a two-step "click again to confirm" button
        // rather than a native confirm() dialog, to stay in the app's own
        // visual language instead of a jarring native popup.
        const clearBtn = document.getElementById('settings-clear-data');
        if (clearBtn) {
            const defaultLabel = clearBtn.textContent;
            let confirming = false;
            let resetTimer = null;

            clearBtn.addEventListener('click', () => {
                if (!confirming) {
                    confirming = true;
                    clearBtn.textContent = 'Click again to confirm';
                    clearBtn.classList.add('confirming');
                    resetTimer = setTimeout(() => {
                        confirming = false;
                        clearBtn.textContent = defaultLabel;
                        clearBtn.classList.remove('confirming');
                    }, 4000);
                    return;
                }

                clearTimeout(resetTimer);
                localStorage.clear();
                clearBtn.textContent = 'Cleared — reloading...';
                this.ui?.showToast?.('Local data cleared', 'info');
                setTimeout(() => window.location.reload(), 600);
            });
        }
    }

    _refreshPrivacy() {
        const autoAccept = document.getElementById('settings-auto-accept-files');
        if (autoAccept) autoAccept.checked = localStorage.getItem('autoAcceptFiles') === '1';
    }
}
