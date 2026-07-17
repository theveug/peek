// --- public/client/TopbarIdentity.js ---
// Wires the top-bar identity pill's dropdown. The whole avatar+name button is
// the trigger (2026-07-08 redesign — previously a separate caret-only button
// nested inside a non-interactive identity div, duplicating the status
// dropdown that also lived in the room-settings popover, plus a separate gear
// button just to open the full Settings panel). Now there's one dropdown:
// status options + a "Settings" item that opens the full panel.
// UIController.js still owns pushing avatar/name/status *into* the pill's
// display elements; this file only owns the dropdown's own interactivity.

import { getCustomStatuses, getCustomStatus, getActiveCustomStatusId, setActiveCustomStatusId } from './CustomStatuses.js';

export class TopbarIdentity {
    constructor({ peerManager, settingsPanel }) {
        this.peerManager = peerManager;
        this.settingsPanel = settingsPanel;

        this._wireDropdown();
        this._wireOutsideClick();
        this._refreshStatus(); // picks up a still-active custom status's color on load/reconnect
    }

    _wireDropdown() {
        const trigger = document.getElementById('topbar-identity');
        const menu = document.getElementById('topbar-identity-menu');
        if (!trigger || !menu) return;

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const opening = menu.classList.contains('hidden');
            menu.classList.toggle('hidden');
            if (opening) {
                this._refreshStatusText();
                this._renderCustomStatuses();
            }
        });
        this._wireStatusText();
        menu.querySelectorAll('.quick-status-option[data-status]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                // A built-in status is an explicit "something else" choice —
                // drop whatever custom status was active so the dot goes back
                // to the plain class-based color instead of a stale custom hex.
                setActiveCustomStatusId(null);
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
        if (!dot) return;
        dot.className = `topbar-identity-status-dot ${status === 'online' ? '' : status}`.trim();

        // A custom status's color is local-only cosmetic flair (peers only ever
        // see the plain online/away/dnd dot via `status` above) — layer it on
        // top of the class-based color via inline style, same technique
        // UIController.updateParticipantStatus uses for the base colors.
        const activeId = getActiveCustomStatusId();
        const active = activeId ? getCustomStatus(activeId) : null;
        dot.style.background = active ? active.color : '';
    }

    /**
     * Rebuilds the custom-status buttons in the dropdown from localStorage on
     * every open — no change-event plumbing needed since Settings and this
     * dropdown are never open at the same time, matching this codebase's
     * existing poll/read-on-demand style for localStorage-backed state.
     */
    _renderCustomStatuses() {
        const container = document.getElementById('topbar-identity-custom-statuses');
        if (!container) return;
        container.innerHTML = '';
        getCustomStatuses().forEach((status) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'quick-status-option';
            const dot = document.createElement('span');
            dot.className = 'quick-status-dot';
            dot.style.background = status.color;
            btn.appendChild(dot);
            btn.append(status.label); // user-entered — append as a text node, never innerHTML
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._applyCustomStatus(status);
            });
            container.appendChild(btn);
        });
    }

    /**
     * Applies a custom status: the same setManualStatus/setStatusText calls a
     * built-in status uses (so peers see a normal online/away/dnd dot + the
     * label as the caption, no protocol change), plus the status's local
     * mute/deafen/drop-streams side effects.
     *
     * Those side effects click the real dock buttons rather than calling
     * PeerManager directly — PeerManager.toggleMic()/setDeafened()/
     * stopSharing()/stopCam() only flip the underlying state and broadcast;
     * App.js's click handlers are what pair each call with its UI sync
     * (updateMicUI/setDeafenUI/updateShareButton/updateCamUI), none of which
     * PeerManager does itself. Same "click the real button" approach
     * peek-desktop's own hotkey relay and disconnectFromRoom() use, for the
     * same reason. Mute is clicked before deafen so a status that sets both
     * leaves `_micEnabledBeforeDeafen` recording "already muted," matching intent.
     * @param {{id:string,label:string,color:string,baseStatus:string,deafen:boolean,mute:boolean,dropStreams:boolean}} status
     */
    _applyCustomStatus(status) {
        if (!this.peerManager) return;
        if (status.mute && this.peerManager.micEnabled) document.getElementById('mic-toggle')?.click();
        if (status.deafen && !this.peerManager.deafened) document.getElementById('deafen-toggle')?.click();
        if (status.dropStreams) {
            if (this.peerManager.stream) document.getElementById('stop-share-button')?.click();
            if (this.peerManager.camStream) document.getElementById('cam-toggle')?.click();
        }
        this.peerManager.setManualStatus(status.baseStatus);
        this.peerManager.setStatusText(status.label);
        setActiveCustomStatusId(status.id);
        document.getElementById('topbar-identity-menu')?.classList.add('hidden');
        this._refreshStatus();
        this._refreshStatusText();
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
            // Typing a new caption by hand is an explicit "something else"
            // choice too — same reasoning as the built-in status buttons in
            // _wireDropdown, so the dot doesn't keep showing a stale custom color.
            setActiveCustomStatusId(null);
            if (this.peerManager) this.peerManager.setStatusText(value);
            else localStorage.setItem('statusText', value.slice(0, 60));
            this._refreshStatus();
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
