// --- public/client/TopbarIdentity.js ---
// Wires the top-bar identity pill's status dropdown (moved here from the
// members sidebar footer, which was a redundant second entry point once this
// existed in the top bar). UIController.js owns pushing avatar/name/status
// *into* the pill's display elements; this file only owns the dropdown's own
// interactivity. The settings gear lives separately in the top bar
// (#settings-button, wired in App.js) so it isn't duplicated here.

export class TopbarIdentity {
    constructor({ peerManager }) {
        this.peerManager = peerManager;

        this._wireStatus();
        this._wireOutsideClick();
    }

    _wireStatus() {
        const trigger = document.getElementById('topbar-identity-status-trigger');
        const menu = document.getElementById('topbar-identity-status-menu');
        if (!trigger || !menu) return;

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.toggle('hidden');
        });
        menu.querySelectorAll('.quick-status-option').forEach(btn => {
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
        const dot = document.getElementById('topbar-identity-status-dot');
        if (dot) dot.className = `quick-status-dot ${status === 'online' ? '' : status}`.trim();
    }

    _wireOutsideClick() {
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('topbar-identity-status-menu');
            const trigger = document.getElementById('topbar-identity-status-trigger');
            if (!menu || menu.classList.contains('hidden')) return;
            if (menu.contains(e.target) || e.target === trigger) return;
            menu.classList.add('hidden');
        });
        document.addEventListener('keydown', (e) => {
            const menu = document.getElementById('topbar-identity-status-menu');
            if (e.key === 'Escape' && menu && !menu.classList.contains('hidden')) {
                menu.classList.add('hidden');
            }
        });
    }
}
