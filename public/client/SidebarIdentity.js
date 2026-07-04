// --- public/client/SidebarIdentity.js ---
// Wires the members sidebar's footer strip (redesign Phase 2c): a clickable
// status control and a settings gear, both second entry points to controls
// that already exist elsewhere (top-bar identity display, QuickRoomSettings'
// status dropdown, SettingsPanel) — same localStorage/PeerManager calls, no
// new data model. UIController.js owns pushing avatar/name/status *into* the
// footer's display elements; this file only owns the footer's own interactivity.
const STATUS_LABELS = { online: 'Online', away: 'Away', dnd: 'Do Not Disturb' };

export class SidebarIdentity {
    constructor({ ui, peerManager, settingsPanel }) {
        this.ui = ui;
        this.peerManager = peerManager;
        this.settingsPanel = settingsPanel;

        this._wireStatus();
        this._wireSettingsGear();
        this._wireOutsideClick();
    }

    _wireStatus() {
        const trigger = document.getElementById('sidebar-status-trigger');
        const menu = document.getElementById('sidebar-status-menu');
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
        const dot = document.getElementById('sidebar-status-dot');
        const label = document.getElementById('sidebar-status-label');
        if (dot) dot.className = `quick-status-dot ${status === 'online' ? '' : status}`.trim();
        if (label) label.textContent = STATUS_LABELS[status] || 'Online';
    }

    _wireSettingsGear() {
        document.getElementById('sidebar-settings-button')?.addEventListener('click', () => {
            this.settingsPanel?.open();
        });
    }

    _wireOutsideClick() {
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('sidebar-status-menu');
            const trigger = document.getElementById('sidebar-status-trigger');
            if (!menu || menu.classList.contains('hidden')) return;
            if (menu.contains(e.target) || e.target === trigger) return;
            menu.classList.add('hidden');
        });
        document.addEventListener('keydown', (e) => {
            const menu = document.getElementById('sidebar-status-menu');
            if (e.key === 'Escape' && menu && !menu.classList.contains('hidden')) {
                menu.classList.add('hidden');
            }
        });
    }
}
