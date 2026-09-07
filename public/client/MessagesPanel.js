// --- public/client/MessagesPanel.js ---
// Accounts Phase 4 (2026-09-07): lobby-only direct-messages popover, modeled
// on FriendsPanel.js/AccountPanel.js's popover shape (toggle, outside-click/
// Escape close, no focus trap). Two views sharing one popover: an inbox
// (conversation list) and a conversation thread — `_showInbox()`/
// `_showConversation()` toggle which is visible, `messages-back-btn`
// returns to the inbox.
//
// #messages-button stays hidden until BOTH accounts are enabled AND the
// viewer is logged in — same `peek:account` gating as FriendsPanel.js.
// FriendsPanel.js dispatches `peek:open-dm` (with {username}) when its own
// "Message" row action is clicked, since there's no other way for one
// popover to tell another "open this conversation" without a direct
// reference between them (both are independently constructed by lobby.js).
//
// Deliberately plain-text, not markdown: `_renderThread()` uses textContent
// for every message body, not the marked/DOMPurify pipeline ChatUI.js uses
// for room chat — free text from another account is exactly the kind of
// input escapeHtml.js/DOMPurify exist for elsewhere in this app, and
// textContent is the simplest sufficient answer for a v1 with no formatting
// features to justify parsing markdown at all. See CLAUDE.md's "Accounts,
// Phase 4" entry for the fuller reasoning and what's deliberately cut.
export class MessagesPanel {
    constructor() {
        this.button = document.getElementById('messages-button');
        this.popover = document.getElementById('messages-popover');
        if (!this.button || !this.popover) return;

        this.backBtn = document.getElementById('messages-back-btn');
        this.titleEl = document.getElementById('messages-popover-title');
        this.inboxView = document.getElementById('messages-inbox-view');
        this.conversationView = document.getElementById('messages-conversation-view');
        this.thread = document.getElementById('messages-thread');
        this.input = document.getElementById('messages-input');
        this.sendBtn = document.getElementById('messages-send-btn');
        this.unreadBadge = document.getElementById('messages-unread-badge');

        this._conversations = []; // last fetched inbox, for cheap re-render on a poll tick
        this._activeUsername = null; // which conversation thread is open, if any
        this._lastThreadLength = -1; // message count last rendered into the open thread, see _pollActiveThread()

        this._init();
    }

    async _init() {
        const trust = await fetch('/api/trust').then(r => r.json()).catch(() => null);
        if (!trust?.accounts) return; // stays hidden — accounts aren't enabled on this deployment

        this._wireToggle();
        this._wireOutsideClick();
        this._wireBack();
        this._wireSend();
        document.addEventListener('peek:account', (e) => this._setLoggedIn(e.detail.loggedIn));
        document.addEventListener('peek:open-dm', (e) => this.openConversation(e.detail.username));

        const me = await fetch('/api/auth/me').then(r => r.ok ? r.json() : null).catch(() => null);
        this._setLoggedIn(!!me);
    }

    _setLoggedIn(loggedIn) {
        this.button.classList.toggle('hidden', !loggedIn);
        if (!loggedIn) this.close();
    }

    open() {
        this.popover.classList.remove('hidden');
        this._showInbox();
    }

    close() {
        this.popover.classList.add('hidden');
    }

