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
        this.setupZoom();
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
    }

    removePeer(peerId) {
        playSound('peerLeft');
        this.removeAudio(peerId);
        this.removeParticipant(peerId);
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

        if (!this.focusedPeerId || !this.streams[this.focusedPeerId]) {
            this.focusedPeerId = peerId;
            this.focusedVideo.srcObject = stream;
        }

        this.updateLayout();
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

    addChatMessage(sender, text) {
        const chatLog = document.getElementById('chat-log');
        const msgContainer = document.createElement('div');

        const raw = marked.parse(text);
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const isSelf = sender === 'Me';
        const initial = isSelf ? (localStorage.getItem('nickname') || 'Me').charAt(0).toUpperCase() : sender.charAt(0).toUpperCase();
        const color = isSelf ? '#22c55e' : this._colorForName(sender);
        msgContainer.innerHTML = `<div class="chat-message px-4 py-2 text-sm"><div class="flex items-center gap-2 mb-0.5"><span class="chat-avatar" style="background:${color}">${initial}</span><span class="chat-sender font-medium text-xs" style="color:${color}">${sender}</span><span class="chat-timestamp text-[10px] ml-auto shrink-0">${timestamp}</span></div><div class="chat-markdown chat-body prose ml-7">${raw}</div></div>`;
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
        const newMessageIndicator = document.getElementById('new-message-indicator');
        const chatInput = document.getElementById('chat-input');
        const threshold = chatInput.scrollHeight + 50;
        const isAtBottom = (chatLog.scrollTop + chatLog.clientHeight) >= (chatLog.scrollHeight - threshold);
        if (isAtBottom) {
            newMessageIndicator.classList.add('hidden');
            requestAnimationFrame(() => {
                chatLog.scrollTo({ top: chatLog.scrollHeight, behavior: 'smooth' });
            });
        } else {
            if (sender != 'Me') {
                newMessageIndicator.classList.remove('hidden');
                playSound('newMessage');
            }
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
