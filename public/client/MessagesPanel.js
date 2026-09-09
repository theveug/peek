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
// Trial (2026-09-09, owner-requested): on the room page this markup is now
// instead built as a third tab in the chat panel (App.js's
// initRoomMessagesTab(), UIController.js's _switchTab('messages')) rather
// than living in SocialPanel.js's modal — a DM is worth keeping an eye on
// mid-call the way chat itself is, unlike Friends management (rarer,
// in-and-out, still a modal). Same class either way — the constructor's
// `badgeId`/`isVisible` options are what let it not care which host it's in.
//
// Renders markdown when the vendor libs are available, plain text otherwise
// (2026-09-09, owner-reported: "can we not reuse the same input area as
// chat so we get all the other features too like code blocks and
// emoticons" — revisiting the "deliberately plain-text" v1 cut TODO.md's
// Phase 4 entry flagged as revisitable). `_renderThread()` feature-detects
// `marked`/`DOMPurify` (both `typeof`-checked, since neither is a module
// import — they're classic-script vendor globals, same as everywhere else
// in this app that uses them) and falls back to the original `textContent`
// path when they're absent. **They're absent on the lobby page** —
// `lobby.html` never loads `marked`/`DOMPurify`/`highlight.js`, unlike
// `index.html` (ChatUI.js already needs them there) — so a DM sent/viewed
// from the lobby's Friends & Messages drawer still renders plain text,
// deliberately, rather than growing the lobby's initial page weight for a
// feature only reachable after logging in and adding a friend.
// `_wireComposerExtras()` below hides the "Code block" +-menu option
// entirely on a page without `hljs` for the same reason — offering it
// would just insert literal backticks with nothing to highlight them.
// Markdown rendering reuses the exact same `marked.parse()` →
// `DOMPurify.sanitize()` → innerHTML pipeline ChatUI.js already runs for
// room chat (not a new attack surface — the same already-audited pattern,
// just applied to a second surface), plus the code-block/inline-code
// highlighting+copy-button treatment shared via `markdownCodeBlocks.js`.
// Deliberately NOT reused: `ChatUI._processMentions()` (a DM thread has no
// participant list to mention against) and link-preview processing (never
// built app-wide to begin with, see CLAUDE.md's own standing rule on that).
import { playSound } from './SoundPlayer.js';
import { openEmojiPicker } from './EmojiPicker.js';
import { openCodeBlockPicker } from './CodeBlockPicker.js';
import { insertAtCaret, wireComposerPlusMenu, isInsideOpenCodeFence, autoGrowTextarea } from './composerUtils.js';
import { finalizeCodeBlocks } from './markdownCodeBlocks.js';

export class MessagesPanel {
    /**
     * @param {{badgeId?: string, isVisible?: () => boolean}} [opts]
     *   Both default to the SocialPanel.js-hosted modal shape (unchanged
     *   lobby/Friends-and-Messages behavior). App.js's room-side "Messages as
     *   a chat-panel tab" trial (2026-09-09) passes both instead, since that
     *   markup has no `.social-tab-panel`/`#social-modal` to key visibility
     *   off of and its badge lives on the tab button, not `#social-unread-badge`.
     */
    constructor({ badgeId = 'social-unread-badge', isVisible } = {}) {
        // Defensive guard, shouldn't fire in practice — whichever host built
        // this markup (SocialPanel.js's modal, or App.js's chat-panel tab)
        // always does so before constructing this class.
        if (!document.getElementById('messages-thread')) return;

        this.backBtn = document.getElementById('messages-back-btn');
        this.titleEl = document.getElementById('messages-popover-title');
        this.inboxView = document.getElementById('messages-inbox-view');
        this.conversationView = document.getElementById('messages-conversation-view');
        this.thread = document.getElementById('messages-thread');
        this.input = document.getElementById('messages-input');
        this.sendBtn = document.getElementById('messages-send-btn');
        this.unreadBadge = document.getElementById(badgeId);
        // Used only by _applyConversations() below to decide whether a live
        // re-render is worth doing right now — the host (SocialPanel.js, or
        // App.js for the chat-tab trial) owns actual visibility.
        this._sectionEl = this.thread.closest('.social-tab-panel');
        this._modalEl = document.getElementById('social-modal');
        this._isVisible = isVisible || (() => !!(this._sectionEl?.classList.contains('active') && !this._modalEl?.classList.contains('hidden')));

        this._conversations = []; // last fetched inbox, for cheap re-render on a poll tick
        this._activeUsername = null; // which conversation thread is open, if any
        this._lastThreadLength = -1; // message count last rendered into the open thread, see _pollActiveThread()
        this._conversationsLoaded = false; // see _applyConversations() — suppresses notify-on-first-fetch
        this._lastMessageSoundAt = -Infinity; // throttle, same 1.5s window as ChatUI.js's _playMessageSound()

        this._wireBack();
        this._wireSend();
        this._wireComposerExtras();
        document.addEventListener('peek:open-dm', (e) => this.openConversation(e.detail.username));
    }

