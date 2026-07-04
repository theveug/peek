// --- public/client/SettingsPanel.js ---
// Full-frame settings overlay (redesign Phase 3). Every control here applies +
// persists immediately on change — there's no Save/Cancel step, matching the
// design spec's interaction model (see CLAUDE.md's redesign notes).
import { setTheme, getEffectiveTheme } from './ThemeManager.js';
import { setAccent, getStoredAccent, accentPresetNames, presetColor } from './AccentManager.js';

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
    }

    close() {
        if (!this.modal) return;
        this.modal.classList.add('hidden');
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

    _wireAppearance() {
        this.modal.querySelectorAll('#settings-theme-picker button').forEach(btn => {
            btn.addEventListener('click', () => {
                setTheme(btn.dataset.theme);
                this._refreshAppearance();
            });
        });
    }

    _refreshAppearance() {
        const current = getEffectiveTheme();
        this.modal.querySelectorAll('#settings-theme-picker button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === current);
        });

        const currentAccent = getStoredAccent();
        this.modal.querySelectorAll('#settings-accent-picker button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.accent === currentAccent);
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

        this.modal.querySelectorAll('#settings-mic-mode-picker button').forEach(btn => {
            btn.addEventListener('click', () => {
                localStorage.setItem('micMode', btn.dataset.micMode);
                this._refreshMicMode();
            });
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
        if (keybindRow) keybindRow.classList.toggle('hidden', micMode === 'toggle');
        const keybindInput = document.getElementById('settings-keybind');
        if (keybindInput) keybindInput.value = localStorage.getItem('micKeybind') || '';
    }

    _refreshAudio() {
        const mute = document.getElementById('settings-mute');
        if (mute) mute.checked = localStorage.getItem('muteSounds') === '1';

        const vol = localStorage.getItem('soundVolume') || '0.3';
        const volume = document.getElementById('settings-volume');
        const volumeValue = document.getElementById('settings-volume-value');
        if (volume) volume.value = vol;
        if (volumeValue) volumeValue.textContent = `${Math.round(vol * 100)}%`;

        this._refreshMicMode();
    }

    // --- Privacy & P2P ---

    _wirePrivacy() {
        document.getElementById('settings-auto-accept-files')?.addEventListener('change', (e) => {
            localStorage.setItem('autoAcceptFiles', e.target.checked ? '1' : '0');
        });
    }

    _refreshPrivacy() {
        const autoAccept = document.getElementById('settings-auto-accept-files');
        if (autoAccept) autoAccept.checked = localStorage.getItem('autoAcceptFiles') === '1';
    }
}
