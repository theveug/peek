// --- public/client/MessagesPanel.js ---
// Accounts Phase 4 (2026-09-07): direct-messages sub-panel. Two views
// sharing one section: an inbox (conversation list) and a conversation
// thread — `_showInbox()`/`_showConversation()` toggle which is visible,
// `messages-back-btn` returns to the inbox.
//
// Markup is built by SocialPanel.js's self-building modal (2026-09-08
// polish pass — this used to be its own lobby-only anchored popover; see
// that file's header comment for why, and AccountPanel.js's for the
// matching change there). SocialPanel.js gates construction of this class
// on /api/trust + login state itself, so this file no longer re-checks
// either. FriendsPanel.js dispatches `peek:open-dm` (with {username}) when
// its own "Message" row action is clicked, since there's no other way for
// one sub-panel to tell another "open this conversation" without a direct
// reference between them (both are independently constructed by
// SocialPanel.js) — SocialPanel.js has its own listener on the same event
// to bring the whole modal to the Messages tab; see openConversation()
// below and onShow()'s header comment for how the two avoid racing.
//
// Deliberately plain-text, not markdown: `_renderThread()` uses textContent
// for every message body, not the marked/DOMPurify pipeline ChatUI.js uses
// for room chat — free text from another account is exactly the kind of
// input escapeHtml.js/DOMPurify exist for elsewhere in this app, and
// textContent is the simplest sufficient answer for a v1 with no formatting
// features to justify parsing markdown at all. See CLAUDE.md's "Accounts,
// Phase 4" entry for the fuller reasoning and what's deliberately cut.
import { playSound } from './SoundPlayer.js';

export class MessagesPanel {
    constructor() {
        // Defensive guard, shouldn't fire in practice — SocialPanel.js always
        // builds this markup before constructing this class.
        if (!document.getElementById('messages-thread')) return;

        this.backBtn = document.getElementById('messages-back-btn');
        this.titleEl = document.getElementById('messages-popover-title');
        this.inboxView = document.getElementById('messages-inbox-view');
        this.conversationView = document.getElementById('messages-conversation-view');
        this.thread = document.getElementById('messages-thread');
        this.input = document.getElementById('messages-input');
        this.sendBtn = document.getElementById('messages-send-btn');
        this.unreadBadge = document.getElementById('social-unread-badge');
        // Used only by _applyConversations() below to decide whether a live
        // re-render is worth doing right now — SocialPanel.js owns actual
        // visibility.
        this._sectionEl = this.thread.closest('.social-tab-panel');
        this._modalEl = document.getElementById('social-modal');

        this._conversations = []; // last fetched inbox, for cheap re-render on a poll tick
        this._activeUsername = null; // which conversation thread is open, if any
        this._lastThreadLength = -1; // message count last rendered into the open thread, see _pollActiveThread()
        this._conversationsLoaded = false; // see _applyConversations() — suppresses notify-on-first-fetch
        this._lastMessageSoundAt = -Infinity; // throttle, same 1.5s window as ChatUI.js's _playMessageSound()

        this._wireBack();
        this._wireSend();
        document.addEventListener('peek:open-dm', (e) => this.openConversation(e.detail.username));
    }

    /** Called by SocialPanel.js whenever the Messages tab becomes the active
     * section. Idempotent w.r.t. an already-open conversation (refreshes it
     * rather than resetting to the inbox) — matters because this can also
     * run right after FriendsPanel.js's "Message" action already opened a
     * specific conversation via the peek:open-dm event (SocialPanel.js's own
     * listener on that event calls open('messages'), which calls this too);
     * without that guard whichever handler ran second would stomp the
     * other's view. */
    onShow() {
        if (this._activeUsername) this._loadConversation(this._activeUsername);
        else this._showInbox();
    }

    /** Entry point for FriendsPanel.js's "Message" row action (via the
     * `peek:open-dm` event) and for re-opening an already-active thread. */
    openConversation(username) {
        this._showConversation(username);
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
        this.input.placeholder = `Message ${username}`; // same convention as the room composer's "Message the room"
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
        // Must run before this._conversations is overwritten below — diffs
        // against the previous snapshot to find conversations whose unread
        // count just went up. Suppressed on the very first fetch (page load/
        // modal construction) so pre-existing unread DMs from before this
        // session don't all ping at once.
        if (this._conversationsLoaded) this._notifyNewMessages(conversations);
        this._conversationsLoaded = true;

        this._conversations = conversations;
        const visible = this._sectionEl?.classList.contains('active') && !this._modalEl?.classList.contains('hidden');
        if (visible && !this._activeUsername) this._renderInbox();
        this._updateBadge();
    }

    /**
     * Sound + desktop-notification parity with ChatUI.js's @mention handling
     * (owner-reported 2026-09-08: a DM is at least as "for you" as a mention,
     * but used to arrive completely silently). Only conversations whose
     * unread count just increased are notified — a poll tick that re-fetches
     * an unchanged inbox, or one where the last message is our own reply,
     * pings nothing.
     * @param {Array<{user:object, lastMessage:object, unreadCount:number}>} conversations
     */
    _notifyNewMessages(conversations) {
        const oldUnread = new Map(this._conversations.map(c => [c.user.username, c.unreadCount]));
        for (const { user, lastMessage, unreadCount } of conversations) {
            if (lastMessage.fromMe) continue;
            if (unreadCount <= (oldUnread.get(user.username) || 0)) continue;
            // Already looking at this exact conversation with the window
            // focused — it just live-updated via _pollActiveThread(), same
            // "already visible, skip the ping" rule as ChatUI's _isChatViewClosed().
            if (document.hasFocus() && this._isConversationViewOpen(user.username)) continue;
            this._playMessageSound();
            this._desktopNotify(user.username, lastMessage.body);
        }
    }

    _isConversationViewOpen(username) {
        const visible = this._sectionEl?.classList.contains('active') && !this._modalEl?.classList.contains('hidden');
        return !!visible && this._activeUsername === username;
    }

    /** Throttled the same way as ChatUI.js's _playMessageSound() — a burst of
     * DMs (or a DM landing alongside an unrelated poll tick) pings once. */
    _playMessageSound() {
        const now = Date.now();
        if (now - this._lastMessageSoundAt > 1500) playSound('newMessage');
        this._lastMessageSoundAt = now;
    }

    /**
     * Same opt-in/gating contract as ChatUI.js's _desktopNotify(): only while
     * `desktopNotifications` is enabled, permission is already granted, and
     * the window is unfocused (a focused tab already got the sound above).
     * `silent: true` for the same reason — the sound just played, and Web
     * Audio keeps playing in a backgrounded tab, so the OS notification's
     * own sound would double up.
     * @param {string} username - account usernames are regex-constrained
     *     (authRoutes.js's USERNAME_RE) — safe with no escaping.
     * @param {string} body
     */
    _desktopNotify(username, body) {
        if (document.hasFocus()) return;
        if (localStorage.getItem('desktopNotifications') !== '1') return;
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        try {
            const n = new Notification(`${username} sent you a message`, {
                body: String(body || '').slice(0, 140),
                silent: true,
            });
            n.onclick = () => {
                window.focus();
                document.dispatchEvent(new CustomEvent('peek:open-dm', { detail: { username } }));
                n.close();
            };
        } catch {
            // Some platforms (e.g. Android Chrome) require ServiceWorker-based
            // notifications and throw on the constructor — degrade to sound-only.
        }
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
