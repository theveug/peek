import { playSound } from './SoundPlayer.js';
import { escapeHtml } from './escapeHtml.js';
import { openEmojiPicker } from './EmojiPicker.js';

/**
 * Chat panel behavior: messages, typing indicators, reactions, polls,
 * grouped file-transfer messages, and inline system messages (join/leave/
 * room events). Owned and instantiated by `UIController`, which proxies
 * its public methods so other callers never need to know ChatUI exists
 * as a separate class.
 */
export class ChatUI {
    /**
     * @param {object} deps
     * @param {() => string} deps.getNickname - resolves a peerId to its current display nickname.
     * @param {(name: string) => string} [deps.avatarInitials] - derives avatar initials from a display name; defaults to just the first letter.
     * @param {() => string[]} [deps.getAllNicknames] - every current participant's nickname, used for @mention detection.
     * @param {() => boolean} [deps.isModerator] - whether the local user currently holds creator/moderator status; gates the per-message Pin button.
     * @param {(peerId: string) => string|null} [deps.getAvatar] - resolves a peerId to its validated
     *   custom-avatar data URL (from `UIController.peerAvatars`), or null/undefined for the
     *   initials fallback. Ends the chat-message-avatars scope cut noted in CLAUDE.md — callers
     *   now thread a peerId alongside the resolved nickname string wherever a message is added.
     */
    constructor({ getNickname, avatarInitials, getAllNicknames, isModerator, getAvatar }) {
        this._getNickname = getNickname;
        this._avatarInitials = avatarInitials || ((name) => name.charAt(0).toUpperCase());
        this._getAllNicknames = getAllNicknames || (() => []);
        this._isModerator = isModerator || (() => false);
        this._getAvatar = getAvatar || (() => null);
        this.maxMessages = 100;
        this._typingPeers = new Set();
        this._reactions = new Map();
        this._onReaction = null;
        this._replyTo = null;
        this._polls = new Map(); // keyed by peer-supplied pollId — Map, not {}, so a "__proto__" id can't poison lookups
        this.onPollVote = null;
        // messageId → { isSelf, rawText, sender, timestamp } for plain chat messages —
        // powers the Copy button (post-edit), inline editing, the self-only edit/delete
        // action-bar buttons, pin snapshots, and getMessageHistory()'s recap-export
        // transcript. Session-scoped, capped in addChatMessage. A Map, not {}, so
        // iteration order is insertion order (chronological) for free — overwriting an
        // existing key (an edit) doesn't move its position.
        this._messageMeta = new Map();
        this.onEditMessage = null;   // (messageId, newText) — wired to PeerManager.broadcastChatEdit
        this.onDeleteMessage = null; // (messageId) — wired to PeerManager.broadcastChatDelete
        // messageId → { sender, rawText, pinnedAt } — independent of _messageMeta's cap
        // and the DOM log's maxMessages cap, since a pin is meant to survive both.
        this._pinned = new Map();
        this._pinnedCap = 50;
        this.onPinMessage = null;   // (messageId) — wired to PeerManager.broadcastPin
        this.onUnpinMessage = null; // (messageId) — wired to PeerManager.broadcastUnpin
        this._wirePinnedPanel();
        this._wireSearchPanel();
    }

