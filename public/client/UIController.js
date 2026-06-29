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

    addParticipant(peerId) {
        const container = document.getElementById('participants');
        if (document.getElementById(`participant-${peerId}`)) return;

        const card = document.createElement('div');
        card.id = `participant-${peerId}`;
        card.className = 'participant-card';

        const avatarWrap = document.createElement('div');
        avatarWrap.className = 'relative flex-shrink-0';

        const avatar = document.createElement('div');
        avatar.className = 'flex items-center justify-center w-9 h-9 rounded-full bg-indigo-600/30 border-2 border-indigo-500/40 text-white text-xs font-bold select-none';
        avatar.textContent = peerId.substring(0, 2).toUpperCase();

        const micDot = document.createElement('div');
        micDot.className = 'participant-mic absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center border-2 border-neutral-900';
        micDot.style.cssText = 'background:#ef4444; color:white;';
        micDot.innerHTML = this._micOffSvg();

        avatarWrap.appendChild(avatar);
        avatarWrap.appendChild(micDot);

        const info = document.createElement('div');
        info.className = 'flex flex-col min-w-0';

        const name = document.createElement('span');
        name.className = 'participant-name text-sm font-medium text-neutral-200 truncate';
        name.textContent = peerId.substring(0, 8);

        const status = document.createElement('div');
        status.className = 'participant-status-icons flex items-center gap-1 mt-0.5';

        const micLabel = document.createElement('span');
        micLabel.className = 'participant-mic-label text-[10px] text-neutral-500';
        micLabel.textContent = 'Muted';
        status.appendChild(micLabel);

        info.appendChild(name);
        info.appendChild(status);

        card.appendChild(avatarWrap);
        card.appendChild(info);
        container.appendChild(card);
        this._updateMemberCount();
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
        const nameEl = el.querySelector('.participant-name');
        if (nameEl && nickname) nameEl.textContent = nickname;
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

    addChatMessage(sender, text) {
        const chatLog = document.getElementById('chat-log');
        const msgContainer = document.createElement('div');

        const raw = marked.parse(text);
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        msgContainer.innerHTML = `<div class="px-4 py-2 hover:bg-white/2 text-sm transition-colors"><div class="flex justify-between items-baseline mb-0.5"><span class="font-medium text-indigo-400 text-xs">${sender}</span><span class="text-neutral-600 text-[10px]">${timestamp}</span></div><div class="chat-markdown prose prose-invert text-neutral-300">${raw}</div></div>`;
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
