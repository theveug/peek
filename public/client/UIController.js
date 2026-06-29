import { playSound } from './SoundPlayer.js';
// --- public/client/UIController.js ---
export class UIController {
    constructor() {
        this.container = document.getElementById('videos');
        this.chatLog = document.getElementById('chat-log');
        this.videoContainer = document.getElementById('videos');
        this.focusedView = document.getElementById('focused-view');
        this.focusedVideo = document.getElementById('focused-video');
        this.gridView = document.getElementById('grid-view');
        this.maxMessages = 100;
        this.streams = {};
        this.focusedPeerId = null;
        this.viewMode = 'grid'; // 'focus' or 'grid'
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.isPanning = false;
        this._typingPeers = new Set();
        this._reactions = new Map();
        this._onReaction = null;
        this._replyTo = null;
        this.setupZoom();
        this._createToastContainer();
    }

    _createToastContainer() {
        const c = document.createElement('div');
        c.id = 'toast-container';
        c.className = 'toast-container';
        document.body.appendChild(c);
    }

    _peerNickname(peerId) {
        const el = document.getElementById(`participant-${peerId}`);
        if (!el) return peerId.substring(0, 8);
        const name = el.querySelector('.participant-name');
        return name ? name.textContent : peerId.substring(0, 8);
    }

    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const icons = {
            join: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path d="M10 2a.75.75 0 0 1 .75.75v5.59l1.95-2.1a.75.75 0 1 1 1.1 1.02l-3.25 3.5a.75.75 0 0 1-1.1 0L6.2 7.26a.75.75 0 1 1 1.1-1.02l1.95 2.1V2.75A.75.75 0 0 1 10 2Z" /><path d="M5.273 4.5a1.25 1.25 0 0 0-1.205.918l-1.523 5.52c-.006.02-.01.041-.015.062H6a1 1 0 0 1 .894.553l.448.894a1 1 0 0 0 .894.553h3.438a1 1 0 0 0 .86-.49l.606-1.02A1 1 0 0 1 14 11h3.47a1.318 1.318 0 0 0-.015-.062l-1.523-5.52a1.25 1.25 0 0 0-1.205-.918h-9.454Z" /></svg>',
            leave: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path fill-rule="evenodd" d="M3 4.25A2.25 2.25 0 0 1 5.25 2h5.5A2.25 2.25 0 0 1 13 4.25v2a.75.75 0 0 1-1.5 0v-2a.75.75 0 0 0-.75-.75h-5.5a.75.75 0 0 0-.75.75v11.5c0 .414.336.75.75.75h5.5a.75.75 0 0 0 .75-.75v-2a.75.75 0 0 1 1.5 0v2A2.25 2.25 0 0 1 10.75 18h-5.5A2.25 2.25 0 0 1 3 15.75V4.25Z" clip-rule="evenodd" /><path fill-rule="evenodd" d="M19 10a.75.75 0 0 0-.75-.75H8.704l1.048-.943a.75.75 0 1 0-1.004-1.114l-2.5 2.25a.75.75 0 0 0 0 1.114l2.5 2.25a.75.75 0 1 0 1.004-1.114l-1.048-.943h9.546A.75.75 0 0 0 19 10Z" clip-rule="evenodd" /></svg>',
            stream: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path d="M1 4.75C1 3.784 1.784 3 2.75 3h14.5c.966 0 1.75.784 1.75 1.75v10.515a1.75 1.75 0 0 1-1.75 1.75h-1.5v-1.5h1.5a.25.25 0 0 0 .25-.25V4.75a.25.25 0 0 0-.25-.25H2.75a.25.25 0 0 0-.25.25v10.515c0 .138.112.25.25.25h1.5v1.5h-1.5A1.75 1.75 0 0 1 1 15.265V4.75Z" /><path d="M10 7.292a.625.625 0 0 1 .625.625v1.958h1.958a.625.625 0 1 1 0 1.25h-1.958v1.958a.625.625 0 1 1-1.25 0v-1.958H7.417a.625.625 0 1 1 0-1.25h1.958V7.917A.625.625 0 0 1 10 7.292Z" /></svg>',
            info: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path fill-rule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a.75.75 0 0 0 0 1.5h.253a.25.25 0 0 1 .244.304l-.459 2.066A1.75 1.75 0 0 0 10.747 15H11a.75.75 0 0 0 0-1.5h-.253a.25.25 0 0 1-.244-.304l.459-2.066A1.75 1.75 0 0 0 9.253 9H9Z" clip-rule="evenodd" /></svg>',
        };

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-text">${message}</span>`;
        container.appendChild(toast);

