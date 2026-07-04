import { playSound } from './SoundPlayer.js';
import { ChatUI } from './ChatUI.js';
import { escapeHtml } from './escapeHtml.js';

export class UIController {
    constructor() {
        this.container = document.getElementById('videos');
        this.chatLog = document.getElementById('chat-log');
        this.videoContainer = document.getElementById('videos');
        this.focusedView = document.getElementById('focused-view');
        this.focusedVideo = document.getElementById('focused-video');
        this.pipButton = document.getElementById('pip-button');
        this.gridView = document.getElementById('grid-view');
        this.streams = {};
        this.watchedTiles = new Set();
        this._watchOrder = [];
        this._watchSentState = new Map();
        this.maxWatchedTiles = 6;
        this.onWatchChange = null;
        this.onPipExit = null;
        this.focusedPeerId = null;
        this.autoFocusPaused = false;
        this.viewMode = 'grid'; // 'focus' or 'grid'
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.isPanning = false;
        this.chat = new ChatUI({ getNickname: (id) => this._peerNickname(id) });
        this._sharedFiles = [];
        this.setupZoom();
        this.setupPictureInPicture();
        this._createToastContainer();
        this._initFilesTab();
    }

    // --- Files tab ---

    _initFilesTab() {
        document.getElementById('tab-chat').addEventListener('click', () => this._switchTab('chat'));
        document.getElementById('tab-files').addEventListener('click', () => this._switchTab('files'));
        document.getElementById('files-download-all').addEventListener('click', () => this._downloadAllFiles());
    }

    _switchTab(tab) {
        const toChat = tab === 'chat';
        document.getElementById('chat-tab-content').classList.toggle('hidden', !toChat);
        document.getElementById('files-tab-content').classList.toggle('hidden', toChat);
        const chatBtn = document.getElementById('tab-chat');
        const filesBtn = document.getElementById('tab-files');
        chatBtn.classList.toggle('border-indigo-500', toChat);
        chatBtn.classList.toggle('text-foreground', toChat);
        chatBtn.classList.toggle('border-transparent', !toChat);
        chatBtn.classList.toggle('text-muted', !toChat);
        filesBtn.classList.toggle('border-indigo-500', !toChat);
        filesBtn.classList.toggle('text-foreground', !toChat);
        filesBtn.classList.toggle('border-transparent', toChat);
        filesBtn.classList.toggle('text-muted', toChat);
    }

