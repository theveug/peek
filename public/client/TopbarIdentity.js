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
            menu.classList.toggle('hidden');
        });
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
