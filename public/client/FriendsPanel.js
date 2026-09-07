// --- public/client/FriendsPanel.js ---
// Accounts Phase 2 (friends) — lobby-only popover wiring /api/friends/* into
// a real UI. Modeled directly on AccountPanel.js's popover shape (toggle,
// outside-click/Escape close, no focus trap — same small-anchored-popover
// exemption InvitePopover.js/AccountPanel.js already rely on).
//
// #friends-button starts hidden and only shows once BOTH are true: accounts
// are enabled on this deployment, AND the viewer is actually logged in —
// friends only makes sense for a real account identity, unlike the account
// button itself, which shows once accounts merely exist. Login state comes
// from AccountPanel's 'peek:account' CustomEvent (dispatched from its own
// _renderState()) since there's no other cross-module signal for it on this
// page; this file also checks /api/auth/me itself on init, matching
// AccountPanel._init()'s own double-check shape with /api/trust.
//
// Phase 3 (2026-09-07): online/offline dots on friends-list rows, fed by
// lobby.js calling setOnline() on every presencePoll.js tick — see that
// file and friendsRoutes.js's GET /api/friends/presence for the poll-based
// (not always-on-socket) design this follows.
export class FriendsPanel {
    constructor() {
        this.button = document.getElementById('friends-button');
        this.popover = document.getElementById('friends-popover');
        if (!this.button || !this.popover) return;

        // Accounts Phase 3: cached separately from a full _refresh() re-fetch
        // so a presencePoll.js tick (every ~30s) can update online dots via a
        // cheap re-render of already-fetched data, without hitting
        // GET /api/friends again — that heavier fetch only happens when the
        // popover is actually opened.
        this._lastFriends = null;
        this._onlineUsernames = new Set();

        this._init();
    }

    async _init() {
        const trust = await fetch('/api/trust').then(r => r.json()).catch(() => null);
        if (!trust?.accounts) return; // stays hidden — accounts aren't enabled on this deployment

        this._wireToggle();
        this._wireOutsideClick();
        this._wireAddFriend();
        document.addEventListener('peek:account', (e) => this._setLoggedIn(e.detail.loggedIn));

        const me = await fetch('/api/auth/me').then(r => r.ok ? r.json() : null).catch(() => null);
        this._setLoggedIn(!!me);
    }

    _setLoggedIn(loggedIn) {
        this.button.classList.toggle('hidden', !loggedIn);
        if (!loggedIn) this.close();
    }

    open() {
        this.popover.classList.remove('hidden');
        document.getElementById('friends-action-error')?.classList.add('hidden');
        this._refresh();
    }

    close() {
        this.popover.classList.add('hidden');
    }