    _addFileToTab(entry) {
        this._sharedFiles.push(entry);
        document.getElementById('files-empty-state').classList.add('hidden');
        const badge = document.getElementById('files-tab-badge');
        badge.textContent = this._sharedFiles.length;
        badge.classList.remove('hidden');
        badge.classList.add('flex');
        if (this._sharedFiles.length >= 2) {
            document.getElementById('files-download-wrap').classList.remove('hidden');
        }
        const isImage = /^image\//i.test(entry.fileType);
        const fileIconSvg = isImage
            ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path fill-rule="evenodd" d="M1 5.25A2.25 2.25 0 0 1 3.25 3h13.5A2.25 2.25 0 0 1 19 5.25v9.5A2.25 2.25 0 0 1 16.75 17H3.25A2.25 2.25 0 0 1 1 14.75v-9.5Zm1.5 5.81v3.69c0 .414.336.75.75.75h13.5a.75.75 0 0 0 .75-.75v-2.69l-2.22-2.219a.75.75 0 0 0-1.06 0l-1.91 1.909-.48-.480a.75.75 0 0 0-1.06 0L4.5 14.06l-2-2ZM5 8.5a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Z" clip-rule="evenodd" /></svg>`
            : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l4.122 4.12A1.5 1.5 0 0 1 17 7.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" /></svg>`;

        const row = document.createElement('div');
        row.className = 'flex items-center gap-3 p-2.5 rounded-lg surface-input';
        row.innerHTML = `
            <div class="shrink-0 w-8 h-8 rounded flex items-center justify-center bg-white/5 text-muted">${fileIconSvg}</div>
            <div class="flex-1 min-w-0">
                <div class="text-sm font-medium truncate">${escapeHtml(entry.fileName)}</div>
                <div class="text-[10px] text-muted">${escapeHtml(entry.sender)} · ${this._formatFileSize(entry.fileSize)}</div>
            </div>
            <button class="shrink-0 p-1.5 rounded text-muted hover:text-foreground transition-colors" title="Download"></button>
        `;
        const dlBtn = row.querySelector('button');
        dlBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z"/><path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z"/></svg>`;
        dlBtn.addEventListener('click', () => {
            const url = URL.createObjectURL(entry.blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = entry.fileName;
            a.click();
            URL.revokeObjectURL(url);
        });
        document.getElementById('files-list').appendChild(row);
    }

    async _downloadAllFiles() {
        if (!this._sharedFiles.length || typeof JSZip === 'undefined') return;
        const zip = new JSZip();
        const seen = {};
        this._sharedFiles.forEach(f => {
            let name = f.fileName;
            if (seen[name] !== undefined) {
                seen[name]++;
                const dot = name.lastIndexOf('.');
                name = dot > 0
                    ? name.slice(0, dot) + ` (${seen[name]})` + name.slice(dot)
                    : `${name} (${seen[name]})`;
            } else {
                seen[name] = 0;
            }
            zip.file(name, f.blob);
        });
        const content = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'peek-files.zip';
        a.click();
        URL.revokeObjectURL(url);
    }

    _formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }

    // --- Chat proxies (keeps App.js / PeerManager call signatures unchanged) ---

    set _onReaction(fn) { this.chat._onReaction = fn; }
    set onPollVote(fn) { this.chat.onPollVote = fn; }
    addChatMessage(...a) { return this.chat.addChatMessage(...a); }
    addPollMessage(...a) { return this.chat.addPollMessage(...a); }
    updatePollVote(...a) { return this.chat.updatePollVote(...a); }
    addFileMessage(sender, fileId, fileName, fileSize, fileType, blobUrl, blob) {
        this.chat.addFileMessage(sender, fileId, fileName, fileSize, fileType, blobUrl);
        if (blob) this._addFileToTab({ fileId, fileName, fileSize, fileType, blob, sender });
    }
    showFileOffer(...a) { return this.chat.showFileOffer(...a); }
    updateFileProgress(...a) { return this.chat.updateFileProgress(...a); }
    removeFileProgress(...a) { return this.chat.removeFileProgress(...a); }
    addReaction(...a) { return this.chat.addReaction(...a); }
    setReplyTo(...a) { return this.chat.setReplyTo(...a); }
    clearReply() { return this.chat.clearReply(); }
    getReplyTo() { return this.chat.getReplyTo(); }
    addPendingFiles(...a) { return this.chat.addPendingFiles(...a); }
    getPendingFiles() { return this.chat.getPendingFiles(); }
    clearPendingFiles() { return this.chat.clearPendingFiles(); }
    updateTypingIndicator(...a) { return this.chat.updateTypingIndicator(...a); }

    // --- Toast ---

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
        toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-text">${escapeHtml(message)}</span>`;
        container.appendChild(toast);

        while (container.children.length > 5) {
            container.removeChild(container.firstChild);
        }

        setTimeout(() => {
            toast.classList.add('toast-out');
            toast.addEventListener('animationend', () => toast.remove());
        }, 4000);
    }

    // --- Zoom / pan (focused view) ---

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