    /**
     * "+" composer menu (code block / emoji), added 2026-09-09 so DMs get
     * the same composer affordances room chat has — see the file header's
     * "renders markdown when available" note for why the code-block button
     * specifically is hidden on a page that never loaded `hljs` (the lobby).
     * @returns {void}
     */
    _wireComposerExtras() {
        const plusBtn = document.getElementById('messages-composer-plus-btn');
        const plusMenu = document.getElementById('messages-composer-plus-menu');
        wireComposerPlusMenu(plusBtn, plusMenu);

        const codeBlockBtn = document.getElementById('messages-code-block-btn');
        if (typeof hljs === 'undefined') {
            // No vendor libs on this page (the lobby doesn't load them) —
            // a code fence would just render as literal backticks with
            // nothing to highlight it, so there's no point offering it.
            codeBlockBtn?.remove();
        } else {
            codeBlockBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                // Anchor to the persistent "+" trigger, not this button itself —
                // its own menu is already hidden by wireComposerPlusMenu's
                // close-on-option-click by the time this listener runs, same
                // reasoning as App.js's identical composer-emoji-btn handler.
                openCodeBlockPicker(plusBtn, (lang) => {
                    const start = this.input.selectionStart ?? this.input.value.length;
                    const end = this.input.selectionEnd ?? this.input.value.length;
                    const selected = this.input.value.slice(start, end);
                    const openFence = '```' + lang + '\n';
                    insertAtCaret(this.input, openFence + selected + '\n```');
                    if (!selected) {
                        const caret = start + openFence.length;
                        this.input.selectionStart = this.input.selectionEnd = caret;
                    }
                    // insertAtCaret mutates .value directly (no real 'input'
                    // event), so the auto-grow listener above never sees this.
                    autoGrowTextarea(this.input);
                    this.input.focus();
                });
            });
        }

        document.getElementById('messages-emoji-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openEmojiPicker(plusBtn, (emoji) => {
                insertAtCaret(this.input, emoji);
                this.input.focus();
            });
        });
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
                autoGrowTextarea(this.input); // back to single-row after a multi-line (e.g. code block) send
                await this._loadConversation(this._activeUsername);
            } catch {
                // offline — leave the typed text in place so nothing's lost
            } finally {
                this.sendBtn.disabled = false;
            }
        };
        this.sendBtn.addEventListener('click', submit);
        // Room composer parity (2026-09-09) — needed now that this composer
        // can hold real multi-line content (a code fence), not just a
        // one-line message.
        this.input.addEventListener('input', () => autoGrowTextarea(this.input));
        this.input.addEventListener('keydown', (e) => {
            // Shift+Enter always inserts a newline (default textarea behavior,
            // not intercepted); plain Enter mid-fence does too — see
            // composerUtils.js's isInsideOpenCodeFence for why this matters
            // now that the "Code block" +-menu option can put a real
            // multi-line fence in this composer.
            if (e.key !== 'Enter' || e.shiftKey) return;
            if (isInsideOpenCodeFence(this.input.value, this.input.selectionStart)) return;
            e.preventDefault();
            submit();
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
        // See file header: markdown when the vendor libs are loaded (the room
        // page always has them; the lobby never does), plain text otherwise.
        const canRenderMarkdown = typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined';
        for (const { body, fromMe } of messages) {
            const bubble = document.createElement('div');
            bubble.className = 'messages-bubble' + (fromMe ? ' messages-bubble-mine' : '');
            if (canRenderMarkdown) {
                const markdownEl = document.createElement('div');
                markdownEl.className = 'chat-markdown prose';
                markdownEl.innerHTML = DOMPurify.sanitize(marked.parse(body));
                bubble.appendChild(markdownEl);
                if (typeof hljs !== 'undefined') finalizeCodeBlocks(markdownEl);
            } else {
                bubble.textContent = body; // plain text only — see file header for why
            }
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
        const visible = this._isVisible();
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
        return this._isVisible() && this._activeUsername === username;
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
        // The badge showing/hiding/changing digit count can change how much
        // room the room's chat-tab-bar instance of this panel needs — no
        // direct reference to UIController.js from here, so a CustomEvent,
        // same shape as peek:account/peek:open-dm elsewhere in this app.
        document.dispatchEvent(new CustomEvent('peek:messages-badge-changed'));
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
