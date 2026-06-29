import { playSound } from './SoundPlayer.js';

export class ChatUI {
    constructor({ getNickname }) {
        this._getNickname = getNickname;
        this.maxMessages = 100;
        this._typingPeers = new Set();
        this._reactions = new Map();
        this._onReaction = null;
        this._replyTo = null;
    }

    updateTypingIndicator(peerId, isTyping) {
        if (isTyping) {
            this._typingPeers.add(peerId);
        } else {
            this._typingPeers.delete(peerId);
        }
        this._renderTypingIndicator();
    }

    _renderTypingIndicator() {
        const el = document.getElementById('typing-indicator');
        if (!el) return;
        const count = this._typingPeers.size;
        if (count === 0) {
            el.classList.add('hidden');
            return;
        }
        const names = [...this._typingPeers].map(id => this._getNickname(id));
        let text;
        if (count === 1) text = `${names[0]} is typing`;
        else if (count === 2) text = `${names[0]} and ${names[1]} are typing`;
        else text = 'Several people are typing';
        el.innerHTML = `<span class="typing-dots"><span>.</span><span>.</span><span>.</span></span> ${text}`;
        el.classList.remove('hidden');
    }

    setReplyTo(messageId, sender, text) {
        this._replyTo = { messageId, sender, text };
        const preview = document.getElementById('reply-preview');
        if (!preview) return;
        const truncated = text.length > 80 ? text.substring(0, 80) + '...' : text;
        preview.innerHTML = `<div class="reply-preview-content"><span class="reply-preview-sender">${sender}</span> <span class="reply-preview-text">${truncated}</span></div><button class="reply-preview-close">&times;</button>`;
        preview.classList.remove('hidden');
        preview.querySelector('.reply-preview-close').addEventListener('click', () => this.clearReply());
        document.getElementById('message')?.focus();
    }

    clearReply() {
        this._replyTo = null;
        const preview = document.getElementById('reply-preview');
        if (preview) preview.classList.add('hidden');
    }

    getReplyTo() {
        return this._replyTo;
    }

    _emojiSet = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