    _wireToggle() {
        this.button.addEventListener('click', (e) => {
            e.stopPropagation();
            this.popover.classList.contains('hidden') ? this.open() : this.close();
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

    _wireAddFriend() {
        const input = document.getElementById('friends-add-username');
        const errorEl = document.getElementById('friends-add-error');
        const submitBtn = document.getElementById('friends-add-submit');

        const submit = async () => {
            const username = input.value.trim();
            errorEl.classList.add('hidden');
            if (!username) return;

            submitBtn.disabled = true;
            try {
                const res = await fetch('/api/friends/request', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username }),
                });
                const body = await res.json();
                if (body.error) {
                    errorEl.textContent = body.error;
                    errorEl.classList.remove('hidden');
                    return;
                }
                input.value = '';
                this._refresh();
            } catch {
                errorEl.textContent = 'Could not reach the server — try again';
                errorEl.classList.remove('hidden');
            } finally {
                submitBtn.disabled = false;
            }
        };

        submitBtn.addEventListener('click', submit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
    }

    /**
     * Accounts Phase 3: called by lobby.js on every presencePoll.js tick with
     * the latest online/offline set. Only actually re-renders when there's
     * something to render against (a popover open before the first
     * _refresh() has nothing in `_lastFriends` yet) and the popover is
     * visible — no point re-touching hidden DOM every 30s.
     * @param {Array<{username:string, online:boolean}>} presence
     */
    setOnline(presence) {
        this._onlineUsernames = new Set(presence.filter(p => p.online).map(p => p.username));
        if (this._lastFriends && !this.popover.classList.contains('hidden')) this._renderFriendsList();
    }

    _renderFriendsList() {
        this._renderList('friends-list', this._lastFriends.map(({ requestId, username }) => ({
            label: username,
            online: this._onlineUsernames.has(username),
            actions: [
                // No direct reference to MessagesPanel.js — both popovers are
                // independently constructed by lobby.js, so a CustomEvent is
                // the same cross-module signal shape 'peek:account' already
                // uses, just going the other direction (Friends -> Messages).
                { text: 'Message', tip: `Message ${username}`, onClick: () => document.dispatchEvent(new CustomEvent('peek:open-dm', { detail: { username } })) },
                { text: 'Remove', tip: `Remove ${username}`, onClick: () => this._remove(requestId) },
                { text: 'Block', tip: `Block ${username}`, onClick: () => this._block(username) },
            ],
        })), 'No friends yet.');
    }

    /** Rebuilds all four lists from a fresh server fetch every time the popover opens — same
     * "never trust stale local state" precedent as QuickRoomSettings.js's banned-users section. */
    async _refresh() {
        const res = await fetch('/api/friends');
        if (!res.ok) return;
        const { friends, incoming, outgoing, blocked } = await res.json();
        this._lastFriends = friends;
        this._renderFriendsList();
        this._renderList('friends-incoming-list', incoming.map(({ requestId, user }) => ({ label: user.username, actions: [
            { text: 'Accept', tip: `Accept ${user.username}`, onClick: () => this._accept(requestId) },
            { text: 'Decline', tip: `Decline ${user.username}`, onClick: () => this._remove(requestId) },
            { text: 'Block', tip: `Block ${user.username}`, onClick: () => this._block(user.username) },
        ] })), 'No incoming requests.');
        this._renderList('friends-outgoing-list', outgoing.map(({ requestId, user }) => ({ label: user.username, actions: [
            { text: 'Cancel', tip: `Cancel request to ${user.username}`, onClick: () => this._remove(requestId) },
        ] })), 'No sent requests.');
        // Only the blocker's own view — a block is invisible to the person
        // blocked (see FriendsManager.listBlocked()'s doc comment).
        this._renderList('friends-blocked-list', blocked.map(({ blockId, username }) => ({ label: username, actions: [
            { text: 'Unblock', tip: `Unblock ${username}`, onClick: () => this._unblock(blockId) },
        ] })), 'No blocked users.');
    }

    /**
     * Bug fix (2026-09-07 real-usage audit): every row action below used to
     * `.catch(() => {})` and unconditionally re-render — fetch doesn't reject
     * on a 4xx, so a genuine failure (stale row after the other side already
     * acted, a transient 500) produced zero feedback, unlike _wireAddFriend()
     * which already surfaced `body.error`. This is the shared success/error
     * path every row action now goes through, clearing any previous error
     * first so a retry doesn't leave a stale message showing.
     * @returns {Promise<boolean>} whether the request succeeded
     */
    async _runAction(request, genericError) {
        const errorEl = document.getElementById('friends-action-error');
        errorEl?.classList.add('hidden');
        try {
            const res = await request();
            if (res.ok) return true;
            const body = await res.json().catch(() => ({}));
            if (errorEl) { errorEl.textContent = body.error || genericError; errorEl.classList.remove('hidden'); }
            return false;
        } catch {
            if (errorEl) { errorEl.textContent = 'Could not reach the server — try again'; errorEl.classList.remove('hidden'); }
            return false;
        }
    }

    async _accept(requestId) {
        await this._runAction(() => fetch(`/api/friends/${requestId}/accept`, { method: 'POST' }), 'Could not accept request');
        this._refresh(); // always — a failure here is often a stale row (already acted on elsewhere), so refreshing corrects it either way
    }

    async _remove(requestId) {
        await this._runAction(() => fetch(`/api/friends/${requestId}`, { method: 'DELETE' }), 'Could not complete that action');
        this._refresh();
    }

    async _block(username) {
        await this._runAction(() => fetch('/api/friends/block', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username }),
        }), 'Could not block user');
        this._refresh();
    }

    async _unblock(blockId) {
        await this._runAction(() => fetch(`/api/friends/block/${blockId}`, { method: 'DELETE' }), 'Could not unblock user');
        this._refresh();
    }

    _renderList(elementId, rows, emptyText) {
        const list = document.getElementById(elementId);
        if (!list) return;
        list.innerHTML = '';
        if (!rows.length) {
            list.innerHTML = `<div class="quick-banned-empty">${emptyText}</div>`;
            return;
        }
        for (const { label, online, actions } of rows) {
            const row = document.createElement('div');
            row.className = 'quick-banned-row';

            // `online` is only ever set on friends-list rows (undefined
            // elsewhere — incoming/outgoing/blocked have no presence
            // concept), so this dot only renders there.
            if (online !== undefined) {
                const dot = document.createElement('span');
                dot.className = 'friends-presence-dot' + (online ? ' friends-presence-dot-online' : '');
                dot.dataset.tip = online ? 'Online' : 'Offline';
                row.appendChild(dot);
            }

            const name = document.createElement('span');
            name.className = 'quick-banned-name';
            name.textContent = label; // textContent — never innerHTML for peer-controlled text
            row.appendChild(name);

            const actionGroup = document.createElement('div');
            actionGroup.className = 'quick-banned-action-group';
            for (const { text, tip, onClick } of actions) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'quick-banned-unban-btn';
                btn.textContent = text;
                btn.dataset.tip = tip;
                btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
                actionGroup.appendChild(btn);
            }
            row.appendChild(actionGroup);

            list.appendChild(row);
        }
    }
}
