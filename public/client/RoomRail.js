// --- public/client/RoomRail.js ---
// Discord-style left icon rail for quick room switching. Shared component
// mounted on BOTH the lobby and the in-room page — builds its own DOM into
// document.body (same precedent as SettingsPanel.js's _buildModal()) rather
// than needing markup duplicated in index.html/lobby.html.
//
// Owns its saved-room data (savedRooms.js), its own live-status polling
// (roomStatusPoll.js), and its own minimal join-attempt logic — deliberately
// not importing lobby.js's attemptJoin(), which closes over lobby-page-only
// form DOM. currentRoomCode/navigate are the only two pieces of host context
// it needs: what room (if any) is "you are here", and how to actually leave.
// On the lobby, navigate is a plain redirect; in-room, it's App.js's
// leaveSession() so an active call is torn down properly before switching.
import { getSavedRooms, saveRoom, removeRoom } from '/client/savedRooms.js';
import { startRoomStatusPolling } from '/client/roomStatusPoll.js';
import { escapeHtml } from '/client/escapeHtml.js';

function hueFromString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) % 360;
    return Math.abs(hash);
}

function initialsFromLabel(label) {
    const words = label.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return label.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '??';
}

export class RoomRail {
    constructor({ currentRoomCode = null, navigate } = {}) {
        this.currentRoomCode = currentRoomCode;
        this.navigate = navigate;
        this._statusMap = new Map();
        this._stopPolling = null;
        this._anchor = null;

        this.rail = document.getElementById('room-rail') || this._buildRail();
        this.listEl = this.rail.querySelector('#room-rail-list');
        this.popover = document.getElementById('room-rail-popover') || this._buildPopover();

        this._wireOutsideClick();
        this.render();
    }

    _buildRail() {
        const rail = document.createElement('nav');
        rail.id = 'room-rail';
        rail.className = 'room-rail';
        rail.innerHTML = `
            <button type="button" id="room-rail-home" class="room-rail-btn" data-tip="Home">
                <span class="material-symbols-rounded">home</span>
            </button>
            <div class="room-rail-divider"></div>
            <div id="room-rail-list" class="room-rail-list"></div>
            <button type="button" id="room-rail-add" class="room-rail-btn" data-tip="New room">
                <span class="material-symbols-rounded">add</span>
            </button>
        `;
        document.body.appendChild(rail);
        rail.querySelector('#room-rail-home').addEventListener('click', () => this._handleHome());
        rail.querySelector('#room-rail-add').addEventListener('click', () => this._handleAdd());
        return rail;
    }

    _buildPopover() {
        const el = document.createElement('div');
        el.id = 'room-rail-popover';
        el.className = 'room-rail-popover hidden';
        document.body.appendChild(el);
        return el;
    }

    _handleHome() {
        if (location.pathname === '/') return;
        sessionStorage.removeItem('roomPassword');
        this.navigate('/');
    }

    _handleAdd() {
        sessionStorage.removeItem('roomPassword');
        this.navigate('/?new=1');
    }