    /**
     * Wires the `#pinned-messages-btn` trigger open/close (static markup in
     * index.html, same click-outside/Escape convention as
     * App.js's composer-plus-menu). Self-contained inside ChatUI since it
     * owns all the pinned-message state; no App.js wiring needed.
     * @returns {void}
     */
    _wirePinnedPanel() {
        const btn = document.getElementById('pinned-messages-btn');
        const panel = document.getElementById('pinned-messages-panel');
        if (!btn || !panel) return;

        const close = () => panel.classList.add('hidden');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const opening = panel.classList.contains('hidden');
            this._closeSidePanels();
            if (opening) panel.classList.remove('hidden');
        });
        document.addEventListener('click', (e) => {
            if (panel.classList.contains('hidden')) return;
            if (panel.contains(e.target) || e.target === btn) return;
            close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !panel.classList.contains('hidden')) close();
        });
    }

    /**
     * Closes both `#pinned-messages-panel` and `#chat-search-panel` — the
     * two chat-tab-bar popovers share the same on-screen position
     * (`.pinned-panel`'s `top`/`right`), so opening one must close the
     * other rather than stacking on top of it.
     * @returns {void}
     */
    _closeSidePanels() {
        document.getElementById('pinned-messages-panel')?.classList.add('hidden');
        document.getElementById('chat-search-panel')?.classList.add('hidden');
    }

    /**
     * Wires the `#chat-search-btn` trigger open/close plus live filtering —
     * same open/close convention as `_wirePinnedPanel()` above. Purely
     * local: filters `_messageMeta` (already-retained chat history), no
     * broadcast, no server involvement.
     * @returns {void}
     */
    _wireSearchPanel() {
        const btn = document.getElementById('chat-search-btn');
        const panel = document.getElementById('chat-search-panel');
        const input = document.getElementById('chat-search-input');
        if (!btn || !panel || !input) return;

        const close = () => panel.classList.add('hidden');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const opening = panel.classList.contains('hidden');
            this._closeSidePanels();
            if (opening) {
                panel.classList.remove('hidden');
                input.focus();
                this._renderSearchResults(input.value);
            }
        });
        input.addEventListener('input', () => this._renderSearchResults(input.value));
        document.addEventListener('click', (e) => {
            if (panel.classList.contains('hidden')) return;
            if (panel.contains(e.target) || e.target === btn) return;
            close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !panel.classList.contains('hidden')) close();
        });
    }

    /**
     * Live-filters `_messageMeta` (case-insensitive substring on message
     * text) into `#chat-search-results` — re-run on every keystroke, cheap
     * since the dataset is capped at 300 messages. Each result scrolls to
     * and highlights the original via the same snippet `_wireReplyQuote()`/
     * `_renderPinnedPanel()` use.
     * @param {string} query
     * @returns {void}
     */
    _renderSearchResults(query) {
        const results = document.getElementById('chat-search-results');
        if (!results) return;
        results.innerHTML = '';

        const q = query.trim().toLowerCase();
        if (!q) {
            const hint = document.createElement('div');
            hint.className = 'pinned-panel-empty';
            hint.textContent = 'Type to search this session’s chat';
            results.appendChild(hint);
            return;
        }

        const matches = [...this._messageMeta.entries()]
            .filter(([, m]) => m.rawText.toLowerCase().includes(q))
            .reverse(); // most recent first, same convention as the pinned panel

        if (!matches.length) {
            const empty = document.createElement('div');
            empty.className = 'pinned-panel-empty';
            empty.textContent = 'No matching messages';
            results.appendChild(empty);
            return;
        }

        matches.forEach(([messageId, m]) => {
            const row = document.createElement('div');
            row.className = 'pinned-panel-row';

            const main = document.createElement('div');
            main.className = 'pinned-panel-row-main';
            const preview = m.rawText.length > 120 ? m.rawText.slice(0, 120) + '…' : m.rawText;
            main.innerHTML = `<span class="pinned-panel-sender">${escapeHtml(m.sender)}</span><span class="pinned-panel-preview">${escapeHtml(preview)}</span>`;
            main.addEventListener('click', () => {
                const target = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
                if (!target) return;
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                target.querySelector('.chat-message')?.classList.add('chat-message-highlight');
                setTimeout(() => target.querySelector('.chat-message')?.classList.remove('chat-message-highlight'), 1500);
            });
            row.appendChild(main);

            results.appendChild(row);
        });
    }

    /**
     * Shows/hides the "X is typing" indicator for a peer.
     * @param {string} peerId
     * @param {boolean} isTyping
     * @returns {void}
     */
    updateTypingIndicator(peerId, isTyping) {
        if (isTyping) {
            this._typingPeers.add(peerId);
        } else {
            this._typingPeers.delete(peerId);
        }
        this._renderTypingIndicator();
    }

    /** Repaints `#typing-indicator` from the current `_typingPeers` set. */
    _renderTypingIndicator() {
        const el = document.getElementById('typing-indicator');
        if (!el) return;
        const count = this._typingPeers.size;
        if (count === 0) {
            el.classList.add('hidden');
            return;
        }
        const names = [...this._typingPeers].map(id => escapeHtml(this._getNickname(id)));
        let text;
        if (count === 1) text = `${names[0]} is typing`;
        else if (count === 2) text = `${names[0]} and ${names[1]} are typing`;
        else text = 'Several people are typing';
        el.innerHTML = `<span class="typing-dots"><span>.</span><span>.</span><span>.</span></span> ${text}`;
        el.classList.remove('hidden');
    }

    /**
     * Begins composing a reply to an existing message — shows the reply
     * preview above the composer; the next `addChatMessage`/send picks this up.
     * @param {string} messageId
     * @param {string} sender
     * @param {string} text
     * @returns {void}
     */
    setReplyTo(messageId, sender, text) {
        this._replyTo = { messageId, sender, text };
        const preview = document.getElementById('reply-preview');
        if (!preview) return;
        const truncated = escapeHtml(text.length > 80 ? text.substring(0, 80) + '...' : text);
        preview.innerHTML = `<div class="reply-preview-content"><span class="reply-preview-sender">${escapeHtml(sender)}</span> <span class="reply-preview-text">${truncated}</span></div><button class="reply-preview-close">&times;</button>`;
        preview.classList.remove('hidden');
        preview.querySelector('.reply-preview-close').addEventListener('click', () => this.clearReply());
        document.getElementById('message')?.focus();
    }

    /** Cancels the in-progress reply and hides the reply preview. */
    clearReply() {
        this._replyTo = null;
        const preview = document.getElementById('reply-preview');
        if (preview) preview.classList.add('hidden');
    }

    /** @returns {{messageId: string, sender: string, text: string}|null} the pending reply target, if any. */
    getReplyTo() {
        return this._replyTo;
    }

    // --- Pending attachments (staged files awaiting an optional caption + Send,
    // rather than uploading the instant they're dropped/pasted/picked) ---

    _pendingFiles = [];

    /**
     * Stages files for sending (drag/drop/paste/pick) as removable chips in
     * the composer, rather than uploading immediately — actual sending
     * happens on the next `sendMessage`/`sendFilesWithCaption` call.
     * @param {File[]} files
     * @returns {void}
     */
    addPendingFiles(files) {
        for (const file of files) this._pendingFiles.push(file);
        this._renderPendingFiles();
        document.getElementById('message')?.focus();
    }

    /** @returns {File[]} files currently staged in the composer, awaiting Send. */
    getPendingFiles() {
        return this._pendingFiles;
    }

    /** Discards all staged attachments (called after a successful send). */
    clearPendingFiles() {
        this._pendingFiles = [];
        this._renderPendingFiles();
    }

    /** Removes one staged attachment by index (the chip's × button). */
    _removePendingFile(index) {
        this._pendingFiles.splice(index, 1);
        this._renderPendingFiles();
    }

    /** Repaints `#attachment-preview`'s chips from `_pendingFiles`. */
    _renderPendingFiles() {
        const preview = document.getElementById('attachment-preview');
        if (!preview) return;

        if (this._pendingFiles.length === 0) {
            preview.classList.add('hidden');
            preview.innerHTML = '';
            return;
        }

        preview.innerHTML = '';
        this._pendingFiles.forEach((file, index) => {
            const chip = document.createElement('div');
            chip.className = 'attachment-chip';

            if (/^image\//i.test(file.type)) {
                const img = document.createElement('img');
                img.src = URL.createObjectURL(file);
                img.alt = file.name;
                img.onload = () => URL.revokeObjectURL(img.src);
                chip.appendChild(img);
            } else {
                const icon = document.createElement('span');
                icon.className = 'attachment-chip-icon';
                icon.textContent = '\u{1F4CE}';
                chip.appendChild(icon);
            }

            const name = document.createElement('span');
            name.className = 'attachment-chip-name';
            name.textContent = file.name;
            chip.appendChild(name);

            const remove = document.createElement('button');
            remove.className = 'attachment-chip-remove';
            remove.type = 'button';
            remove.dataset.tip = 'Remove';
            remove.textContent = '×';
            remove.addEventListener('click', () => this._removePendingFile(index));
            chip.appendChild(remove);

            preview.appendChild(chip);
        });
        preview.classList.remove('hidden');
    }

    /**
     * Attaches the hover action bar (Copy + Reply + React, plus Edit + Delete
     * on the local user's own messages) to a rendered message element,
     * including the emoji picker popover's open/close/pick wiring.
     * @param {HTMLElement} msgEl
     * @param {string} messageId
     * @param {string} [rawText] - the original markdown source, for the Copy button.
     * @param {boolean} [isSelf=false] - adds the Edit/Delete buttons when true.
     * @returns {void}
     */
    _setupEmojiPicker(msgEl, messageId, rawText, isSelf = false) {
        const actionBar = document.createElement('div');
        actionBar.className = 'msg-action-bar';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'msg-action-btn';
        const copyIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5"><path fill-rule="evenodd" d="M13.887 3.182c.396.037.79.08 1.183.128C16.194 3.45 17 4.414 17 5.517V16.75A2.25 2.25 0 0 1 14.75 19h-9.5A2.25 2.25 0 0 1 3 16.75V5.517c0-1.103.806-2.068 1.93-2.207.393-.048.787-.09 1.183-.128A3.001 3.001 0 0 1 9 1h2c1.373 0 2.531.923 2.887 2.182ZM7.5 4A1.5 1.5 0 0 1 9 2.5h2A1.5 1.5 0 0 1 12.5 4v.5h-5V4Z" clip-rule="evenodd" /></svg>';
        copyBtn.innerHTML = copyIcon;
        copyBtn.dataset.tip = 'Copy message';
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Prefer the meta map over the captured rawText param — an edit
            // updates the map, while the closure would copy the stale original.
            let toCopy = (this._messageMeta.get(messageId)?.rawText ?? rawText ?? msgEl.querySelector('.chat-markdown')?.textContent ?? '').trim();
            // A message that is entirely one inline-code span (`token`) is almost
            // always a value meant for pasting into a field — unwrap the backticks.
            const inlineCode = toCopy.match(/^`([^`]+)`$/);
            if (inlineCode) toCopy = inlineCode[1].trim();
            navigator.clipboard.writeText(toCopy).then(() => {
                copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5"><path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clip-rule="evenodd" /></svg>';
                setTimeout(() => (copyBtn.innerHTML = copyIcon), 1500);
            });
        });
        actionBar.appendChild(copyBtn);

        const replyBtn = document.createElement('button');
        replyBtn.className = 'msg-action-btn';
        replyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5"><path fill-rule="evenodd" d="M7.793 2.232a.75.75 0 0 1-.025 1.06L3.622 7.25h10.003a5.375 5.375 0 0 1 0 10.75H10.75a.75.75 0 0 1 0-1.5h2.875a3.875 3.875 0 0 0 0-7.75H3.622l4.146 3.957a.75.75 0 0 1-1.036 1.085l-5.5-5.25a.75.75 0 0 1 0-1.085l5.5-5.25a.75.75 0 0 1 1.06.025Z" clip-rule="evenodd" /></svg>';
        replyBtn.dataset.tip = 'Reply';
        replyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const senderEl = msgEl.querySelector('.chat-sender');
            const bodyEl = msgEl.querySelector('.chat-markdown');
            const sender = senderEl ? senderEl.textContent : '?';
            const text = bodyEl ? bodyEl.textContent : '';
            this.setReplyTo(messageId, sender, text);
        });
        actionBar.appendChild(replyBtn);

        const btn = document.createElement('button');
        btn.className = 'msg-action-btn';
        btn.textContent = '😀';
        btn.dataset.tip = 'React';
        actionBar.appendChild(btn);

        if (this._isModerator()) {
            // A message's action bar is built exactly once, at addChatMessage
            // time — before it's possible for this messageId to already be
            // pinned (pinning requires this very button to exist first), so
            // there's no initial state to sync here. applyPin() below owns
            // updating this button's pinned/unpinned visual state from then
            // on, for both the local click path and a remote peer's pin.
            const pinBtn = document.createElement('button');
            pinBtn.className = 'msg-action-btn msg-action-pin-btn';
            pinBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5"><path fill-rule="evenodd" clip-rule="evenodd" d="M10 2C8.28365 2 6.5916 2.10551 4.93005 2.31046C3.80579 2.44913 3 3.41374 3 4.51661V17.25C3 17.5078 3.13239 17.7475 3.35057 17.8848C3.56875 18.0221 3.84215 18.0377 4.07455 17.9261L10 15.0819L15.9255 17.9261C16.1578 18.0377 16.4312 18.0221 16.6494 17.8848C16.8676 17.7475 17 17.5078 17 17.25V4.51661C17 3.41374 16.1942 2.44913 15.07 2.31046C13.4084 2.10551 11.7163 2 10 2Z" /></svg>';
            pinBtn.dataset.tip = 'Pin message';
            pinBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const pinned = this._pinned.has(messageId);
                this.applyPin(messageId, !pinned);
                if (pinned) this.onUnpinMessage?.(messageId);
                else this.onPinMessage?.(messageId);
            });
            actionBar.appendChild(pinBtn);
        }

        if (isSelf) {
            const editBtn = document.createElement('button');
            editBtn.className = 'msg-action-btn';
            editBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5"><path d="m5.433 13.917 1.262-3.155A4 4 0 0 1 7.58 9.42l6.92-6.918a2.121 2.121 0 0 1 3 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 0 1-.65-.65Z" /><path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0 0 10 3H4.75A2.75 2.75 0 0 0 2 5.75v9.5A2.75 2.75 0 0 0 4.75 18h9.5A2.75 2.75 0 0 0 17 15.25V10a.75.75 0 0 0-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5Z" /></svg>';
            editBtn.dataset.tip = 'Edit';
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._beginEdit(messageId);
            });
            actionBar.appendChild(editBtn);

            // Two-step delete: first click arms the button for 3s (tooltip
            // live-updates via Tooltip.js), second click actually deletes —
            // same in-app confirm pattern as Settings' "Clear all local data".
            const delBtn = document.createElement('button');
            delBtn.className = 'msg-action-btn msg-action-danger';
            delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5"><path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clip-rule="evenodd" /></svg>';
            delBtn.dataset.tip = 'Delete';
            let armTimer = 0;
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!delBtn.classList.contains('is-armed')) {
                    delBtn.classList.add('is-armed');
                    delBtn.dataset.tip = 'Click again to delete';
                    armTimer = setTimeout(() => {
                        delBtn.classList.remove('is-armed');
                        delBtn.dataset.tip = 'Delete';
                    }, 3000);
                    return;
                }
                clearTimeout(armTimer);
                this.applyChatDelete(messageId);
                this.onDeleteMessage?.(messageId);
            });
            actionBar.appendChild(delBtn);
        }

        msgEl.appendChild(actionBar);

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openEmojiPicker(btn, (emoji) => {
                if (this._onReaction) this._onReaction(messageId, emoji);
            });
        });
    }

    /**
     * Toggles one peer's reaction to a message on/off and repaints that
     * message's reaction badges.
     * @param {string} messageId
     * @param {string} emoji
     * @param {string} nickname - unused today, kept for call-site symmetry with other broadcasts.
     * @param {string} fromPeerId - the reacting peer's ID (toggle key).
     * @returns {void}
     */
    addReaction(messageId, emoji, nickname, fromPeerId) {
        const msgEl = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
        if (!msgEl) return;
        const bar = msgEl.querySelector('.reaction-bar');
        if (!bar) return;

        if (!this._reactions.has(messageId)) this._reactions.set(messageId, new Map());
        const msgReactions = this._reactions.get(messageId);
        // Cap distinct reactions per message — a modified client could otherwise
        // grow this map (and the badge bar) without bound. Toggling an existing
        // reaction is always allowed; only NEW emoji keys are capped.
        if (!msgReactions.has(emoji) && msgReactions.size >= 20) return;
        if (!msgReactions.has(emoji)) msgReactions.set(emoji, new Set());
        const reactors = msgReactions.get(emoji);

        if (reactors.has(fromPeerId)) {
            reactors.delete(fromPeerId);
            if (reactors.size === 0) msgReactions.delete(emoji);
        } else {
            reactors.add(fromPeerId);
        }

        this._renderReactionBar(bar, messageId);
    }

    /** Repaints one message's reaction-badge bar from `_reactions`. */
    _renderReactionBar(bar, messageId) {
        bar.innerHTML = '';
        const msgReactions = this._reactions.get(messageId);
        if (!msgReactions) return;
        msgReactions.forEach((reactors, emoji) => {
            if (reactors.size === 0) return;
            const badge = document.createElement('button');
            badge.className = 'reaction-badge';
            badge.textContent = `${emoji} ${reactors.size}`;
            badge.addEventListener('click', () => {
                if (this._onReaction) this._onReaction(messageId, emoji);
            });
            bar.appendChild(badge);
        });
    }

    // --- Polls ---

    /**
     * Renders a new poll card in the chat log and registers its local vote
     * tally in `_polls`, keyed by the peer-supplied `pollId`.
     * @param {string} sender
     * @param {string} pollId
     * @param {string} question
     * @param {string[]} options
     * @param {string} myPeerId - the local peer's ID, so this poll's future
     *   `updatePollVote` calls know which vote is "mine" for the checkmark/disabled state.
     * @param {boolean} [isSelf=false] - passed explicitly by the caller (true only for the
     *   local echo) — don't infer it from `sender`, or a remote peer who sets their
     *   nickname to match the local user's own would render as self.
     * @param {string|null} [senderPeerId=null] - the poll creator's peerId, for avatar lookup —
     *   a separate concept from `myPeerId` above (which is always *our own* peerId, for vote
     *   tracking, even on a poll someone else created).
     * @returns {void}
     */
    addPollMessage(sender, pollId, question, options, myPeerId, isSelf = false, senderPeerId = null) {
        const chatLog = document.getElementById('chat-log');
        const initial = sender.charAt(0).toUpperCase();
        const color = isSelf ? '#22c55e' : this._colorForName(sender);
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        this._polls.set(pollId, {
            sender, question, options, myPeerId, myVote: null,
            votes: Object.fromEntries(options.map((_, i) => [i, new Set()])),
        });

        const container = document.createElement('div');
        container.dataset.pollId = pollId;
        container.innerHTML = `<div class="chat-message px-4 py-2 text-sm"><div class="flex items-center gap-2 mb-2">${this._avatarHtml(senderPeerId, initial, color)}<span class="chat-sender font-medium text-xs" style="color:${color}">${escapeHtml(sender)}</span><span class="poll-badge px-1.5 py-0.5 rounded-full font-medium leading-none">Poll</span><span class="chat-timestamp text-[10px] ml-auto shrink-0">${timestamp}</span></div><div class="ml-7"><div class="font-medium mb-3">${escapeHtml(question)}</div><div class="poll-options flex flex-col gap-2"></div><div class="poll-footer text-[10px] text-muted mt-2">0 votes</div></div></div>`;

        this._renderPollOptions(container, pollId);
        chatLog.appendChild(container);
        while (chatLog.children.length > this.maxMessages) chatLog.removeChild(chatLog.firstChild);
        requestAnimationFrame(() => chatLog.scrollTo({ top: chatLog.scrollHeight, behavior: 'smooth' }));
    }

    /**
     * Records (or re-records, replacing any prior vote from the same voter)
     * one peer's poll vote and repaints that poll's option bars.
     * @param {string} pollId
     * @param {number} optionIndex - peer-supplied; bounds-checked against the poll's real option count before use.
     * @param {string} voterId
     * @returns {void}
     */
    updatePollVote(pollId, optionIndex, voterId) {
        const poll = this._polls.get(pollId);
        if (!poll) return;
        // optionIndex is peer-supplied — reject anything that isn't a real option
        // slot before using it to index into poll.votes.
        if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) return;
        for (const set of Object.values(poll.votes)) set.delete(voterId);
        if (poll.votes[optionIndex]) poll.votes[optionIndex].add(voterId);
        if (voterId === poll.myPeerId) poll.myVote = optionIndex;
        const container = document.querySelector(`[data-poll-id="${CSS.escape(pollId)}"]`);
        if (container) this._renderPollOptions(container, pollId);
    }

    /** Repaints one poll's option bars (vote counts, fill %, my-vote checkmark) from `_polls`. */
    _renderPollOptions(container, pollId) {
        const poll = this._polls.get(pollId);
        if (!poll) return;
        const optionsEl = container.querySelector('.poll-options');
        const footerEl = container.querySelector('.poll-footer');
        if (!optionsEl) return;

        const totalVotes = Object.values(poll.votes).reduce((s, set) => s + set.size, 0);
        const hasVoted = poll.myVote !== null;

        optionsEl.innerHTML = '';
        poll.options.forEach((option, i) => {
            const count = poll.votes[i]?.size || 0;
            const pct = totalVotes > 0 ? count / totalVotes : 0;
            const isMyVote = poll.myVote === i;

            const btn = document.createElement('button');
            btn.className = `poll-option relative flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-left w-full overflow-hidden border transition-colors ${isMyVote ? 'poll-option-voted' : ''} ${hasVoted ? 'cursor-default' : 'poll-option-hoverable'}`;
            btn.disabled = hasVoted;
            btn.innerHTML = `<div class="poll-option-fill absolute inset-0 origin-left transition-transform duration-500" style="transform:scaleX(${pct})"></div><span class="relative z-10 flex-1">${escapeHtml(option)}${isMyVote ? ' <span class="poll-option-check">✓</span>' : ''}</span><span class="relative z-10 text-[10px] text-muted">${count} ${count === 1 ? 'vote' : 'votes'}</span>`;

            if (!hasVoted) {
                btn.addEventListener('click', () => {
                    if (this.onPollVote) this.onPollVote(pollId, i);
                });
            }
            optionsEl.appendChild(btn);
        });

        if (footerEl) footerEl.textContent = `${totalVotes} ${totalVotes === 1 ? 'vote' : 'votes'}`;
    }

    /**
     * Read-only poll summary list for session-recap export's "Polls"
     * section — each poll's question, its options with vote tallies, and
     * resolved voter nicknames (via `getNickname()`, same shortened-peerId
     * fallback as everywhere else for a voter who has since left).
     * @returns {{sender: string, question: string, totalVotes: number, options: {text: string, count: number, voters: string[]}[]}[]}
     */
    getPollSummaries() {
        return [...this._polls.values()].map(({ sender, question, options, votes }) => {
            const opts = options.map((text, i) => {
                const voterIds = [...(votes[i] || [])];
                return { text, count: voterIds.length, voters: voterIds.map(id => this._getNickname(id)) };
            });
            return { sender, question, options: opts, totalVotes: opts.reduce((s, o) => s + o.count, 0) };
        });
    }

    /**
     * True when the chat panel isn't actually on screen for the local user —
     * either collapsed via its tab (desktop) or the mobile drawer is closed.
     * @returns {boolean}
     */
    _isChatViewClosed() {
        const chatPanel = document.getElementById('chat');
        if (!chatPanel) return false;
        if (window.innerWidth < 768) return !chatPanel.classList.contains('mobile-open');
        return chatPanel.classList.contains('hidden');
    }

    /** @param {number} bytes @returns {string} human-readable size, e.g. "1.2 MB". */
    _formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }

    // --- Grouped file messages (caption + one or more attached files as one
    // bubble, Discord-style) ---
    //
    // One groupId (generated once per Send action — see PeerManager.sendFilesWithCaption)
    // covers 1+ files that each still negotiate their own independent offer/accept/
    // transfer over the wire (an AFK peer on one file must never block another) —
    // ensureFileGroup() just gives them one shared header+caption bubble to render
    // into, keyed by groupId, with a slot per fileId that starts as an offer prompt
    // or progress bar and ends up replaced by the finished file card in place.
    _fileGroups = {};

    /**
     * Creates the shared header+caption bubble for a batch of files, if it
     * doesn't already exist. Idempotent: only the first file-offer (or the
     * sender's own first file) for a given groupId actually creates the
     * bubble; later files in the same batch find it already there and just
     * add their own slot via `_fileSlot`.
     * @param {string} sender
     * @param {{groupId: string, caption: string|null, replyTo: object|null, messageId: string|null}} groupInfo
     * @param {boolean} [isSelf=false] - passed explicitly by the caller (true only for the
     *     local echo) — don't infer it from `sender`, or a remote peer who sets their
     *     nickname to match the local user's own would render with the local user's own
     *     self-styling and suppress the unread notification. Same rule as addChatMessage.
     * @param {string|null} [senderPeerId=null] - for avatar lookup, see `addChatMessage`.
     * @returns {void}
     */
    ensureFileGroup(sender, groupInfo, isSelf = false, senderPeerId = null) {
        const { groupId, caption, replyTo, messageId } = groupInfo;
        if (this._fileGroups[groupId]) return;

        const chatLog = document.getElementById('chat-log');
        const msgContainer = document.createElement('div');
        if (messageId) msgContainer.dataset.messageId = messageId;
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const initial = this._avatarInitials(sender);
        const color = isSelf ? '#22c55e' : this._colorForName(sender);

        const replyHtml = this._replyQuoteHtml(replyTo);
        // Same markdown pipeline as a plain chat message — a caption is peer-controlled
        // text just like any other, so it gets the identical marked+DOMPurify treatment.
        const captionHtml = caption
            ? `<div class="chat-markdown chat-body prose ml-7">${DOMPurify.sanitize(marked.parse(caption))}</div>`
            : '';
        // Reactions/reply-quoting only make sense when there's an actual caption to
        // react to or quote — a files-only group matches plain file messages'
        // existing lack of either, not a new gap.
        const reactionBarHtml = caption ? '<div class="reaction-bar ml-7"></div>' : '';

        msgContainer.innerHTML = `<div class="chat-message px-4 py-2 text-sm"><div class="flex items-center gap-2 mb-0.5">${this._avatarHtml(senderPeerId, initial, color)}<span class="chat-sender font-medium text-xs" style="color:${color}">${escapeHtml(sender)}</span><span class="chat-timestamp text-[10px] ml-auto shrink-0">${timestamp}</span></div>${replyHtml}${captionHtml}<div class="chat-file-group ml-7"></div>${reactionBarHtml}</div>`;

        this._wireReplyQuote(msgContainer);
        let mentionedMe = false;
        if (caption) {
            mentionedMe = this._finalizeMarkdownBody(msgContainer);
            if (messageId) this._setupEmojiPicker(msgContainer.querySelector('.chat-message'), messageId, caption);
        }

        chatLog.appendChild(msgContainer);
        while (chatLog.children.length > this.maxMessages) {
            chatLog.removeChild(chatLog.firstChild);
        }
        this._scrollIfAtBottom(chatLog);

        this._fileGroups[groupId] = { el: msgContainer, slotsEl: msgContainer.querySelector('.chat-file-group') };

        if (mentionedMe && !isSelf) {
            msgContainer.querySelector('.chat-message')?.classList.add('chat-message-mentioned');
        }

        // A caption is real message content arriving now — notify like any other
        // chat message. A files-only group (no caption) keeps the existing
        // file-offer behavior of staying silent until a transfer actually completes.
        if (caption) {
            if (!isSelf && (!document.hasFocus() || this._isChatViewClosed())) {
                if (mentionedMe) this._notifyMention();
                else {
                    document.getElementById('new-message-indicator')?.classList.remove('hidden');
                    this._playMessageSound();
                }
            } else if (isSelf) {
                document.getElementById('new-message-indicator')?.classList.add('hidden');
            }
        }
    }

    /**
     * Gets (creating if needed) one file's slot within its group bubble.
     * Each file within a group gets its own slot: a content area (offer prompt →
     * cleared on accept/decline → final file card) and a separate progress area, so
     * an upload/download progress bar can appear and disappear without ever
     * clobbering a content area that (for the sender's own instant local echo) may
     * already hold the finished file card.
     * @param {string} groupId
     * @param {string} fileId
     * @returns {HTMLElement|null} the slot element, or null if the group doesn't exist.
     */
    _fileSlot(groupId, fileId) {
        const group = this._fileGroups[groupId];
        if (!group) return null;
        let slot = group.slotsEl.querySelector(`[data-file-id="${CSS.escape(fileId)}"]`);
        if (!slot) {
            slot = document.createElement('div');
            slot.className = 'chat-file-slot';
            slot.dataset.fileId = fileId;
            slot.innerHTML = '<div class="chat-file-slot-content"></div><div class="chat-file-slot-progress"></div>';
            group.slotsEl.appendChild(slot);
        }
        return slot;
    }

    /**
     * Renders an inline Accept/Decline prompt for an incoming file offer
     * into its slot.
     * @param {string} sender
     * @param {string} fileId
     * @param {string} fileName
     * @param {number} fileSize
     * @param {() => void} onAccept
     * @param {() => void} onDecline
     * @param {string} groupId
     * @returns {void}
     */
    showFileOffer(sender, fileId, fileName, fileSize, onAccept, onDecline, groupId) {
        const slot = this._fileSlot(groupId, fileId);
        if (!slot) return;
        const content = slot.querySelector('.chat-file-slot-content');
        const sizeStr = this._formatFileSize(fileSize);
        content.innerHTML = `<div class="file-offer"><div class="file-offer-info">Wants to send <span class="file-offer-name">${escapeHtml(fileName)}</span> <span class="file-offer-size">(${sizeStr})</span></div><div class="file-offer-actions"><button type="button" class="file-offer-accept">Accept</button><button type="button" class="file-offer-decline">Decline</button></div></div>`;
        this._scrollIfAtBottom(document.getElementById('chat-log'));

        content.querySelector('.file-offer-accept').addEventListener('click', () => {
            content.innerHTML = '';
            onAccept();
        });
        content.querySelector('.file-offer-decline').addEventListener('click', () => {
            content.innerHTML = '<span class="file-offer-declined">Declined</span>';
            onDecline();
        });
    }

    /**
     * Updates (creating on first call) a file's upload/download progress bar.
     * @param {string} fileId
     * @param {number} progress - 0-1 fraction complete.
     * @param {'upload'|'download'} direction
     * @param {string} fileName
     * @param {string} groupId
     * @returns {void}
     */
    updateFileProgress(fileId, progress, direction, fileName, groupId) {
        const slot = this._fileSlot(groupId, fileId);
        if (!slot) return;
        const progressEl = slot.querySelector('.chat-file-slot-progress');
        let fill = progressEl.querySelector('.file-progress-fill');
        if (!fill) {
            const label = direction === 'upload' ? 'Sending' : 'Receiving';
            progressEl.innerHTML = `<div class="file-progress"><span class="file-progress-label">${label}: ${escapeHtml(fileName)}</span><div class="file-progress-track"><div class="file-progress-fill"></div></div></div>`;
            fill = progressEl.querySelector('.file-progress-fill');
            this._scrollIfAtBottom(document.getElementById('chat-log'));
        }
        fill.style.width = (progress * 100) + '%';
    }

    /** Clears a file's progress bar (transfer finished, declined, or timed out). */
    removeFileProgress(fileId, groupId) {
        const slot = this._fileSlot(groupId, fileId);
        if (!slot) return;
        slot.querySelector('.chat-file-slot-progress').innerHTML = '';
    }

    _systemIcons = {
        join: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5"><path d="M10 2a.75.75 0 0 1 .75.75v5.59l1.95-2.1a.75.75 0 1 1 1.1 1.02l-3.25 3.5a.75.75 0 0 1-1.1 0L6.2 7.26a.75.75 0 1 1 1.1-1.02l1.95 2.1V2.75A.75.75 0 0 1 10 2Z" /><path d="M5.273 4.5a1.25 1.25 0 0 0-1.205.918l-1.523 5.52c-.006.02-.01.041-.015.062H6a1 1 0 0 1 .894.553l.448.894a1 1 0 0 0 .894.553h3.438a1 1 0 0 0 .86-.49l.606-1.02A1 1 0 0 1 14 11h3.47a1.318 1.318 0 0 0-.015-.062l-1.523-5.52a1.25 1.25 0 0 0-1.205-.918h-9.454Z" /></svg>',
        leave: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5"><path fill-rule="evenodd" d="M3 4.25A2.25 2.25 0 0 1 5.25 2h5.5A2.25 2.25 0 0 1 13 4.25v2a.75.75 0 0 1-1.5 0v-2a.75.75 0 0 0-.75-.75h-5.5a.75.75 0 0 0-.75.75v11.5c0 .414.336.75.75.75h5.5a.75.75 0 0 0 .75-.75v-2a.75.75 0 0 1 1.5 0v2A2.25 2.25 0 0 1 10.75 18h-5.5A2.25 2.25 0 0 1 3 15.75V4.25Z" clip-rule="evenodd" /><path fill-rule="evenodd" d="M19 10a.75.75 0 0 0-.75-.75H8.704l1.048-.943a.75.75 0 1 0-1.004-1.114l-2.5 2.25a.75.75 0 0 0 0 1.114l2.5 2.25a.75.75 0 1 0 1.004-1.114l-1.048-.943h9.546A.75.75 0 0 0 19 10Z" clip-rule="evenodd" /></svg>',
        stream: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5"><path d="M1 4.75C1 3.784 1.784 3 2.75 3h14.5c.966 0 1.75.784 1.75 1.75v10.515a1.75 1.75 0 0 1-1.75 1.75h-1.5v-1.5h1.5a.25.25 0 0 0 .25-.25V4.75a.25.25 0 0 0-.25-.25H2.75a.25.25 0 0 0-.25.25v10.515c0 .138.112.25.25.25h1.5v1.5h-1.5A1.75 1.75 0 0 1 1 15.265V4.75Z" /><path d="M10 7.292a.625.625 0 0 1 .625.625v1.958h1.958a.625.625 0 1 1 0 1.25h-1.958v1.958a.625.625 0 1 1-1.25 0v-1.958H7.417a.625.625 0 1 1 0-1.25h1.958V7.917A.625.625 0 0 1 10 7.292Z" /></svg>',
        info: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5"><path fill-rule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a.75.75 0 0 0 0 1.5h.253a.25.25 0 0 1 .244.304l-.459 2.066A1.75 1.75 0 0 0 10.747 15H11a.75.75 0 0 0 0-1.5h-.253a.25.25 0 0 1-.244-.304l.459-2.066A1.75 1.75 0 0 0 9.253 9H9Z" clip-rule="evenodd" /></svg>',
    };

    /**
     * Renders a room event (join/leave, moderator action, quality change, blocked
     * file, etc.) as a centered pill inline in the log, Discord-style, instead of
     * a toast overlay — so it's visible in scrollback and even if the chat panel
     * was closed when it happened, not just for the 4s a toast is on screen.
     * @param {string} text
     * @param {'join'|'leave'|'stream'|'info'} [type='info'] - only picks the icon+accent color.
     * @returns {void}
     */
    addSystemMessage(text, type = 'info') {
        const chatLog = document.getElementById('chat-log');
        const el = document.createElement('div');
        el.className = 'chat-system-message';
        el.innerHTML = `<span class="chat-system-pill chat-system-${type}"><span class="chat-system-icon">${this._systemIcons[type] || this._systemIcons.info}</span><span>${escapeHtml(text)}</span></span>`;
        chatLog.appendChild(el);

        while (chatLog.children.length > this.maxMessages) {
            chatLog.removeChild(chatLog.firstChild);
        }

        requestAnimationFrame(() => chatLog.scrollTo({ top: chatLog.scrollHeight, behavior: 'smooth' }));

        if (!document.hasFocus() || this._isChatViewClosed()) {
            const indicator = document.getElementById('new-message-indicator');
            if (indicator) indicator.classList.remove('hidden');
        }
    }

    /**
     * Renders a finished file transfer (image preview or download card)
     * into its slot.
     * @param {string} sender
     * @param {string} fileId
     * @param {string} fileName
     * @param {number} fileSize
     * @param {string} fileType - derived from the file extension, not trusted from the peer (see the file-transfer trust-boundary note in CLAUDE.md).
     * @param {string} blobUrl
     * @param {string} groupId
     * @param {boolean} [isSelf=false] - passed explicitly by the caller (true only for the
     *     local echo) — don't infer it from `sender`, or a remote peer who sets their
     *     nickname to match the local user's own would render as self.
     * @returns {void}
     */
    addFileMessage(sender, fileId, fileName, fileSize, fileType, blobUrl, groupId, isSelf = false) {
        const slot = this._fileSlot(groupId, fileId);
        if (!slot) return;
        const content = slot.querySelector('.chat-file-slot-content');

        const sizeStr = this._formatFileSize(fileSize);
        const isImage = /^image\//i.test(fileType);
        const safeFileName = escapeHtml(fileName);

        if (isImage) {
            content.innerHTML = `<div class="chat-image-preview"><img src="${blobUrl}" alt="${safeFileName}" /><a href="${blobUrl}" download="${safeFileName}" class="file-card-download chat-image-download" data-tip="Download">&#x2B73;</a></div>`;
            content.querySelector('.chat-image-preview img').addEventListener('click', () => {
                this.openImageLightbox(blobUrl, fileName);
            });
        } else {
            content.innerHTML = `<div class="file-card"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5 text-muted"><path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l4.122 4.12A1.5 1.5 0 0 1 17 7.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" /></svg><div class="file-card-info"><span class="file-card-name">${safeFileName}</span><span class="file-card-size">${sizeStr}</span></div><a href="${blobUrl}" download="${safeFileName}" class="file-card-download" data-tip="Download">&#x2B73;</a></div>`;
        }

        this._scrollIfAtBottom(document.getElementById('chat-log'));

        if (!isSelf && (!document.hasFocus() || this._isChatViewClosed())) {
            document.getElementById('new-message-indicator')?.classList.remove('hidden');
            this._playMessageSound();
        }
    }

    // A caption + its file (or a multi-file drop) arrive as separate messages
    // back to back — without this cooldown each one queues its own newMessage
    // sound. Sliding window: the timestamp updates even when the sound is
    // skipped, so a continuous burst pings once, not once per 1.5s.
    _lastMessageSoundAt = -Infinity;

    /** Plays the new-message sound, throttled to once per 1.5s. */
    _playMessageSound() {
        const now = Date.now();
        if (now - this._lastMessageSoundAt > 1500) playSound('newMessage');
        this._lastMessageSoundAt = now;
    }

    /**
     * The unseen-only half of mention handling: a separate `#mention-indicator`
     * badge + sound (not just the general `#new-message-indicator` dot), so a
     * mention doesn't get lost among ordinary unread messages in a busy room.
     * The persistent bubble highlight itself (`.chat-message-mentioned`) is
     * applied unconditionally by the caller whenever mentioned — like
     * Discord, that stays visible even if you already saw it — only this
     * badge+sound part is gated on "not already seen".
     * @returns {void}
     */
    _notifyMention() {
        document.getElementById('mention-indicator')?.classList.remove('hidden');
        this._playMessageSound();
    }

    _imageUrlPattern = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?.*)?$/i;

    /**
     * Lazily builds the singleton `#chat-lightbox` overlay (same one-popover-
     * reused pattern as `Tooltip.js`/`EmojiPicker.js`), wiring backdrop-click,
     * the close button, and Escape to dismiss. Not built until the first
     * image is actually clicked, so a session that never opens one costs
     * nothing extra.
     * @returns {HTMLElement}
     */
    _ensureLightbox() {
        let el = document.getElementById('chat-lightbox');
        if (el) return el;

        el = document.createElement('div');
        el.id = 'chat-lightbox';
        el.className = 'chat-lightbox';
        el.innerHTML = `<div class="chat-lightbox-backdrop"></div><div class="chat-lightbox-content"><div class="chat-lightbox-actions"><a class="chat-lightbox-action" data-tip="Open in new tab" target="_blank" rel="noopener"><span class="material-symbols-rounded">open_in_new</span></a><a class="chat-lightbox-action" data-tip="Download"><span class="material-symbols-rounded">download</span></a><button type="button" class="chat-lightbox-action" data-tip="Close"><span class="material-symbols-rounded">close</span></button></div><img class="chat-lightbox-img" src="" alt="" /></div>`;
        document.body.appendChild(el);

        const close = () => { el.style.display = 'none'; };
        el.querySelector('.chat-lightbox-backdrop').addEventListener('click', close);
        el.querySelector('button.chat-lightbox-action').addEventListener('click', close);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && el.style.display !== 'none') close();
        });
        return el;
    }

    /**
     * Opens a chat image full-size in the lightbox overlay, in front of
     * whatever "open in a new tab" would have done directly — the overlay's
     * own action bar still offers a real "open in new tab" (and download)
     * for anyone who wants that. Used for both file-attachment images and
     * inline link-preview image thumbnails.
     * @param {string} src - a `blob:` URL (attachment) or an arbitrary peer-supplied
     *   image URL (link preview) — either is safe to use directly as an `<img src>`/
     *   link `href`, same as the existing inline preview already did.
     * @param {string} [downloadName] - suggested filename for the overlay's download
     *   action; omitted for link-preview images (no known filename).
     * @returns {void}
     */
    openImageLightbox(src, downloadName) {
        const el = this._ensureLightbox();
        el.querySelector('.chat-lightbox-img').src = src;
        const [newTabLink, downloadLink] = el.querySelectorAll('a.chat-lightbox-action');
        newTabLink.href = src;
        downloadLink.href = src;
        downloadLink.download = downloadName || '';
        el.style.display = 'flex';
    }

    /**
     * Expands links in a rendered message body: image URLs get an inline
     * preview thumbnail (capped at 5 per message), other links get a
     * hostname badge. Also forces `target="_blank" rel="noopener noreferrer"`
     * on every link.
     * @param {HTMLElement} container
     * @returns {void}
     */
    _processLinkPreviews(container) {
        const links = container.querySelectorAll('.chat-markdown a[href]');
        let imageCount = 0;
        links.forEach(a => {
            const href = a.getAttribute('href');
            if (!href || href.startsWith('javascript:')) return;

            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');

            if (this._imageUrlPattern.test(href) && imageCount < 5) {
                imageCount++;
                const preview = document.createElement('div');
                preview.className = 'chat-image-preview';
                const img = document.createElement('img');
                img.src = href;
                img.loading = 'lazy';
                img.alt = 'Image preview';
                img.addEventListener('click', () => this.openImageLightbox(href));
                img.addEventListener('error', () => preview.remove());
                preview.appendChild(img);
                const body = container.querySelector('.chat-markdown');
                if (body) body.appendChild(preview);
            } else if (!this._imageUrlPattern.test(href)) {
                a.classList.add('link-preview');
                try {
                    const host = new URL(href).hostname;
                    const hostLabel = document.createElement('span');
                    hostLabel.className = 'link-host';
                    hostLabel.textContent = host;
                    a.appendChild(hostLabel);
                } catch {}
            }
        });
    }

    _chatAvatarColors = [
        '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e',
        '#f97316', '#eab308', '#22c55e', '#14b8a6',
        '#06b6d4', '#3b82f6', '#a855f7', '#e11d48',
    ];

    /** @param {string} name @returns {string} a deterministic avatar color hashed from the name. */
    _colorForName(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        return this._chatAvatarColors[Math.abs(hash) % this._chatAvatarColors.length];
    }

    /**
     * Builds the `.chat-avatar` HTML for a message header — a custom avatar
     * image when `getAvatar(peerId)` resolves one (already validated by
     * `PeerManager._isValidAvatarDataUrl` before it ever reaches
     * `UIController.peerAvatars`, same trust level as the participant-card/
     * top-bar-pill avatars that already interpolate it this way), otherwise
     * the existing initials-on-color-square fallback. `peerId` is optional —
     * omitted for contexts that never had one plumbed through (e.g. a poll's
     * own vote-tracking `myPeerId` is a different concept than the poll
     * creator's peerId), in which case this is just the old initials look.
     * The image variant deliberately has no `background` — some custom
     * avatars are uploaded with a transparent background specifically so a
     * non-square logo/shape shows through as its own silhouette (same
     * `UIController._renderAvatarInto()` convention for participant
     * cards/the top-bar pill), which a solid color square behind it would
     * otherwise defeat.
     * @param {string|null|undefined} peerId
     * @param {string} initial
     * @param {string} color
     * @returns {string}
     */
    _avatarHtml(peerId, initial, color) {
        const avatarUrl = peerId ? this._getAvatar(peerId) : null;
        return avatarUrl
            ? `<span class="chat-avatar"><img class="avatar-img" src="${avatarUrl}" alt="" /></span>`
            : `<span class="chat-avatar" style="background:${color}">${escapeHtml(initial)}</span>`;
    }

    /**
     * Renders a plain chat message (markdown, sanitized) into the log.
     * isSelf is passed explicitly by the caller (true only for the local echo) —
     * don't infer it from `sender`, or a remote peer who sets their nickname to
     * match the local user's own would render with the local user's own self-styling.
     * @param {string} sender
     * @param {string} text - raw markdown; sanitized here via marked + DOMPurify before insertion.
     * @param {string} [messageId] - generated if omitted.
     * @param {{messageId: string, sender: string, text: string}|null} [replyData]
     * @param {boolean} [isSelf=false]
     * @param {string|null} [senderPeerId=null] - for avatar lookup — the message author's
     *   peerId (or the local user's own peerId for the self echo), separate from the resolved
     *   nickname string in `sender`. See `ChatUI` constructor's `getAvatar` dep.
     * @returns {void}
     */
    addChatMessage(sender, text, messageId, replyData, isSelf = false, senderPeerId = null) {
        const chatLog = document.getElementById('chat-log');
        const msgContainer = document.createElement('div');
        if (!messageId) messageId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
        msgContainer.dataset.messageId = messageId;

        const raw = DOMPurify.sanitize(marked.parse(text));
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const initial = this._avatarInitials(sender);
        const color = isSelf ? '#22c55e' : this._colorForName(sender);
        const replyHtml = this._replyQuoteHtml(replyData);

        msgContainer.innerHTML = `<div class="chat-message px-4 py-2 text-sm"><div class="flex items-center gap-2 mb-0.5">${this._avatarHtml(senderPeerId, initial, color)}<span class="chat-sender font-medium text-xs" style="color:${color}">${escapeHtml(sender)}</span><span class="chat-timestamp text-[10px] ml-auto shrink-0">${timestamp}</span></div>${replyHtml}<div class="chat-markdown chat-body prose ml-7">${raw}</div><div class="reaction-bar ml-7"></div></div>`;

        this._wireReplyQuote(msgContainer);

        const msg = msgContainer.querySelector('.chat-message');
        this._messageMeta.set(messageId, { isSelf, rawText: text, sender, timestamp });
        // Cap independently of the DOM prune below — other message types
        // (system/file/poll) also evict chat messages from the log's front,
        // so DOM pruning alone would let the map grow all session.
        for (const key of this._messageMeta.keys()) {
            if (this._messageMeta.size <= 300) break;
            this._messageMeta.delete(key);
        }
        this._setupEmojiPicker(msg, messageId, text, isSelf);
        chatLog.appendChild(msgContainer);

        while (chatLog.children.length > this.maxMessages) {
            chatLog.removeChild(chatLog.firstChild);
        }

        const mentionedMe = this._finalizeMarkdownBody(msgContainer);

        const newMessageIndicator = document.getElementById('new-message-indicator');
        const tabFocused = document.hasFocus();
        const isFromOther = !isSelf;

        if (mentionedMe && isFromOther) {
            msg.classList.add('chat-message-mentioned');
        }

        if (isFromOther && (!tabFocused || this._isChatViewClosed())) {
            if (mentionedMe) this._notifyMention();
            else {
                newMessageIndicator.classList.remove('hidden');
                this._playMessageSound();
            }
        } else {
            newMessageIndicator.classList.add('hidden');
        }

        this._scrollIfAtBottom(chatLog);
    }

    /**
     * Swaps a self message's rendered body for an inline textarea (Discord-style)
     * prefilled with the original markdown. Enter saves, Escape cancels; saving
     * applies locally and fires onEditMessage so App.js broadcasts it.
     * @param {string} messageId
     * @returns {void}
     */
    _beginEdit(messageId) {
        const container = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
        const meta = this._messageMeta.get(messageId);
        const body = container?.querySelector('.chat-markdown');
        if (!container || !meta || !body) return;
        if (container.querySelector('.chat-edit-area')) return;

        const wrap = document.createElement('div');
        wrap.className = 'chat-edit-area ml-7';
        const ta = document.createElement('textarea');
        ta.className = 'chat-edit-input';
        ta.value = meta.rawText;
        ta.rows = 1;
        const hint = document.createElement('div');
        hint.className = 'chat-edit-hint';
        hint.innerHTML = 'escape to <button type="button" class="chat-edit-cancel">cancel</button> &middot; enter to <button type="button" class="chat-edit-save">save</button>';
        wrap.appendChild(ta);
        wrap.appendChild(hint);

        body.style.display = 'none';
        body.after(wrap);

        const grow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
        ta.addEventListener('input', grow);

        const endEdit = () => { wrap.remove(); body.style.display = ''; };
        const save = () => {
            const text = ta.value.trim();
            if (!text || text === meta.rawText) { endEdit(); return; }
            endEdit();
            this.applyChatEdit(messageId, text);
            this.onEditMessage?.(messageId, text);
        };
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
            else if (e.key === 'Escape') { e.preventDefault(); endEdit(); }
        });
        hint.querySelector('.chat-edit-cancel').addEventListener('click', endEdit);
        hint.querySelector('.chat-edit-save').addEventListener('click', save);
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        grow();
    }

    /**
     * Re-renders a message's body with new markdown text and tags it "(edited)".
     * Used for both the local echo of an own edit and remote peers' edits —
     * the same marked → DOMPurify → _finalizeMarkdownBody pipeline as the
     * original render, so an edit can't smuggle anything a new message couldn't.
     * Unknown messageIds no-op (peers who joined after the original was sent,
     * or messages already pruned by the log cap).
     * @param {string} messageId
     * @param {string} newText - raw markdown.
     * @returns {void}
     */
    applyChatEdit(messageId, newText) {
        const container = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
        const body = container?.querySelector('.chat-markdown');
        if (!container || !body) return;
        const meta = this._messageMeta.get(messageId);
        if (meta) meta.rawText = newText;

        // A remote edit racing a local inline-edit session: drop the editor
        // rather than leave it saving over text the user can no longer see.
        container.querySelector('.chat-edit-area')?.remove();
        body.style.display = '';
        body.innerHTML = DOMPurify.sanitize(marked.parse(newText));
        const mentionedMe = this._finalizeMarkdownBody(container);

        const msg = container.querySelector('.chat-message');
        if (!msg) return;
        if (!meta?.isSelf) msg.classList.toggle('chat-message-mentioned', mentionedMe);
        if (!msg.querySelector('.chat-edited-tag')) {
            const ts = msg.querySelector('.chat-timestamp');
            if (ts) {
                const tag = document.createElement('span');
                tag.className = 'chat-edited-tag';
                tag.textContent = '(edited)';
                ts.after(tag);
            }
        }
    }

    /**
     * Removes a message from the log entirely (Discord-style — no tombstone;
     * ephemeral chat has nothing to memorialize). Reply quotes pointing at it
     * keep their snapshot text; their click-to-scroll just no-ops.
     * @param {string} messageId
     * @returns {void}
     */
    applyChatDelete(messageId) {
        document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)?.remove();
        this._messageMeta.delete(messageId);
        this._reactions.delete(messageId);
        if (this._pinned.delete(messageId)) this._renderPinnedPanel();
    }

    /**
     * Read-only chat transcript for session-recap export (UIController.js's
     * exportSessionRecap()) — chronological (Map insertion order), one entry
     * per plain chat message still held in `_messageMeta`'s 300-message cap.
     * @returns {{sender: string, text: string, timestamp: string}[]}
     */
    getMessageHistory() {
        return [...this._messageMeta.values()].map(({ sender, rawText, timestamp }) => ({ sender, text: rawText, timestamp }));
    }

    /**
     * Read-only pinned-message list for session-recap export's "Decisions"
     * section — chronological by pin time (Map insertion order).
     * @returns {{sender: string, text: string, pinnedAt: number}[]}
     */
    getPinnedMessages() {
        return [...this._pinned.values()].map(({ sender, rawText, pinnedAt }) => ({ sender, text: rawText, pinnedAt }));
    }

    _pinBadgeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3 h-3"><path fill-rule="evenodd" clip-rule="evenodd" d="M10 2C8.28365 2 6.5916 2.10551 4.93005 2.31046C3.80579 2.44913 3 3.41374 3 4.51661V17.25C3 17.5078 3.13239 17.7475 3.35057 17.8848C3.56875 18.0221 3.84215 18.0377 4.07455 17.9261L10 15.0819L15.9255 17.9261C16.1578 18.0377 16.4312 18.0221 16.6494 17.8848C16.8676 17.7475 17 17.5078 17 17.25V4.51661C17 3.41374 16.1942 2.44913 15.07 2.31046C13.4084 2.10551 11.7163 2 10 2Z" /></svg>';

    /**
     * Local-apply entry point for a pin/unpin — called both for the local
     * moderator's own action (from the action-bar button above) and for an
     * already-authorized remote peer's pin/unpin (PeerManager checks
     * moderator status before ever calling this, see the receive-side
     * `pin-message`/`unpin-message` handling). Snapshots sender/text into
     * `_pinned` independently of `_messageMeta`'s cap and the DOM log's
     * `maxMessages` cap, since a pin is meant to survive both — a pruned
     * original just means the panel's click-to-scroll no-ops, same graceful
     * miss as reply quotes pointing at a pruned message.
     * @param {string} messageId
     * @param {boolean} pinned
     * @returns {void}
     */
    applyPin(messageId, pinned) {
        const container = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);

        if (pinned) {
            const meta = this._messageMeta.get(messageId);
            this._pinned.set(messageId, {
                sender: meta?.sender ?? container?.querySelector('.chat-sender')?.textContent ?? '?',
                rawText: meta?.rawText ?? container?.querySelector('.chat-markdown')?.textContent ?? '',
                pinnedAt: Date.now(),
            });
            for (const key of this._pinned.keys()) {
                if (this._pinned.size <= this._pinnedCap) break;
                this._pinned.delete(key);
            }
        } else {
            this._pinned.delete(messageId);
        }

        const msg = container?.querySelector('.chat-message');
        if (msg) {
            msg.classList.toggle('chat-message-pinned', pinned);
            let badge = msg.querySelector('.chat-pinned-badge');
            if (pinned && !badge) {
                badge = document.createElement('span');
                badge.className = 'chat-pinned-badge';
                badge.dataset.tip = 'Pinned';
                badge.innerHTML = this._pinBadgeSvg;
                msg.querySelector('.chat-timestamp')?.insertAdjacentElement('beforebegin', badge);
            } else if (!pinned && badge) {
                badge.remove();
            }
            const pinBtn = msg.querySelector('.msg-action-pin-btn');
            if (pinBtn) {
                pinBtn.classList.toggle('msg-action-pinned', pinned);
                pinBtn.dataset.tip = pinned ? 'Unpin message' : 'Pin message';
            }
        }

        this._renderPinnedPanel();
    }

    /**
     * Repopulates the "Pinned messages" popover (`#pinned-messages-panel`)
     * from `_pinned` and updates the trigger button's count badge. Called
     * after every pin/unpin/delete that touches `_pinned` — cheap since
     * pins are rare and the list is capped at `_pinnedCap`.
     * @returns {void}
     */
    _renderPinnedPanel() {
        const badge = document.getElementById('pinned-messages-badge');
        const panel = document.getElementById('pinned-messages-panel');
        if (!badge || !panel) return;

        const count = this._pinned.size;
        badge.textContent = String(count);
        badge.style.display = count > 0 ? '' : 'none';

        panel.innerHTML = '';
        if (count === 0) {
            const empty = document.createElement('div');
            empty.className = 'pinned-panel-empty';
            empty.textContent = 'No pinned messages yet';
            panel.appendChild(empty);
            return;
        }

        const iAmModerator = this._isModerator();
        // Most-recently-pinned first.
        [...this._pinned.entries()].reverse().forEach(([messageId, entry]) => {
            const row = document.createElement('div');
            row.className = 'pinned-panel-row';

            const main = document.createElement('div');
            main.className = 'pinned-panel-row-main';
            const preview = entry.rawText.length > 120 ? entry.rawText.slice(0, 120) + '…' : entry.rawText;
            main.innerHTML = `<span class="pinned-panel-sender">${escapeHtml(entry.sender)}</span><span class="pinned-panel-preview">${escapeHtml(preview)}</span>`;
            main.addEventListener('click', () => {
                const target = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
                if (!target) return;
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                target.querySelector('.chat-message')?.classList.add('chat-message-highlight');
                setTimeout(() => target.querySelector('.chat-message')?.classList.remove('chat-message-highlight'), 1500);
            });
            row.appendChild(main);

            if (iAmModerator) {
                const unpinBtn = document.createElement('button');
                unpinBtn.type = 'button';
                unpinBtn.className = 'pinned-panel-unpin-btn';
                unpinBtn.dataset.tip = 'Unpin';
                unpinBtn.textContent = '×';
                unpinBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.applyPin(messageId, false);
                    this.onUnpinMessage?.(messageId);
                });
                row.appendChild(unpinBtn);
            }

            panel.appendChild(row);
        });
    }

    /**
     * Shared by addChatMessage and ensureFileGroup's caption — builds the
     * reply-quote block HTML rendered above a message body.
     * @param {{messageId: string, sender: string, text: string}|null} replyData
     * @returns {string} HTML, or '' if there's no reply to render.
     */
    _replyQuoteHtml(replyData) {
        if (!replyData || !replyData.sender || !replyData.text) return '';
        const myNickname = (localStorage.getItem('nickname') || 'Anonymous').trim();
        const rColor = replyData.sender === myNickname ? '#22c55e' : this._colorForName(replyData.sender);
        const rText = escapeHtml(replyData.text.length > 80 ? replyData.text.substring(0, 80) + '...' : replyData.text);
        return `<div class="chat-reply-quote ml-7" data-reply-to="${escapeHtml(replyData.messageId || '')}"><span class="chat-reply-sender" style="color:${rColor}">${escapeHtml(replyData.sender)}</span> ${rText}</div>`;
    }

    /** Wires a rendered reply-quote block's click-to-scroll-to-original + highlight. */
    _wireReplyQuote(msgContainer) {
        const replyQuote = msgContainer.querySelector('.chat-reply-quote');
        if (!replyQuote) return;
        replyQuote.addEventListener('click', () => {
            const target = document.querySelector(`[data-message-id="${CSS.escape(replyQuote.dataset.replyTo)}"]`);
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                target.querySelector('.chat-message')?.classList.add('chat-message-highlight');
                setTimeout(() => target.querySelector('.chat-message')?.classList.remove('chat-message-highlight'), 1500);
            }
        });
    }

    /**
     * Post-processing shared by any rendered markdown body (chat text or a file
     * group's caption): syntax highlighting + a copy button on code fences,
     * link-preview expansion, and @mention detection/highlighting.
     * @param {HTMLElement} msgContainer
     * @returns {boolean} true if the local user was mentioned in this body.
     */
    _finalizeMarkdownBody(msgContainer) {
        msgContainer.querySelectorAll('pre code').forEach((block) => {
            // Read the declared fence language before highlightElement runs —
            // hljs adds its own language-* class when it auto-detects, and only
            // the sender's explicit ```lang should get a label.
            const declaredLang = block.className.match(/language-([\w+#-]+)/)?.[1];

            hljs.highlightElement(block);

            const pre = block.parentElement;
            pre.style.position = 'relative';

            if (declaredLang) {
                const langLabel = document.createElement('span');
                langLabel.className = 'code-lang-label';
                langLabel.textContent = declaredLang;
                pre.appendChild(langLabel);
            }

            const copyBtn = document.createElement('button');
            copyBtn.textContent = '\u{1F4CB}';
            copyBtn.dataset.tip = 'Copy code';
            copyBtn.className = 'copy-btn';

            copyBtn.addEventListener('click', () => {
                // marked always leaves a trailing \n inside the <code> element —
                // trim so pasting into a field doesn't drag a newline along.
                navigator.clipboard.writeText(block.textContent.trim()).then(() => {
                    copyBtn.textContent = '✅';
                    setTimeout(() => (copyBtn.textContent = '\u{1F4CB}'), 1500);
                });
            });

            pre.appendChild(copyBtn);
        });

        // Inline (single-backtick) code chips are click-to-copy — the chip itself
        // is the button, since an appended button would break inline text flow.
        msgContainer.querySelectorAll('.chat-markdown code').forEach((code) => {
            if (code.closest('pre')) return;
            code.dataset.tip = 'Click to copy';
            code.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(code.textContent.trim()).then(() => {
                    code.classList.add('inline-code-copied');
                    setTimeout(() => code.classList.remove('inline-code-copied'), 1500);
                });
            });
        });

        this._processLinkPreviews(msgContainer);
        return this._processMentions(msgContainer);
    }

    /**
     * Finds `@nickname` tokens (matched against every current participant's
     * nickname, case-insensitively, longest-name-first so one name that's a
     * prefix of another can't steal the match) in a rendered markdown body
     * and wraps each in a highlighted `.chat-mention` span. Skips text
     * inside links/code so a mention-like substring there isn't mangled.
     * Operates on the DOM (not the HTML string) so wrapping can't break out
     * of an existing tag or attribute.
     * @param {HTMLElement} container
     * @returns {boolean} true if one of the mentions matches the local user's own nickname.
     */
    _processMentions(container) {
        const body = container.querySelector('.chat-markdown');
        if (!body) return false;

        const nicknames = [...new Set(this._getAllNicknames().map(n => n.trim()).filter(Boolean))]
            .sort((a, b) => b.length - a.length);
        if (nicknames.length === 0) return false;

        const escaped = nicknames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const pattern = new RegExp(`@(?:${escaped.join('|')})\\b`, 'gi');
        const myNickname = (localStorage.getItem('nickname') || '').trim().toLowerCase();

        let mentionedMe = false;
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) textNodes.push(node);

        for (const textNode of textNodes) {
            if (textNode.parentElement?.closest('a, code, pre')) continue;
            const text = textNode.textContent;
            pattern.lastIndex = 0;
            if (!pattern.test(text)) continue;
            pattern.lastIndex = 0;

            const frag = document.createDocumentFragment();
            let lastIndex = 0;
            let match;
            while ((match = pattern.exec(text))) {
                if (match.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
                const span = document.createElement('span');
                span.className = 'chat-mention';
                span.textContent = match[0];
                frag.appendChild(span);
                if (match[0].slice(1).toLowerCase() === myNickname) mentionedMe = true;
                lastIndex = match.index + match[0].length;
            }
            if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
            textNode.parentNode.replaceChild(frag, textNode);
        }

        return mentionedMe;
    }

    /**
     * Shared by addChatMessage and the grouped file-message renderers — only
     * auto-scrolls if the user was already at (or near) the bottom, so a message
     * arriving while they've scrolled up to read history doesn't yank them back down.
     * @param {HTMLElement} chatLog
     * @returns {void}
     */
    _scrollIfAtBottom(chatLog) {
        const chatInput = document.getElementById('chat-input');
        const threshold = chatInput.scrollHeight + 50;
        const isAtBottom = (chatLog.scrollTop + chatLog.clientHeight) >= (chatLog.scrollHeight - threshold);
        if (isAtBottom) {
            requestAnimationFrame(() => chatLog.scrollTo({ top: chatLog.scrollHeight, behavior: 'smooth' }));
        }
    }
}