        view.addEventListener('click', () => {
            if (this.zoom <= 1) this.setViewMode('grid');
        });
    }

    // --- Native picture-in-picture (focused view floats over other windows) ---

    setupPictureInPicture() {
        if (!this.pipButton) return;
        if (!document.pictureInPictureEnabled || !this.focusedVideo.requestPictureInPicture) {
            this.pipButton.style.display = 'none';
            return;
        }

        this.pipButton.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePictureInPicture();
        });

        // Closing the floating PiP window (its own close button, not our toggle)
        // while the tab is still hidden should resume the tab-hidden video pause.
        this.focusedVideo.addEventListener('leavepictureinpicture', () => {
            if (this.onPipExit) this.onPipExit();
        });
    }

    async togglePictureInPicture() {
        try {
            if (document.pictureInPictureElement === this.focusedVideo) {
                await document.exitPictureInPicture();
            } else {
                await this.focusedVideo.requestPictureInPicture();
            }
        } catch (err) {
            this.showToast('Picture-in-picture is unavailable right now', 'info');
        }
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

    // --- View mode ---

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

        this._watchTile(peerId);
        this.focusedPeerId = peerId;
        this.focusedVideo.srcObject = stream;
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.applyTransform();
        this.setViewMode('focus');
    }

    // Called from PeerManager's active-speaker detection. Opt-in (localStorage
    // 'followActiveSpeaker'), only while already in focus view (never forces a
    // view-mode switch), and backs off once the user manually pins someone by
    // clicking a grid tile — re-saving the setting in Settings resumes it.
    autoFocusTo(peerId) {
        if (localStorage.getItem('followActiveSpeaker') !== '1') return;
        if (this.autoFocusPaused) return;
        if (this.viewMode !== 'focus') return;
        if (peerId === this.focusedPeerId) return;
        if (!this.streams[peerId]) return;
        this.focusStream(peerId);
    }

    // --- Watched-tile tracking (drives bandwidth-saving pause/resume signalling) ---

    // Marks a stream as watched, evicting the least-recently-watched tile if over
    // maxWatchedTiles. Returns the list of streamKeys evicted as a result, so callers
    // (grid cell click handlers) can re-render those cells as placeholders.
    _watchTile(streamKey) {
        const evicted = [];
        if (!this.watchedTiles.has(streamKey)) {
            while (this._watchOrder.length >= this.maxWatchedTiles) {
                const oldest = this._watchOrder.shift();
                this._setWatched(oldest, false);
                evicted.push(oldest);
            }
        } else {
            const idx = this._watchOrder.indexOf(streamKey);
            if (idx !== -1) this._watchOrder.splice(idx, 1);
        }
        this._watchOrder.push(streamKey);
        this._setWatched(streamKey, true);

        if (evicted.length > 0) {
            const nicknames = evicted.map(key => {
                const isCam = key.endsWith('-cam');
                return this._peerNickname(isCam ? key.slice(0, -4) : key);
            });
            this.showToast(`Paused ${nicknames.join(', ')} to save bandwidth (max ${this.maxWatchedTiles} watching)`, 'info');
        }

        return evicted;
    }

    _setWatched(streamKey, watched) {
        if (watched) this.watchedTiles.add(streamKey);
        else this.watchedTiles.delete(streamKey);

        if (this._watchSentState.get(streamKey) === watched) return;
        this._watchSentState.set(streamKey, watched);
        if (this.onWatchChange) this.onWatchChange(streamKey, watched);
    }

    // Explicit user-initiated "stop watching" (the grid tile's stop button). Unlike
    // eviction this also drops the LRU bookkeeping entry, since the slot is freed
    // intentionally rather than reassigned to a newer tile.
    _unwatchTile(streamKey) {
        const idx = this._watchOrder.indexOf(streamKey);
        if (idx !== -1) this._watchOrder.splice(idx, 1);
        this._setWatched(streamKey, false);
    }

    // --- Stream grid ---

    buildGrid() {
        this.gridView.innerHTML = '';
        const remoteIds = Object.keys(this.streams).filter(id => id !== 'me' && id !== 'me-cam');
        const count = remoteIds.length;
        if (count === 0) return;

        if (count <= 1) {
            this._watchTile(remoteIds[0]);
        } else {
            remoteIds.forEach(id => {
                if (this._watchOrder.includes(id)) this._setWatched(id, true);
                else if (!this.watchedTiles.has(id)) this._setWatched(id, false);
            });
        }

        const cols = count <= 1 ? 1 : 2;
        const rows = Math.ceil(count / cols);
        this.gridView.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        this.gridView.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

        remoteIds.forEach(peerId => {
            this.gridView.appendChild(this._buildGridCell(peerId));
        });
    }

    _buildGridCell(peerId) {
        const isCam = peerId.endsWith('-cam');
        const actualPeerId = isCam ? peerId.slice(0, -4) : peerId;
        const nickname = this._peerNickname(actualPeerId);

        const cell = document.createElement('div');
        cell.className = 'relative overflow-hidden cursor-pointer bg-black flex items-center justify-center';
        cell.dataset.peerId = peerId;

        const label = document.createElement('div');
        label.className = 'absolute bottom-2 left-2 text-xs text-white/80 bg-black/40 px-2 py-0.5 rounded-full pointer-events-none';
        label.textContent = nickname + (isCam ? ' · Cam' : '');

        if (this.watchedTiles.has(peerId)) {
            const video = document.createElement('video');
            video.muted = true;
            video.autoplay = true;
            video.playsInline = true;
            video.srcObject = this.streams[peerId];
            video.className = 'w-full h-full object-contain';
            cell.appendChild(video);
            cell.appendChild(label);

            const stopBtn = document.createElement('button');
            stopBtn.type = 'button';
            stopBtn.title = 'Stop watching';
            stopBtn.className = 'absolute top-2 right-2 text-xs text-white/80 bg-black/40 hover:bg-black/60 px-2 py-0.5 rounded-full transition-colors';
            stopBtn.textContent = 'Stop watching';
            stopBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._unwatchTile(peerId);
                cell.replaceWith(this._buildGridCell(peerId));
            });
            cell.appendChild(stopBtn);

            cell.addEventListener('click', () => {
                this.autoFocusPaused = true;
                this.focusStream(peerId);
            });
        } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'flex flex-col items-center gap-1.5 pointer-events-none px-2 text-center';

            const avatar = document.createElement('div');
            avatar.className = 'w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white/80';
            avatar.innerHTML = isCam
                ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-6 h-6"><path d="M3.25 4A2.25 2.25 0 0 0 1 6.25v7.5A2.25 2.25 0 0 0 3.25 16h6.5A2.25 2.25 0 0 0 12 13.75v-1.638l3.058 1.892c.745.461 1.71-.074 1.71-.95V7.446c0-.876-.965-1.41-1.71-.95L12 8.388V6.25A2.25 2.25 0 0 0 9.75 4h-6.5Z" /></svg>'
                : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-6 h-6"><path fill-rule="evenodd" d="M2 4.25A2.25 2.25 0 0 1 4.25 2h11.5A2.25 2.25 0 0 1 18 4.25v8.5A2.25 2.25 0 0 1 15.75 15h-3.105a3.501 3.501 0 0 0 1.1 1.677A.75.75 0 0 1 13.26 18H6.74a.75.75 0 0 1-.484-1.323A3.501 3.501 0 0 0 7.355 15H4.25A2.25 2.25 0 0 1 2 12.75v-8.5Zm1.5 0a.75.75 0 0 1 .75-.75h11.5a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-.75.75H4.25a.75.75 0 0 1-.75-.75v-7.5Z" clip-rule="evenodd" /></svg>';

            const nameLine = document.createElement('div');
            nameLine.className = 'text-sm font-medium text-white/90 truncate max-w-[10rem]';
            nameLine.textContent = nickname;

            const typeLine = document.createElement('div');
            typeLine.className = 'text-xs text-white/50';
            typeLine.textContent = isCam ? 'Webcam' : 'Screen share';

            const hint = document.createElement('div');
            hint.className = 'text-xs text-white/40 mt-1';
            hint.textContent = 'Click to watch';

            placeholder.appendChild(avatar);
            placeholder.appendChild(nameLine);
            placeholder.appendChild(typeLine);
            placeholder.appendChild(hint);
            cell.appendChild(placeholder);
            cell.appendChild(label);

            cell.addEventListener('click', () => {
                const evicted = this._watchTile(peerId);
                cell.replaceWith(this._buildGridCell(peerId));
                evicted.forEach(key => {
                    const evictedCell = this.gridView.querySelector(`[data-peer-id="${key}"]`);
                    if (evictedCell) evictedCell.replaceWith(this._buildGridCell(key));
                });
            });
        }

        return cell;
    }

    // --- Peers ---

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
        this.chat.updateTypingIndicator(peerId, false);
        this.showToast(`${name} left`, 'leave');
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

        if (!isSelf) {
            const sigSep = document.createElement('span');
            sigSep.className = 'text-[10px] text-muted';
            sigSep.textContent = '·';
            statusRow.appendChild(sigSep);

            const sigIcon = document.createElement('span');
            sigIcon.className = 'participant-signal-icon inline-flex items-center';
            sigIcon.title = 'Connection: Unknown';
            sigIcon.innerHTML = this._signalBarsSvg('unknown');
            statusRow.appendChild(sigIcon);
        }

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

    _signalBarsSvg(tier) {
        const dim = '#374151';
        const c = {
            excellent: ['#22c55e', '#22c55e', '#22c55e'],
            good:      ['#84cc16', '#84cc16', dim],
            fair:      ['#eab308', dim, dim],
            poor:      ['#ef4444', dim, dim],
            unknown:   [dim, dim, dim],
        }[tier] || [dim, dim, dim];
        return `<svg width="12" height="10" viewBox="0 0 12 10" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="6" width="3" height="4" rx="0.5" fill="${c[0]}"/><rect x="4.5" y="3" width="3" height="7" rx="0.5" fill="${c[1]}"/><rect x="9" y="0" width="3" height="10" rx="0.5" fill="${c[2]}"/></svg>`;
    }

    updateConnectionQuality(peerId, tier) {
        const el = document.getElementById(`participant-${peerId}`);
        if (!el) return;
        const icon = el.querySelector('.participant-signal-icon');
        if (!icon) return;
        const labels = { excellent: 'Excellent', good: 'Good', fair: 'Fair', poor: 'Poor', unknown: 'Unknown' };
        icon.title = `Connection: ${labels[tier] || 'Unknown'}`;
        icon.innerHTML = this._signalBarsSvg(tier);
    }

    removeParticipant(peerId) {
        const el = document.getElementById(`participant-${peerId}`);
        if (el) el.remove();
        this._updateMemberCount();
    }

    // Called on a fresh 'init' (first join, or a reconnect after the socket dropped).
    // Every peerId — including our own — is freshly assigned per connection, so any
    // cards left over from before the drop are now orphaned and must be cleared first,
    // or they double up alongside the newly (re)assigned ones.
    clearAllParticipants() {
        const container = document.getElementById('participants');
        if (container) container.innerHTML = '';
        this.selfPeerId = null;
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

    // --- Audio ---

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

    // --- Self-view PiPs ---

    _updateSelfViewPositions() {
        const screenView = document.getElementById('self-view');
        const camView = document.getElementById('self-cam-view');
        if (screenView && camView) {
            screenView.style.right = '170px';
            camView.style.right = '10px';
        } else if (screenView) {
            screenView.style.right = '10px';
        } else if (camView) {
            camView.style.right = '10px';
        }
    }

    addStream(peerId, stream) {
        this.streams[peerId] = stream;

        if (peerId === 'me' || peerId === 'me-cam') {
            const viewId = peerId === 'me' ? 'self-view' : 'self-cam-view';
            let selfView = document.getElementById(viewId);
            if (selfView) {
                selfView.srcObject = stream;
            } else {
                selfView = document.createElement('video');
                selfView.id = viewId;
                selfView.muted = true;
                selfView.autoplay = true;
                selfView.playsInline = true;
                selfView.srcObject = stream;
                selfView.style.cssText = 'position:fixed; bottom:10px; width:150px; border:2px solid #ccc; z-index:1000; border-radius:6px; object-fit:cover;';
                this.container.appendChild(selfView);
            }
            this._updateSelfViewPositions();
            if (peerId === 'me') playSound('streamUp');
            this.updateLayout();
            return;
        }

        playSound('streamUp');

        if (!this.focusedPeerId || !this.streams[this.focusedPeerId]) {
            this._watchTile(peerId);
            this.focusedPeerId = peerId;
            this.focusedVideo.srcObject = stream;
        }

        this.updateLayout();
    }

    removeStream(peerId) {
        delete this.streams[peerId];
        this.watchedTiles.delete(peerId);
        this._watchSentState.delete(peerId);
        const orderIdx = this._watchOrder.indexOf(peerId);
        if (orderIdx !== -1) this._watchOrder.splice(orderIdx, 1);

        if (peerId === 'me' || peerId === 'me-cam') {
            const viewId = peerId === 'me' ? 'self-view' : 'self-cam-view';
            const selfView = document.getElementById(viewId);
            if (selfView) {
                if (peerId === 'me') playSound('streamDown');
                selfView.remove();
            }
            this._updateSelfViewPositions();
            const placeholder = document.getElementById('stream-placeholder');
            if (placeholder) placeholder.remove();
            if (peerId === 'me') this.updateLayout();
            return;
        } else {
            playSound('streamDown');

            if (this.focusedPeerId === peerId) {
                this.focusedPeerId = null;
                this.focusedVideo.srcObject = null;
                const remaining = Object.keys(this.streams).filter(id => id !== 'me' && id !== 'me-cam');
                if (remaining.length > 0) {
                    this._watchTile(remaining[0]);
                    this.focusedPeerId = remaining[0];
                    this.focusedVideo.srcObject = this.streams[remaining[0]];
                }
            }
        }

        const placeholder = document.getElementById('stream-placeholder');
        if (placeholder) placeholder.remove();

        this.updateLayout();
    }

    // --- Layout ---

    updateLayout() {
        const remoteStreams = Object.keys(this.streams).filter(id => id !== 'me' && id !== 'me-cam');
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
                this._watchTile(remoteStreams[0]);
                this.focusedPeerId = remoteStreams[0];
                this.focusedVideo.srcObject = this.streams[remoteStreams[0]];
            }
            // Focus view only ever renders one stream — anything else isn't visible
            // anywhere, so pause it without dropping the _watchOrder entry (unlike
            // _unwatchTile which does both). This preserves which tiles should resume
            // when the user returns to grid view.
            remoteStreams.forEach(id => {
                if (id !== this.focusedPeerId) this._setWatched(id, false);
            });
            this.focusedView.style.display = 'flex';
            this.gridView.style.display = 'none';
        }
    }

    handleVisibilityChange(blurred) {
        const myVideo = document.getElementById('self-view');
        const myCamVideo = document.getElementById('self-cam-view');
        let placeholder = document.getElementById('stream-placeholder');

        const isStreaming = (!!myVideo && !!myVideo.srcObject) || (!!myCamVideo && !!myCamVideo.srcObject);

        if (!isStreaming) {
            if (placeholder) placeholder.remove();
            return;
        }

        if (blurred) {
            if (myVideo) myVideo.style.display = 'none';
            if (myCamVideo) myCamVideo.style.display = 'none';

            if (!placeholder) {
                placeholder = document.createElement('div');
                placeholder.id = 'stream-placeholder';
                placeholder.textContent = '\u{1F7E2} Still Streaming...';
                placeholder.style.cssText = 'position:fixed; bottom:10px; right:10px; padding:10px 15px; background:#000; color:#fff; border-radius:4px; font-size:14px; z-index:1000;';
                this.videoContainer.appendChild(placeholder);
            }
        } else {
            if (myVideo) myVideo.style.display = 'block';
            if (myCamVideo) myCamVideo.style.display = 'block';
            if (placeholder) placeholder.remove();
            this._updateSelfViewPositions();

            if (document.hasFocus()) {
                const indicator = document.getElementById('new-message-indicator');
                if (indicator) indicator.classList.add('hidden');
            }
        }
    }
}