    render() {
        const rooms = getSavedRooms();
        this.listEl.innerHTML = '';

        rooms.forEach((room) => {
            const item = document.createElement('div');
            item.className = 'room-rail-item' + (room.code === this.currentRoomCode ? ' current' : '');
            item.dataset.code = room.code;
            item.dataset.label = room.label;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'room-rail-btn room-rail-avatar-btn';
            btn.style.background = `oklch(0.55 0.13 ${hueFromString(room.code + room.label)})`;
            btn.dataset.tip = room.label;
            btn.textContent = initialsFromLabel(room.label);

            const statusDot = document.createElement('span');
            statusDot.className = 'room-rail-status';
            statusDot.dataset.state = 'unknown';
            btn.appendChild(statusDot);

            btn.addEventListener('click', () => this._handleRoomClick(room, btn));

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'room-rail-remove';
            removeBtn.dataset.tip = 'Remove';
            removeBtn.innerHTML = '<span class="material-symbols-rounded">close</span>';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                removeRoom(room.code);
                this.render();
            });

            item.appendChild(btn);
            item.appendChild(removeBtn);
            this.listEl.appendChild(item);
            this._applyStatus(item, room.code);
        });

        if (rooms.length > 0 && !this._stopPolling) {
            this._stopPolling = startRoomStatusPolling(
                () => getSavedRooms().map((r) => r.code),
                (statuses) => this._updateStatuses(statuses),
            );
        } else if (rooms.length === 0 && this._stopPolling) {
            this._stopPolling();
            this._stopPolling = null;
        }
    }

    _updateStatuses(statuses) {
        for (const [code, status] of Object.entries(statuses)) this._statusMap.set(code, status);
        this.listEl.querySelectorAll('.room-rail-item').forEach((item) => this._applyStatus(item, item.dataset.code));
    }

    _applyStatus(item, code) {
        const dot = item.querySelector('.room-rail-status');
        const btn = item.querySelector('.room-rail-avatar-btn');
        if (!dot || !btn) return;
        const label = item.dataset.label || '';
        const status = this._statusMap.get(code);
        if (!status) {
            dot.dataset.state = 'unknown';
            btn.dataset.tip = label;
        } else if (status.active) {
            dot.dataset.state = 'active';
            btn.dataset.tip = `${label} · ${status.peerCount} / ${status.maxPeers} in room`;
        } else {
            dot.dataset.state = 'inactive';
            btn.dataset.tip = label;
        }
    }

    async _handleRoomClick(room, anchorBtn) {
        if (room.code === this.currentRoomCode) return;
        this._showPopover(anchorBtn, `
            <div class="room-rail-popover-title">${escapeHtml(room.label)}</div>
            <div class="room-rail-popover-status">Joining…</div>
        `);
        await this._tryJoin(room, room.password, anchorBtn);
    }

    async _tryJoin(room, password, anchorBtn) {
        let result;
        try {
            const res = await fetch('/api/validate-room', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: room.code, password: password || null }),
            });
            result = await res.json();
        } catch {
            this._showPopover(anchorBtn, `
                <div class="room-rail-popover-title">${escapeHtml(room.label)}</div>
                <div class="room-rail-popover-status">Could not reach the server.</div>
            `);
            return;
        }

        if (result.full) {
            this._showPopover(anchorBtn, `
                <div class="room-rail-popover-title">${escapeHtml(room.label)}</div>
                <div class="room-rail-popover-status">Room is full.</div>
            `);
            return;
        }

        if (result.needsPassword) {
            this._renderPasswordPrompt(room, anchorBtn, !!result.wrongPassword);
            return;
        }

        // Same set-or-clear reasoning as lobby.js's attemptJoin — never let a
        // stale password from a previously joined room leak into this one.
        if (password) sessionStorage.setItem('roomPassword', password);
        else sessionStorage.removeItem('roomPassword');
        if (password !== room.password) saveRoom({ code: room.code, label: room.label, password: password || null });

        this._closePopover();
        this.navigate('/' + room.code);
    }

    _renderPasswordPrompt(room, anchorBtn, wrong) {
        this._showPopover(anchorBtn, `
            <div class="room-rail-popover-title">${escapeHtml(room.label)}</div>
            <div class="room-rail-popover-status">${wrong ? 'Wrong password. Try again.' : 'This room needs a password.'}</div>
            <div class="room-rail-popover-row">
                <input type="password" class="settings-text-input room-rail-popover-input" placeholder="Password" style="max-width:none;" />
                <button type="button" class="lobby-btn-secondary room-rail-popover-join">Join</button>
            </div>
        `);
        const input = this.popover.querySelector('.room-rail-popover-input');
        const joinBtn = this.popover.querySelector('.room-rail-popover-join');
        input?.focus();
        const submit = () => this._tryJoin(room, input.value, anchorBtn);
        joinBtn?.addEventListener('click', submit);
        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submit();
        });
    }

    _showPopover(anchorEl, innerHTML) {
        this.popover.innerHTML = innerHTML;
        this.popover.classList.remove('hidden');
        this._positionPopover(anchorEl);
        this._anchor = anchorEl;
    }

    _positionPopover(anchorEl) {
        const r = anchorEl.getBoundingClientRect();
        const p = this.popover.getBoundingClientRect();
        const gap = 8;
        let left = r.right + gap;
        if (left + p.width > innerWidth - 8) left = Math.max(8, r.left - p.width - gap);
        const top = Math.max(8, Math.min(r.top, innerHeight - p.height - 8));
        this.popover.style.top = `${top}px`;
        this.popover.style.left = `${left}px`;
    }

    _closePopover() {
        this.popover.classList.add('hidden');
        this.popover.innerHTML = '';
        this._anchor = null;
    }

    _wireOutsideClick() {
        document.addEventListener('click', (e) => {
            if (this.popover.classList.contains('hidden')) return;
            if (this.popover.contains(e.target) || (this._anchor && this._anchor.contains(e.target))) return;
            this._closePopover();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.popover.classList.contains('hidden')) this._closePopover();
        });
    }
}
