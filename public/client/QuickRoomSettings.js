// --- public/client/QuickRoomSettings.js ---
// Small popover off the controls bar for the handful of settings people
// actually want to change mid-room (file trust, follow-speaker, screen/cam
// quality) without opening the full settings panel. Reads/writes the exact
// same localStorage keys and PeerManager calls as SettingsPanel.js — this is
// a second, faster UI entry point, not a second data model.
// Status and "All settings" used to live here too (2026-07-08 redesign moved
// both into the merged top-bar identity dropdown, see TopbarIdentity.js —
// status was duplicated in two places, and "All settings" duplicated the
// standalone gear button that opened the same panel).
export class QuickRoomSettings {
    constructor({ ui, peerManager }) {
        this.ui = ui;
        this.peerManager = peerManager;

        this.button = document.getElementById('quick-settings-button');
        this.popover = document.getElementById('quick-settings-popover');
        if (!this.button || !this.popover) return;

        this._wireToggle();
        this._wireToggles();
        this._wireQuality();
        this._wireOutsideClick();
        this._wireBannedList();
    }

    open() {
        this._refresh();
        this._refreshBannedSection();
        this.popover.classList.remove('hidden');
    }

    close() {
        this.popover.classList.add('hidden');
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

    _refresh() {
        const autoAccept = document.getElementById('quick-auto-accept-files');
        if (autoAccept) autoAccept.checked = localStorage.getItem('autoAcceptFiles') === '1';

        const followSpeaker = document.getElementById('quick-follow-speaker');
        if (followSpeaker) followSpeaker.checked = localStorage.getItem('followActiveSpeaker') === '1';

        this._highlightSegmented('quick-screen-res-picker', 'screenShareRes', '1280x720');
        this._highlightSegmented('quick-cam-res-picker', 'camRes', '640x480');
    }

    /**
     * Creator-only "Banned users" section — hidden entirely for anyone else,
     * since a non-creator's listBans()/unbanPeer() requests are just silently
     * ignored server-side anyway (same enforcement pattern as the moderator
     * kebab menu: this visibility check is a UI nicety, not the trust boundary).
     * @returns {void}
     */
    _refreshBannedSection() {
        const section = document.getElementById('quick-banned-section');
        if (!section) return;
        if (!this.peerManager?.isCreatorMe?.()) {
            section.style.display = 'none';
            return;
        }
        section.style.display = '';
        const list = document.getElementById('quick-banned-list');
        if (list) list.innerHTML = '<div class="quick-banned-empty">Loading…</div>';
        this.peerManager.listBans();
    }

    /** Wires the onBanList callback that both listBans() and unbanPeer() resolve through. */
    _wireBannedList() {
        if (!this.peerManager) return;
        this.peerManager.onBanList = (bans) => this._renderBannedList(bans);
    }

    /**
     * Renders the banned-users list from a fresh onBanList payload. Each row's
     * Unban button re-requests the list itself (via unbanPeer's own 'ban-list'
     * reply) rather than optimistically splicing the array locally, so the
     * displayed list can never drift from the server's actual state.
     * @param {{banId: string, nickname: string, bannedAt: number}[]} bans
     * @returns {void}
     */
    _renderBannedList(bans) {
        const list = document.getElementById('quick-banned-list');
        if (!list) return;
        list.innerHTML = '';
        if (!bans.length) {
            list.innerHTML = '<div class="quick-banned-empty">No one is banned.</div>';
            return;
        }
        bans.forEach(({ banId, nickname }) => {
            const row = document.createElement('div');
            row.className = 'quick-banned-row';

            const name = document.createElement('span');
            name.className = 'quick-banned-name';
            name.textContent = nickname; // textContent — never innerHTML for peer-controlled text
            row.appendChild(name);

            const unbanBtn = document.createElement('button');
            unbanBtn.type = 'button';
            unbanBtn.className = 'quick-banned-unban-btn';
            unbanBtn.textContent = 'Unban';
            unbanBtn.dataset.tip = `Unban ${nickname}`;
            unbanBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.peerManager.unbanPeer(banId);
            });
            row.appendChild(unbanBtn);

            list.appendChild(row);
        });
    }
}