    _setupEmojiPicker(msgEl, messageId) {
        const actionBar = document.createElement('div');
        actionBar.className = 'msg-action-bar';

        const replyBtn = document.createElement('button');
        replyBtn.className = 'msg-action-btn';
        replyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5"><path fill-rule="evenodd" d="M7.793 2.232a.75.75 0 0 1-.025 1.06L3.622 7.25h10.003a5.375 5.375 0 0 1 0 10.75H10.75a.75.75 0 0 1 0-1.5h2.875a3.875 3.875 0 0 0 0-7.75H3.622l4.146 3.957a.75.75 0 0 1-1.036 1.085l-5.5-5.25a.75.75 0 0 1 0-1.085l5.5-5.25a.75.75 0 0 1 1.06.025Z" clip-rule="evenodd" /></svg>';
        replyBtn.title = 'Reply';
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
        btn.title = 'React';
        actionBar.appendChild(btn);
        msgEl.appendChild(actionBar);

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.emoji-picker').forEach(p => p.remove());
            const picker = document.createElement('div');
            picker.className = 'emoji-picker';
            this._emojiSet.forEach(emoji => {
                const eb = document.createElement('button');
                eb.textContent = emoji;
                eb.addEventListener('click', (e) => {
                    e.stopPropagation();
                    picker.remove();
                    if (this._onReaction) this._onReaction(messageId, emoji);
                });
                picker.appendChild(eb);
            });
            msgEl.appendChild(picker);
            setTimeout(() => {
                const close = () => { picker.remove(); document.removeEventListener('click', close); };
                document.addEventListener('click', close);
            }, 0);
        });
    }

    addReaction(messageId, emoji, nickname, fromPeerId) {
        const msgEl = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!msgEl) return;
        const bar = msgEl.querySelector('.reaction-bar');
        if (!bar) return;

        if (!this._reactions.has(messageId)) this._reactions.set(messageId, new Map());
        const msgReactions = this._reactions.get(messageId);
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

    _formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }

    updateFileProgress(fileId, progress, direction, fileName) {
        let el = document.getElementById(`file-progress-${fileId}`);
        if (!el) {
            el = document.createElement('div');
            el.id = `file-progress-${fileId}`;
            el.className = 'file-progress';
            const label = direction === 'upload' ? 'Sending' : 'Receiving';
            el.innerHTML = `<span class="file-progress-label">${label}: ${fileName}</span><div class="file-progress-track"><div class="file-progress-fill"></div></div>`;
            const chatLog = document.getElementById('chat-log');
            chatLog.appendChild(el);
            requestAnimationFrame(() => chatLog.scrollTo({ top: chatLog.scrollHeight }));
        }
        const fill = el.querySelector('.file-progress-fill');
        if (fill) fill.style.width = (progress * 100) + '%';
    }

    removeFileProgress(fileId) {
        const el = document.getElementById(`file-progress-${fileId}`);
        if (el) el.remove();
    }

    addFileMessage(sender, fileId, fileName, fileSize, fileType, blobUrl) {
        const chatLog = document.getElementById('chat-log');
        const msgContainer = document.createElement('div');

        const isSelf = sender === 'Me';
        const initial = isSelf ? (localStorage.getItem('nickname') || 'Me').charAt(0).toUpperCase() : sender.charAt(0).toUpperCase();
        const color = isSelf ? '#22c55e' : this._colorForName(sender);
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const sizeStr = this._formatFileSize(fileSize);
        const isImage = /^image\//i.test(fileType);

        let fileContent;
        if (isImage) {
            fileContent = `<div class="chat-image-preview"><img src="${blobUrl}" alt="${fileName}" /></div>`;
        } else {
            fileContent = `<div class="file-card"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5 text-muted"><path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l4.122 4.12A1.5 1.5 0 0 1 17 7.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" /></svg><div class="file-card-info"><span class="file-card-name">${fileName}</span><span class="file-card-size">${sizeStr}</span></div><a href="${blobUrl}" download="${fileName}" class="file-card-download" title="Download">&#x2B73;</a></div>`;
        }

        msgContainer.innerHTML = `<div class="chat-message px-4 py-2 text-sm"><div class="flex items-center gap-2 mb-0.5"><span class="chat-avatar" style="background:${color}">${initial}</span><span class="chat-sender font-medium text-xs" style="color:${color}">${sender}</span><span class="chat-timestamp text-[10px] ml-auto shrink-0">${timestamp}</span></div><div class="ml-7">${fileContent}</div></div>`;
        chatLog.appendChild(msgContainer);

        while (chatLog.children.length > this.maxMessages) {
            chatLog.removeChild(chatLog.firstChild);
        }

        requestAnimationFrame(() => chatLog.scrollTo({ top: chatLog.scrollHeight, behavior: 'smooth' }));

        if (!document.hasFocus() && !isSelf) {
            const indicator = document.getElementById('new-message-indicator');
            if (indicator) indicator.classList.remove('hidden');
            playSound('newMessage');
        }
    }

    _imageUrlPattern = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?.*)?$/i;

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
                img.addEventListener('click', () => window.open(href, '_blank'));
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

    _colorForName(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        return this._chatAvatarColors[Math.abs(hash) % this._chatAvatarColors.length];
    }

    addChatMessage(sender, text, messageId, replyData) {
        const chatLog = document.getElementById('chat-log');
        const msgContainer = document.createElement('div');
        if (!messageId) messageId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
        msgContainer.dataset.messageId = messageId;

        const raw = marked.parse(text);
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const isSelf = sender === 'Me';
        const initial = isSelf ? (localStorage.getItem('nickname') || 'Me').charAt(0).toUpperCase() : sender.charAt(0).toUpperCase();
        const color = isSelf ? '#22c55e' : this._colorForName(sender);

        let replyHtml = '';
        if (replyData && replyData.sender && replyData.text) {
            const rColor = replyData.sender === 'Me' ? '#22c55e' : this._colorForName(replyData.sender);
            const rText = replyData.text.length > 80 ? replyData.text.substring(0, 80) + '...' : replyData.text;
            replyHtml = `<div class="chat-reply-quote ml-7" data-reply-to="${replyData.messageId || ''}"><span class="chat-reply-sender" style="color:${rColor}">${replyData.sender}</span> ${rText}</div>`;
        }

        msgContainer.innerHTML = `<div class="chat-message px-4 py-2 text-sm"><div class="flex items-center gap-2 mb-0.5"><span class="chat-avatar" style="background:${color}">${initial}</span><span class="chat-sender font-medium text-xs" style="color:${color}">${sender}</span><span class="chat-timestamp text-[10px] ml-auto shrink-0">${timestamp}</span></div>${replyHtml}<div class="chat-markdown chat-body prose ml-7">${raw}</div><div class="reaction-bar ml-7"></div></div>`;

        const replyQuote = msgContainer.querySelector('.chat-reply-quote');
        if (replyQuote) {
            replyQuote.addEventListener('click', () => {
                const target = document.querySelector(`[data-message-id="${replyQuote.dataset.replyTo}"]`);
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    target.querySelector('.chat-message')?.classList.add('chat-message-highlight');
                    setTimeout(() => target.querySelector('.chat-message')?.classList.remove('chat-message-highlight'), 1500);
                }
            });
        }

        const msg = msgContainer.querySelector('.chat-message');
        this._setupEmojiPicker(msg, messageId);
        chatLog.appendChild(msgContainer);

        while (chatLog.children.length > this.maxMessages) {
            chatLog.removeChild(chatLog.firstChild);
        }

        msgContainer.querySelectorAll('pre code').forEach((block) => {
            hljs.highlightElement(block);

            const pre = block.parentElement;
            pre.style.position = 'relative';

            const copyBtn = document.createElement('button');
            copyBtn.textContent = '\u{1F4CB}';
            copyBtn.title = 'Copy code';
            copyBtn.className = 'copy-btn';

            copyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(block.textContent).then(() => {
                    copyBtn.textContent = '✅';
                    setTimeout(() => (copyBtn.textContent = '\u{1F4CB}'), 1500);
                });
            });

            pre.appendChild(copyBtn);
        });

        this._processLinkPreviews(msgContainer);

        const newMessageIndicator = document.getElementById('new-message-indicator');
        const tabFocused = document.hasFocus();
        const isFromOther = sender !== 'Me';
        const chatPanel = document.getElementById('chat');
        const chatHiddenOnMobile = chatPanel && window.innerWidth < 768 && !chatPanel.classList.contains('mobile-open');

        if (isFromOther && (!tabFocused || chatHiddenOnMobile)) {
            newMessageIndicator.classList.remove('hidden');
            playSound('newMessage');
        } else {
            newMessageIndicator.classList.add('hidden');
        }

        const chatInput = document.getElementById('chat-input');
        const threshold = chatInput.scrollHeight + 50;
        const isAtBottom = (chatLog.scrollTop + chatLog.clientHeight) >= (chatLog.scrollHeight - threshold);
        if (isAtBottom) {
            requestAnimationFrame(() => {
                chatLog.scrollTo({ top: chatLog.scrollHeight, behavior: 'smooth' });
            });
        }
    }
}
