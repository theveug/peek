// --- public/client/QuickRoomSettings.js ---
// Small popover off the controls bar for the handful of settings people
// actually want to change mid-room (status, file trust, follow-speaker,
// screen/cam quality) without opening the full settings panel. Reads/writes
// the exact same localStorage keys and PeerManager calls as SettingsPanel.js —
// this is a second, faster UI entry point, not a second data model.
const STATUS_LABELS = { online: 'Online', away: 'Away', dnd: 'Do Not Disturb' };

export class QuickRoomSettings {
    constructor({ ui, peerManager, settingsPanel }) {
        this.ui = ui;
        this.peerManager = peerManager;
        this.settingsPanel = settingsPanel;

        this.button = document.getElementById('quick-settings-button');
        this.popover = document.getElementById('quick-settings-popover');
        if (!this.button || !this.popover) return;

        this._wireToggle();
        this._wireStatus();
        this._wireToggles();
        this._wireQuality();
        this._wireMoreLink();
        this._wireOutsideClick();
    }

    open() {
        this._refresh();
        this.popover.classList.remove('hidden');
    }

    close() {
        this.popover.classList.add('hidden');
        document.getElementById('quick-status-menu')?.classList.add('hidden');
    }

    _wireToggle() {
        this.button.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.popover.classList.contains('hidden')) this.open();
            else this.close();
        });
    }

    _wireOutsideClick() {
        document.addEventListener('click', (e) => {
            if (this.popover.classList.contains('hidden')) return;
            if (this.popover.contains(e.target) || e.target === this.button) return;
            this.close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.popover.classList.contains('hidden')) this.close();
        });
    }

    _wireStatus() {
        const trigger = document.getElementById('quick-status-trigger');
        const menu = document.getElementById('quick-status-menu');
        trigger?.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.toggle('hidden');
        });
        menu?.querySelectorAll('.quick-status-option').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.peerManager?.setManualStatus(btn.dataset.status);
                menu.classList.add('hidden');
                this._refreshStatus();
            });
        });
    }

    _refreshStatus() {
        const status = this.peerManager?.status || 'online';
        const dot = document.getElementById('quick-status-dot');
        const label = document.getElementById('quick-status-label');
        if (dot) dot.className = `quick-status-dot ${status === 'online' ? '' : status}`.trim();
        if (label) label.textContent = STATUS_LABELS[status] || 'Online';
    }

    _wireToggles() {
        document.getElementById('quick-auto-accept-files')?.addEventListener('change', (e) => {
            localStorage.setItem('autoAcceptFiles', e.target.checked ? '1' : '0');
        });

        document.getElementById('quick-follow-speaker')?.addEventListener('change', (e) => {
            const checked = e.target.checked;
            localStorage.setItem('followActiveSpeaker', checked ? '1' : '0');
            if (checked && this.ui) this.ui.autoFocusPaused = false;
        });
    }

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

    _wireQuality() {
        this._wireSegmented('quick-screen-res-picker', 'screenShareRes', () => this.peerManager?.applyQualitySettings());
        this._wireSegmented('quick-cam-res-picker', 'camRes', () => this.peerManager?.applyCamQualitySettings());
    }

    _wireMoreLink() {
        document.getElementById('quick-settings-more')?.addEventListener('click', () => {
            this.close();
            this.settingsPanel?.open();
        });
    }

    _refresh() {
        this._refreshStatus();

        const autoAccept = document.getElementById('quick-auto-accept-files');
        if (autoAccept) autoAccept.checked = localStorage.getItem('autoAcceptFiles') === '1';

        const followSpeaker = document.getElementById('quick-follow-speaker');
        if (followSpeaker) followSpeaker.checked = localStorage.getItem('followActiveSpeaker') === '1';

        this._highlightSegmented('quick-screen-res-picker', 'screenShareRes', '1280x720');
        this._highlightSegmented('quick-cam-res-picker', 'camRes', '640x480');
    }
}