        while (container.children.length > 5) {
            container.removeChild(container.firstChild);
        }

        setTimeout(() => {
            toast.classList.add('toast-out');
            toast.addEventListener('animationend', () => toast.remove());
        }, 4000);
    }

    setupZoom() {
        const view = this.focusedView;
        const vid = this.focusedVideo;

        view.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = vid.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            const prevZoom = this.zoom;
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            this.zoom = Math.max(1, Math.min(10, this.zoom * delta));

            const scale = this.zoom / prevZoom;
            this.panX = mouseX - scale * (mouseX - this.panX);
            this.panY = mouseY - scale * (mouseY - this.panY);

            if (this.zoom <= 1) { this.panX = 0; this.panY = 0; this.zoom = 1; }
            this.clampPan();
            this.applyTransform();
        }, { passive: false });

        view.addEventListener('mousedown', (e) => {
            if (this.zoom <= 1) return;
            e.preventDefault();
            this.isPanning = true;
            this.dragStartX = e.clientX - this.panX;
            this.dragStartY = e.clientY - this.panY;
            view.style.cursor = 'grabbing';
        });

        window.addEventListener('mousemove', (e) => {
            if (!this.isPanning) return;
            this.panX = e.clientX - this.dragStartX;
            this.panY = e.clientY - this.dragStartY;
            this.clampPan();
            this.applyTransform();
        });

        window.addEventListener('mouseup', () => {
            if (!this.isPanning) return;
            this.isPanning = false;
            this.focusedView.style.cursor = this.zoom > 1 ? 'grab' : '';
        });

        view.addEventListener('dblclick', () => {
            this.zoom = 1;
            this.panX = 0;
            this.panY = 0;
            this.applyTransform();
            view.style.cursor = '';
        });
    }

    clampPan() {
        const vid = this.focusedVideo;
        const viewRect = this.focusedView.getBoundingClientRect();
        const scaledW = vid.videoWidth ? Math.min(vid.clientWidth, viewRect.width) * this.zoom : viewRect.width * this.zoom;
        const scaledH = vid.videoHeight ? Math.min(vid.clientHeight, viewRect.height) * this.zoom : viewRect.height * this.zoom;

        this.panX = Math.min(0, Math.max(viewRect.width - scaledW, this.panX));
        this.panY = Math.min(0, Math.max(viewRect.height - scaledH, this.panY));
    }

    applyTransform() {
        this.focusedVideo.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
        this.focusedView.style.cursor = this.zoom > 1 ? 'grab' : '';
    }

    setViewMode(mode) {
        this.viewMode = mode;
        this.updateLayout();
    }

    toggleViewMode() {
        this.setViewMode(this.viewMode === 'focus' ? 'grid' : 'focus');
    }

    focusStream(peerId) {
        const stream = this.streams[peerId];
        if (!stream) return;

        this.focusedPeerId = peerId;
        this.focusedVideo.srcObject = stream;
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.applyTransform();
        this.setViewMode('focus');
    }

    buildGrid() {
        this.gridView.innerHTML = '';
        const remoteIds = Object.keys(this.streams).filter(id => id !== 'me');
        const count = remoteIds.length;
        if (count === 0) return;

        const cols = count <= 1 ? 1 : 2;
        const rows = Math.ceil(count / cols);
        this.gridView.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        this.gridView.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

        remoteIds.forEach(peerId => {
            const cell = document.createElement('div');
            cell.className = 'relative overflow-hidden cursor-pointer bg-black flex items-center justify-center';
            cell.dataset.peerId = peerId;

            const video = document.createElement('video');
            video.muted = true;
            video.autoplay = true;
            video.playsInline = true;
            video.srcObject = this.streams[peerId];
            video.className = 'w-full h-full object-contain';

            cell.appendChild(video);
            cell.addEventListener('click', () => this.focusStream(peerId));
            this.gridView.appendChild(cell);
        });
    }

    addPeer(peerId) {
        playSound('peerJoin');
        this.addParticipant(peerId);
        if (!this._pendingJoinToasts) this._pendingJoinToasts = new Set();
        this._pendingJoinToasts.add(peerId);
        setTimeout(() => {
            if (this._pendingJoinToasts.has(peerId)) {
                this._pendingJoinToasts.delete(peerId);
                this.showToast(`${this._peerNickname(peerId)} joined`, 'join');
            }
        }, 2000);
    }

    removePeer(peerId) {
        const name = this._peerNickname(peerId);
        playSound('peerLeft');
        this.removeAudio(peerId);
        this.removeParticipant(peerId);
        this._typingPeers.delete(peerId);
        this._renderTypingIndicator();
        this.showToast(`${name} left`, 'leave');
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
        const names = [...this._typingPeers].map(id => this._peerNickname(id));
        let text;
        if (count === 1) text = `${names[0]} is typing`;
        else if (count === 2) text = `${names[0]} and ${names[1]} are typing`;
        else text = 'Several people are typing';
        el.innerHTML = `<span class="typing-dots"><span>.</span><span>.</span><span>.</span></span> ${text}`;
        el.classList.remove('hidden');
    }

    addSelf(peerId) {
        if (document.getElementById(`participant-${peerId}`)) return;
        this.selfPeerId = peerId;
        const nickname = localStorage.getItem('nickname') || 'You';
        this._createParticipantCard(peerId, nickname, true);
    }

    addParticipant(peerId) {
        if (document.getElementById(`participant-${peerId}`)) return;
        this._createParticipantCard(peerId, peerId.substring(0, 8), false);
    }

    _statusColors = {
        online:  '#22c55e',
        away:    '#eab308',
        dnd:     '#ef4444',
        offline: '#6b7280',
    };

    _statusLabels = {
        online:  'Online',
        away:    'Away',
        dnd:     'Do Not Disturb',
        offline: 'Offline',
    };

    _createParticipantCard(peerId, displayName, isSelf) {
        const container = document.getElementById('participants');

        const card = document.createElement('div');
        card.id = `participant-${peerId}`;
        card.className = 'participant-card';
        if (isSelf) card.dataset.self = '1';

        const avatarWrap = document.createElement('div');
        avatarWrap.className = 'relative flex-shrink-0';

        const avatarColor = isSelf
            ? 'bg-emerald-600/30 border-2 border-emerald-500/40'
            : 'bg-indigo-600/30 border-2 border-indigo-500/40';
        const avatar = document.createElement('div');
        avatar.className = `flex items-center justify-center w-9 h-9 rounded-full ${avatarColor} text-white text-xs font-bold select-none`;
        const initials = displayName.split(/\s+/).map(w => w[0]).join('').substring(0, 2).toUpperCase()
            || displayName.substring(0, 2).toUpperCase();
        avatar.textContent = initials;

        const statusDot = document.createElement('div');
        statusDot.className = 'participant-status-dot absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2';
        statusDot.style.background = this._statusColors.online;
        statusDot.title = 'Online';

        const micDot = document.createElement('div');
        micDot.className = 'participant-mic absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center border-2';
        micDot.style.cssText = 'background:#ef4444; color:white;';
        micDot.innerHTML = this._micOffSvg();

        avatarWrap.appendChild(avatar);
        avatarWrap.appendChild(statusDot);
        avatarWrap.appendChild(micDot);

        const info = document.createElement('div');
        info.className = 'flex flex-col min-w-0';

        const nameRow = document.createElement('div');
        nameRow.className = 'flex items-center gap-1.5';

        const name = document.createElement('span');
        name.className = 'participant-name text-sm font-medium truncate';
        name.textContent = displayName;

        nameRow.appendChild(name);

        if (isSelf) {
            const youBadge = document.createElement('span');
            youBadge.className = 'text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded-full bg-emerald-600/20 text-emerald-400 leading-none';
            youBadge.textContent = 'you';
            nameRow.appendChild(youBadge);
        }

        const statusRow = document.createElement('div');
        statusRow.className = 'participant-status-icons flex items-center gap-1.5 mt-0.5';

        const statusLabel = document.createElement('span');
        statusLabel.className = 'participant-status-label text-[10px] text-emerald-400';
        statusLabel.textContent = 'Online';
        statusRow.appendChild(statusLabel);

        const separator = document.createElement('span');
        separator.className = 'text-[10px] text-muted';
        separator.textContent = '·';
        statusRow.appendChild(separator);

        const micLabel = document.createElement('span');
        micLabel.className = 'participant-mic-label text-[10px]';
        micLabel.textContent = 'Muted';
        statusRow.appendChild(micLabel);

        info.appendChild(nameRow);
        info.appendChild(statusRow);

        card.appendChild(avatarWrap);
        card.appendChild(info);

        if (isSelf) {
            container.prepend(card);
        } else {
            container.appendChild(card);
        }
        this._updateMemberCount();
    }

    updateParticipantStatus(peerId, status) {
        let el = document.getElementById(`participant-${peerId}`);
        if (!el) return;
        const dot = el.querySelector('.participant-status-dot');
        const label = el.querySelector('.participant-status-label');
        const color = this._statusColors[status] || this._statusColors.online;
        const text = this._statusLabels[status] || 'Online';
        if (dot) {
            dot.style.background = color;
            dot.title = text;
            if (status === 'dnd') {
                dot.innerHTML = `<svg viewBox="0 0 10 10" class="w-1.5 h-1.5" style="margin:auto"><rect x="2" y="4" width="6" height="2" rx="1" fill="white"/></svg>`;
            } else {
                dot.innerHTML = '';
            }
        }
        if (label) {
            label.textContent = text;
            label.className = `participant-status-label text-[10px]`;
            if (status === 'online') label.classList.add('text-emerald-400');
            else if (status === 'away') label.classList.add('text-yellow-400');
            else if (status === 'dnd') label.classList.add('text-red-400');
            else label.classList.add('text-muted');
        }
    }

    removeParticipant(peerId) {
        const el = document.getElementById(`participant-${peerId}`);
        if (el) el.remove();
        this._updateMemberCount();
    }

    _updateMemberCount() {
        const count = document.getElementById('participants')?.children.length || 0;
        const el = document.getElementById('member-count');
        if (el) el.textContent = count;
    }

    _micOnSvg() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-2.5 h-2.5"><path d="M7 4a3 3 0 0 1 6 0v6a3 3 0 1 1-6 0V4Z" /><path d="M5.5 9.643a.75.75 0 0 1 .75.75v.357a3.75 3.75 0 0 0 7.5 0v-.357a.75.75 0 0 1 1.5 0v.357a5.25 5.25 0 0 1-4.5 5.196V17.5a.75.75 0 0 1-1.5 0v-1.554a5.25 5.25 0 0 1-4.5-5.196v-.357a.75.75 0 0 1 .75-.75Z" /></svg>`;
    }

    _micOffSvg() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-2.5 h-2.5"><path d="M7.22 3.22a.75.75 0 0 1 1.06 0L12 6.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L13.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L12 9.06l-3.72 3.72a.75.75 0 0 1-1.06-1.06L10.94 8 7.22 4.28a.75.75 0 0 1 0-1.06Z" /></svg>`;
    }

    updateParticipantMic(peerId, enabled) {
        let el = document.getElementById(`participant-${peerId}`);
        if (!el) {
            this.addParticipant(peerId);
            el = document.getElementById(`participant-${peerId}`);
        }
        const dot = el.querySelector('.participant-mic');
        const label = el.querySelector('.participant-mic-label');
        const avatar = el.querySelector('.flex-shrink-0 > div:first-child');
        if (enabled) {
            dot.style.background = '#22c55e';
            dot.innerHTML = this._micOnSvg();
            if (label) label.textContent = 'Unmuted';
            if (avatar) avatar.classList.add('status-talking');
        } else {
            dot.style.background = '#ef4444';
            dot.innerHTML = this._micOffSvg();
            if (label) label.textContent = 'Muted';
            if (avatar) avatar.classList.remove('status-talking');
        }
    }

    updateParticipantDeafen(peerId, deafened) {
        let el = document.getElementById(`participant-${peerId}`);
        if (!el) return;
        const status = el.querySelector('.participant-status-icons');
        let deafIcon = el.querySelector('.participant-deafen-icon');
        if (deafened) {
            if (!deafIcon) {
                deafIcon = document.createElement('span');
                deafIcon.className = 'participant-deafen-icon';
                deafIcon.title = 'Deafened';
                deafIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3 h-3 text-red-400"><path d="M10.047 3.062a.75.75 0 0 1 .453.688v12.5a.75.75 0 0 1-1.264.546L5.203 13H2.667a.75.75 0 0 1-.7-.48A6.985 6.985 0 0 1 1.5 10c0-.622.082-1.225.234-1.798a.75.75 0 0 1 .467-.512L5.203 7l4.033-3.796a.75.75 0 0 1 .811-.142ZM13.78 7.22a.75.75 0 1 0-1.06 1.06L14.44 10l-1.72 1.72a.75.75 0 1 0 1.06 1.06l1.72-1.72 1.72 1.72a.75.75 0 1 0 1.06-1.06L16.56 10l1.72-1.72a.75.75 0 1 0-1.06-1.06l-1.72 1.72-1.72-1.72Z" /></svg>`;
                status.appendChild(deafIcon);
            }
        } else {
            if (deafIcon) deafIcon.remove();
        }
    }

    updateParticipantNickname(peerId, nickname) {
        let el = document.getElementById(`participant-${peerId}`);
        if (!el) {
            this.addParticipant(peerId);
            el = document.getElementById(`participant-${peerId}`);
        }
        if (!nickname) return;
        const nameEl = el.querySelector('.participant-name');
        if (nameEl) nameEl.textContent = nickname;
        const avatar = el.querySelector('.flex-shrink-0 > div:first-child');
        if (avatar) {
            const initials = nickname.split(/\s+/).map(w => w[0]).join('').substring(0, 2).toUpperCase();
            avatar.textContent = initials || nickname.substring(0, 2).toUpperCase();
        }

        if (this._pendingJoinToasts && this._pendingJoinToasts.has(peerId)) {
            this._pendingJoinToasts.delete(peerId);
            this.showToast(`${nickname} joined`, 'join');
        }
    }

    addAudio(peerId, track) {
        let audio = document.getElementById(`audio-${peerId}`);
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = `audio-${peerId}`;
            audio.autoplay = true;
            document.body.appendChild(audio);
        }
        audio.srcObject = new MediaStream([track]);
        audio.muted = !document.getElementById('deafen-off-icon') || document.getElementById('deafen-off-icon').classList.contains('hidden');
    }

    removeAudio(peerId) {
        const audio = document.getElementById(`audio-${peerId}`);
        if (audio) {
            audio.srcObject = null;
            audio.remove();
        }
    }

    addStream(peerId, stream) {
        this.streams[peerId] = stream;

        if (peerId === 'me') {
            let selfView = document.getElementById('self-view');
            if (selfView) {
                selfView.srcObject = stream;
            } else {
                selfView = document.createElement('video');
                selfView.id = 'self-view';
                selfView.muted = true;
                selfView.autoplay = true;
                selfView.playsInline = true;
                selfView.srcObject = stream;
                selfView.style.cssText = 'position:fixed; bottom:10px; right:10px; width:150px; border:2px solid #ccc; z-index:1000; border-radius:6px;';
                this.container.appendChild(selfView);
            }
            playSound('streamUp');
            this.updateLayout();
            return;
        }

        playSound('streamUp');
        this.showToast(`${this._peerNickname(peerId)} started sharing`, 'stream');

        if (!this.focusedPeerId || !this.streams[this.focusedPeerId]) {
            this.focusedPeerId = peerId;
            this.focusedVideo.srcObject = stream;
        }

        this.updateLayout();
    }

    _emojiSet = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

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

        if (!tabFocused && isFromOther) {
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

    handleVisibilityChange(blurred) {
        const myVideo = document.getElementById('self-view');
        let placeholder = document.getElementById('stream-placeholder');

        const isStreaming = !!myVideo && !!myVideo.srcObject;

        if (!isStreaming) {
            if (placeholder) placeholder.remove();
            return;
        }

        if (blurred) {
            if (myVideo) myVideo.style.display = 'none';

            if (!placeholder) {
                placeholder = document.createElement('div');
                placeholder.id = 'stream-placeholder';
                placeholder.textContent = '\u{1F7E2} Still Streaming...';
                placeholder.style.cssText = 'position:fixed; bottom:10px; right:10px; padding:10px 15px; background:#000; color:#fff; border-radius:4px; font-size:14px; z-index:1000;';
                this.videoContainer.appendChild(placeholder);
            }
        } else {
            if (myVideo) myVideo.style.display = 'block';
            if (placeholder) placeholder.remove();

            if (document.hasFocus()) {
                const indicator = document.getElementById('new-message-indicator');
                if (indicator) indicator.classList.add('hidden');
            }
        }
    }

    updateLayout() {
        const remoteStreams = Object.keys(this.streams).filter(id => id !== 'me');
        const spinner = document.getElementById('spinner');
        const gridBtn = document.getElementById('grid-toggle');

        if (remoteStreams.length === 0) {
            spinner.classList.remove('hidden');
            this.focusedView.style.display = 'none';
            this.gridView.style.display = 'none';
            if (gridBtn) gridBtn.style.display = 'none';
            return;
        }

        spinner.classList.add('hidden');

        if (gridBtn) {
            gridBtn.style.display = 'flex';
        }

        if (this.viewMode === 'grid') {
            this.focusedView.style.display = 'none';
            this.gridView.style.display = 'grid';
            this.buildGrid();
        } else {
            if (!this.focusedPeerId || !this.streams[this.focusedPeerId]) {
                this.focusedPeerId = remoteStreams[0];
                this.focusedVideo.srcObject = this.streams[remoteStreams[0]];
            }
            this.focusedView.style.display = 'flex';
            this.gridView.style.display = 'none';
        }
    }

    removeStream(peerId) {
        delete this.streams[peerId];
        this.removeAudio(peerId);

        if (peerId === 'me') {
            const selfView = document.getElementById('self-view');
            if (selfView) {
                playSound('streamDown');
                selfView.remove();
            }
        } else {
            playSound('streamDown');

            if (this.focusedPeerId === peerId) {
                this.focusedPeerId = null;
                this.focusedVideo.srcObject = null;
                const remaining = Object.keys(this.streams).filter(id => id !== 'me');
                if (remaining.length > 0) {
                    this.focusedPeerId = remaining[0];
                    this.focusedVideo.srcObject = this.streams[remaining[0]];
                }
            }
        }

        const placeholder = document.getElementById('stream-placeholder');
        if (placeholder) placeholder.remove();

        this.updateLayout();
    }
}
