// --- public/client/TopbarIdentity.js ---
// Wires the top-bar identity pill's dropdown. The whole avatar+name button is
// the trigger (2026-07-08 redesign — previously a separate caret-only button
// nested inside a non-interactive identity div, duplicating the status
// dropdown that also lived in the room-settings popover, plus a separate gear
// button just to open the full Settings panel). Now there's one dropdown:
// status options + a "Settings" item that opens the full panel.
// UIController.js still owns pushing avatar/name/status *into* the pill's
// display elements; this file only owns the dropdown's own interactivity.

export class TopbarIdentity {
    constructor({ peerManager, settingsPanel }) {
        this.peerManager = peerManager;
        this.settingsPanel = settingsPanel;

        this._wireDropdown();
        this._wireOutsideClick();
    }

    _wireDropdown() {
        const trigger = document.getElementById('topbar-identity');
        const menu = document.getElementById('topbar-identity-menu');
        if (!trigger || !menu) return;

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const opening = menu.classList.contains('hidden');
            menu.classList.toggle('hidden');
            if (opening) this._refreshStatusText();
        });
        this._wireStatusText();
        menu.querySelectorAll('.quick-status-option[data-status]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.peerManager?.setManualStatus(btn.dataset.status);
                menu.classList.add('hidden');
                this._refreshStatus();
            });
        });
        document.getElementById('topbar-identity-settings')?.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.add('hidden');
            this.settingsPanel?.open();
        });
    }

    _refreshStatus() {
        const status = this.peerManager?.status || 'online';
        const dot = document.getElementById('topbar-identity-status-dot');
        if (dot) dot.className = `topbar-identity-status-dot ${status === 'online' ? '' : status}`.trim();
    }

    /**
     * Custom status text field in the dropdown (2026-07-15) — a second surface
     * for the same value Settings → Profile's `#settings-status-text` edits,
     * not a second data model: both read/write `localStorage['statusText']`
     * via PeerManager.setStatusText(), which persists, broadcasts, and updates
     * the local card in one call. Enter applies and closes the menu; blur
     * applies quietly (matching the Settings field's apply-on-change feel).
     */
    _wireStatusText() {
        const input = document.getElementById('topbar-status-text');
        if (!input) return;
        const apply = () => {
            const value = input.value.trim();
            if (value === (localStorage.getItem('statusText') || '').trim()) return;
            if (this.peerManager) this.peerManager.setStatusText(value);
            else localStorage.setItem('statusText', value.slice(0, 60));
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation(); // keep global keybinds (PTT/deafen) out of typing
            if (e.key === 'Enter') {
                e.preventDefault();
                apply();
                document.getElementById('topbar-identity-menu')?.classList.add('hidden');
            }
        });
        input.addEventListener('blur', apply);
    }

    _refreshStatusText() {
        const input = document.getElementById('topbar-status-text');
        if (input) input.value = localStorage.getItem('statusText') || '';
    }

    _wireOutsideClick() {
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('topbar-identity-menu');
            const trigger = document.getElementById('topbar-identity');
            if (!menu || menu.classList.contains('hidden')) return;
            if (menu.contains(e.target) || e.target === trigger) return;
            menu.classList.add('hidden');
        });
        document.addEventListener('keydown', (e) => {
            const menu = document.getElementById('topbar-identity-menu');
            if (e.key === 'Escape' && menu && !menu.classList.contains('hidden')) {
                menu.classList.add('hidden');
            }
        });
    }
}