    /** Entry point for FriendsPanel.js's "Message" row action (via the
     * `peek:open-dm` event) and for re-opening an already-active thread. */
    openConversation(username) {
        this.popover.classList.remove('hidden');
        this._showConversation(username);
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

    _wireBack() {
        this.backBtn.addEventListener('click', () => this._showInbox());
    }

    _wireSend() {
        const submit = async () => {
            const body = this.input.value;
            if (!body.trim() || !this._activeUsername) return;
            this.sendBtn.disabled = true;
            try {
                const res = await fetch(`/api/messages/${encodeURIComponent(this._activeUsername)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ body }),
                });
                const data = await res.json();
                if (data.error) return; // best-effort v1 — no inline send-error UI yet, message just stays in the box
                this.input.value = '';
                await this._loadConversation(this._activeUsername);
            } catch {
                // offline — leave the typed text in place so nothing's lost
            } finally {
                this.sendBtn.disabled = false;
            }
        };
        this.sendBtn.addEventListener('click', submit);
        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
    }

    _showInbox() {
        this._activeUsername = null;
        this.backBtn.classList.add('hidden');
        this.titleEl.textContent = 'Messages';
        this.conversationView.classList.add('hidden');
        this.inboxView.classList.remove('hidden');
        this._refreshInbox();
    }

    async _showConversation(username) {
        this._activeUsername = username;
        this.backBtn.classList.remove('hidden');
        this.titleEl.textContent = username; // account usernames are already regex-constrained (authRoutes.js's USERNAME_RE) — safe as textContent regardless
        this.inboxView.classList.add('hidden');
        this.conversationView.classList.remove('hidden');
        this.input.value = '';
        await this._loadConversation(username);
        this.input.focus();
    }

    async _loadConversation(username) {
        const res = await fetch(`/api/messages/${encodeURIComponent(username)}`);
        if (!res.ok) {
            this.thread.innerHTML = '';
            const empty = document.createElement('div');
            empty.className = 'quick-banned-empty';
            empty.textContent = 'Could not load this conversation.';
            this.thread.appendChild(empty);
            return;
        }
        const { messages } = await res.json();
        this._renderThread(messages);
        // Reading the conversation just cleared its unread count server-side
        // (DirectMessagesManager.getConversation()'s side effect) — refresh
        // the inbox cache so a later _showInbox()/poll tick reflects that
        // immediately instead of showing a stale unread badge.
        this._refreshInbox();
    }

    _renderThread(messages) {
        this.thread.innerHTML = '';
        for (const { body, fromMe } of messages) {
            const bubble = document.createElement('div');
            bubble.className = 'messages-bubble' + (fromMe ? ' messages-bubble-mine' : '');
            bubble.textContent = body; // plain text only — see file header for why
            this.thread.appendChild(bubble);
        }
        this.thread.scrollTop = this.thread.scrollHeight;
        this._lastThreadLength = messages.length;
    }

    /**
     * Bug fix (2026-09-07 real-usage audit): an open conversation used to never
     * live-update at all — _applyConversations() only ever re-renders the inbox
     * list, explicitly skipping while a thread is open, and nothing else polled
     * the open thread itself. Called on every messagesPoll.js tick (see
     * setConversations() below) so two friends actually chatting see new
     * messages arrive within one poll interval instead of only after leaving
     * and reopening the conversation. Deliberately doesn't call _refreshInbox()
     * itself (unlike _loadConversation(), which does, for the "reading marks
     * read" side effect on a real open) — setConversations()'s own
     * _applyConversations() call already just refreshed the inbox cache this
     * same tick, so doing it again here would be a redundant fetch for no
     * benefit. Skips the re-render entirely when the message count hasn't
     * changed, so a quiet conversation doesn't get its scroll position yanked
     * to the bottom every 30 seconds for nothing.
     */
    async _pollActiveThread() {
        if (!this._activeUsername) return;
        const res = await fetch(`/api/messages/${encodeURIComponent(this._activeUsername)}`).catch(() => null);
        if (!res?.ok) return;
        const { messages } = await res.json();
        if (messages.length === this._lastThreadLength) return;
        this._renderThread(messages);
    }

    async _refreshInbox() {
        const res = await fetch('/api/messages');
        if (!res.ok) return;
        const { conversations } = await res.json();
        this._applyConversations(conversations);
    }

    /** Shared by _refreshInbox()'s own fetch and lobby.js's messagesPoll.js
     * tick (setUnread()) — both need the same render + badge-total logic. */
    _applyConversations(conversations) {
        this._conversations = conversations;
        if (!this.popover.classList.contains('hidden') && !this._activeUsername) this._renderInbox();
        this._updateBadge();
    }

    /** Called by lobby.js on every messagesPoll.js tick. */
    setConversations(conversations) {
        this._applyConversations(conversations);
        this._pollActiveThread();
    }

    _updateBadge() {
        const total = this._conversations.reduce((sum, c) => sum + c.unreadCount, 0);
        this.unreadBadge.textContent = total > 99 ? '99+' : String(total);
        this.unreadBadge.classList.toggle('hidden', total === 0);
    }

    _renderInbox() {
        const list = document.getElementById('messages-inbox-list');
        list.innerHTML = '';
        if (!this._conversations.length) {
            list.innerHTML = '<div class="quick-banned-empty">No conversations yet — message a friend from the Friends list.</div>';
            return;
        }
        for (const { user, lastMessage, unreadCount } of this._conversations) {
            const row = document.createElement('div');
            row.className = 'quick-banned-row';
            row.style.cursor = 'pointer';
            row.tabIndex = 0;

            const nameGroup = document.createElement('div');
            nameGroup.className = 'messages-inbox-name-group';

            const name = document.createElement('span');
            name.className = 'quick-banned-name';
            name.textContent = user.username;
            nameGroup.appendChild(name);

            const preview = document.createElement('span');
            preview.className = 'messages-inbox-preview';
            preview.textContent = (lastMessage.fromMe ? 'You: ' : '') + lastMessage.body;
            nameGroup.appendChild(preview);

            row.appendChild(nameGroup);

            if (unreadCount > 0) {
                const badge = document.createElement('span');
                badge.className = 'messages-inbox-unread-count';
                badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
                row.appendChild(badge);
            }

            const open = () => this._showConversation(user.username);
            row.addEventListener('click', open);
            row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });

            list.appendChild(row);
        }
    }
}
