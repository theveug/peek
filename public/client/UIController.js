import { playSound } from './SoundPlayer.js';
import { ChatUI } from './ChatUI.js';
import { escapeHtml } from './escapeHtml.js';

/**
 * Owns everything DOM-facing for the room page: the video grid/focus stage,
 * zoom/pan, watch-tile tracking (bandwidth-saving pause/resume), self-view
 * PiPs, native picture-in-picture, participant cards (status/mic/signal/
 * volume/block/moderator controls), toasts, the files tab, and layout. Owns
 * a `ChatUI` instance and proxies its public methods so callers elsewhere
 * (App.js, PeerManager) never need to know chat is a separate class.
 */
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
        this.onModeratorAction = null; // set by App.js — (action, peerId)
        this.creatorPeerId = null;
        this.moderatorPeerIds = new Set();
        this.focusedPeerId = null;
        this.autoFocusPaused = false;
        this.viewMode = 'grid'; // 'focus' or 'grid'
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.isPanning = false;
        this.chat = new ChatUI({ getNickname: (id) => this._peerNickname(id), avatarInitials: (name) => this._avatarInitials(name) });
        // A dragged self-view PiP's saved left/top can end up off-screen after the
        // window shrinks (e.g. undocking to a smaller monitor) — reclamp on resize.
        window.addEventListener('resize', () => {
            ['self-view', 'self-cam-view'].forEach(id => {
                const el = document.getElementById(id);
                if (el?.dataset.dragged) this._reclampDraggedPip(el, id);
            });
        });
        this._sharedFiles = [];
        this.maxPeers = 6;
        this.roomName = null;
        // Local-only playback volume per remote peer (0-1, default 1). Not
        // persisted: peerIds are freshly assigned every reconnect, so a
        // localStorage entry keyed by peerId would never be looked up again.
        this.peerVolumes = new Map();
        // Local-only block list: hides a peer's video/audio/chat/reactions/files/polls
        // until unblocked. Same non-persistence rationale as peerVolumes above — cleared
        // in clearAllParticipants(), never written to localStorage.
        this.blockedPeerIds = new Set();
        // Overall call volume, multiplied with each peer's own volume. This one
        // *is* persisted — it's a personal preference, not tied to any peer/session.
        this.masterCallVolume = parseFloat(localStorage.getItem('masterCallVolume'));
        if (Number.isNaN(this.masterCallVolume)) this.masterCallVolume = 1;
        this.setupZoom();
        this.setupPictureInPicture();
        this.setupFocusControls();
        this._createToastContainer();
        this._initFilesTab();
    }

    // --- Files tab ---

    /** Wires the chat/files tab switcher and the "download all" button. */
    _initFilesTab() {
        document.getElementById('tab-chat').addEventListener('click', () => this._switchTab('chat'));
        document.getElementById('tab-files').addEventListener('click', () => this._switchTab('files'));
        document.getElementById('files-download-all').addEventListener('click', () => this._downloadAllFiles());
    }

    /** @param {'chat'|'files'} tab */
    _switchTab(tab) {
        const toChat = tab === 'chat';
        document.getElementById('chat-tab-content').classList.toggle('hidden', !toChat);
        document.getElementById('files-tab-content').classList.toggle('hidden', toChat);
        document.getElementById('tab-chat').classList.toggle('active', toChat);
        document.getElementById('tab-files').classList.toggle('active', !toChat);
    }

    /**
     * Appends one finished file transfer to the Files tab's list (the tab
     * persists every file shared during the session, independent of chat's
     * message-count trimming).
     * @param {{fileId: string, fileName: string, fileSize: number, fileType: string, blob: Blob, sender: string}} entry
     * @returns {void}
     */
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
            <div class="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center file-row-icon">${fileIconSvg}</div>
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

    /** Zips (client-side, via JSZip) and downloads every file shared this session. */
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

    /** @param {number} bytes @returns {string} human-readable size, e.g. "1.2 MB". */
    _formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }

    // --- Chat proxies (keeps App.js / PeerManager call signatures unchanged) ---
    // See ChatUI.js for each proxied method's actual documentation.

    set _onReaction(fn) { this.chat._onReaction = fn; }
    set onPollVote(fn) { this.chat.onPollVote = fn; }
    addChatMessage(...a) { return this.chat.addChatMessage(...a); }
    addSystemMessage(...a) { return this.chat.addSystemMessage(...a); }
    addPollMessage(...a) { return this.chat.addPollMessage(...a); }
    updatePollVote(...a) { return this.chat.updatePollVote(...a); }

    /**
     * Proxies to `ChatUI.addFileMessage`, then also records the file in the
     * Files tab (`_addFileToTab`) when a Blob is available — the one proxy
     * here with extra behavior beyond forwarding, since the Files tab is a
     * UIController concern, not ChatUI's.
     */
    addFileMessage(sender, fileId, fileName, fileSize, fileType, blobUrl, blob, groupId) {
        this.chat.addFileMessage(sender, fileId, fileName, fileSize, fileType, blobUrl, groupId);
        if (blob) this._addFileToTab({ fileId, fileName, fileSize, fileType, blob, sender });
    }
    ensureFileGroup(...a) { return this.chat.ensureFileGroup(...a); }
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

    /** Creates the fixed-position container new toasts are appended into. */
    _createToastContainer() {
        const c = document.createElement('div');
        c.id = 'toast-container';
        c.className = 'toast-container';
        document.body.appendChild(c);
    }

    /** @param {string} peerId @returns {string} the peer's current display nickname, or a shortened peerId as a fallback. */
    _peerNickname(peerId) {
        const el = document.getElementById(`participant-${peerId}`);
        if (!el) return peerId.substring(0, 8);
        const name = el.querySelector('.participant-name');
        return name ? name.textContent : peerId.substring(0, 8);
    }

    /**
     * Only for purely local, non-room-event feedback (clipboard confirmations,
     * permission/hardware errors) — anything else peers would care about goes
     * through addSystemMessage() into the chat log instead, see CLAUDE.md.
     * @param {string} message
     * @returns {void}
     */
    showToast(message) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path fill-rule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a.75.75 0 0 0 0 1.5h.253a.25.25 0 0 1 .244.304l-.459 2.066A1.75 1.75 0 0 0 10.747 15H11a.75.75 0 0 0 0-1.5h-.253a.25.25 0 0 1-.244-.304l.459-2.066A1.75 1.75 0 0 0 9.253 9H9Z" clip-rule="evenodd" /></svg>';

        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-text">${escapeHtml(message)}</span>`;
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

    /** Wires wheel-to-zoom, drag-to-pan, double-click-to-reset, and click-to-exit-zoom on the focused view. */
    setupZoom() {
        const view = this.focusedView;
        const vid = this.focusedVideo;

        // Some mice/drivers (smooth-scroll features in Logitech Options+, Razer
        // Synapse, etc.) split one physical notch into a burst of many small
        // 'wheel' events instead of firing a single one. Applying a fixed +/-10%
        // per event compounds geometrically in that case (30 events * 1.1 is
        // enormous), so accumulate deltaY across a frame and apply one zoom step
        // sized to the total scroll magnitude instead of the event count.
        let pendingDeltaY = 0;
        let lastMouseX = 0;
        let lastMouseY = 0;
        let zoomRafId = null;

        const applyPendingZoom = () => {
            zoomRafId = null;
            const deltaY = Math.max(-500, Math.min(500, pendingDeltaY));
            pendingDeltaY = 0;

            const prevZoom = this.zoom;
            const factor = Math.exp(-deltaY * 0.001);
            this.zoom = Math.max(1, Math.min(10, this.zoom * factor));

            const scale = this.zoom / prevZoom;
            this.panX = lastMouseX - scale * (lastMouseX - this.panX);
            this.panY = lastMouseY - scale * (lastMouseY - this.panY);

            if (this.zoom <= 1) { this.panX = 0; this.panY = 0; this.zoom = 1; }
            this.clampPan();
            this.applyTransform();
        };

        view.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = vid.getBoundingClientRect();
            lastMouseX = e.clientX - rect.left;
            lastMouseY = e.clientY - rect.top;

            pendingDeltaY += e.deltaY;
            if (zoomRafId === null) {
                zoomRafId = requestAnimationFrame(applyPendingZoom);
            }
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

    /** Wires the PiP button (hidden if the browser lacks PiP support) and the leave-PiP callback. */
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

    /** Enters/exits native picture-in-picture for the focused video. */
    async togglePictureInPicture() {
        try {
            if (document.pictureInPictureElement === this.focusedVideo) {
                await document.exitPictureInPicture();
            } else {
                await this.focusedVideo.requestPictureInPicture();
            }
        } catch (err) {
            this.showToast('Picture-in-picture is unavailable right now');
        }
    }

    /** Clamps `panX`/`panY` so the zoomed video can't be panned past its own edges. */
    clampPan() {
        const vid = this.focusedVideo;
        const viewRect = this.focusedView.getBoundingClientRect();
        const scaledW = vid.videoWidth ? Math.min(vid.clientWidth, viewRect.width) * this.zoom : viewRect.width * this.zoom;
        const scaledH = vid.videoHeight ? Math.min(vid.clientHeight, viewRect.height) * this.zoom : viewRect.height * this.zoom;

        this.panX = Math.min(0, Math.max(viewRect.width - scaledW, this.panX));
        this.panY = Math.min(0, Math.max(viewRect.height - scaledH, this.panY));
    }

    /** Applies the current zoom/pan as a CSS transform on the focused video. */
    applyTransform() {
        this.focusedVideo.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
        this.focusedView.style.cursor = this.zoom > 1 ? 'grab' : '';
    }

    // --- View mode ---

    /** @param {'grid'|'focus'} mode */
    setViewMode(mode) {
        this.viewMode = mode;
        this.updateLayout();
    }

    /** Flips between grid and focus view. */
    toggleViewMode() {
        this.setViewMode(this.viewMode === 'focus' ? 'grid' : 'focus');
    }

    /**
     * Switches to focus view on the given stream: marks it watched, resets
     * zoom/pan, and updates the focus caption/watch-state overlay.
     * @param {string} peerId
     * @returns {void}
     */
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
        this._updateFocusMeta(peerId);
        this._renderFocusWatchState();
    }

    /** Updates the focus view's bottom-left caption (nickname · resolution) for `peerId`. */
    _updateFocusMeta(peerId) {
        const isCam = peerId.endsWith('-cam');
        const actualPeerId = isCam ? peerId.slice(0, -4) : peerId;
        const nickname = this._peerNickname(actualPeerId);

        const captionText = document.getElementById('focus-caption-text');
        const video = this.focusedVideo;
        const updateCaption = () => {
            if (!captionText) return;
            const { videoWidth: w, videoHeight: h } = video;
            captionText.textContent = w && h ? `${nickname} · ${w}x${h}` : nickname;
        };
        updateCaption();
        video.onloadedmetadata = updateCaption;
    }

    /**
     * Toggles the focused pane between the live video (+ caption/icon-button
     * overlay) and the same "paused · click to watch" placeholder grid tiles use,
     * based on whether the focused peer's stream is currently watched. Driven by
     * the focus stop/resume controls below and re-applied on every updateLayout()
     * pass so it can't drift out of sync with watchedTiles.
     * @returns {void}
     */
    _renderFocusWatchState() {
        const paused = !!this.focusedPeerId && !this.watchedTiles.has(this.focusedPeerId);
        const overlay = document.getElementById('focus-paused-overlay');
        if (overlay) overlay.style.display = paused ? 'flex' : 'none';
        this.focusedVideo.style.visibility = paused ? 'hidden' : 'visible';
        const caption = document.getElementById('focus-quality-caption');
        if (caption) caption.style.display = paused ? 'none' : 'flex';
        const btnGroup = document.getElementById('focus-icon-btn-group');
        if (btnGroup) btnGroup.style.display = paused ? 'none' : 'flex';
    }

    /**
     * Wires the focus view's "stop watching" button and the paused-overlay's
     * click-to-resume — separate from setupPictureInPicture() since PiP is
     * feature-gated (may not exist) while these controls always do.
     * @returns {void}
     */
    setupFocusControls() {
        document.getElementById('focus-stop-button')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!this.focusedPeerId) return;
            this._unwatchTile(this.focusedPeerId);
            this._renderFocusWatchState();
        });

        document.getElementById('focus-paused-overlay')?.addEventListener('click', () => {
            if (!this.focusedPeerId) return;
            this._watchTile(this.focusedPeerId);
            this.focusedVideo.srcObject = this.streams[this.focusedPeerId];
            this._renderFocusWatchState();
        });
    }

    /**
     * Called from PeerManager's active-speaker detection. Opt-in (localStorage
     * 'followActiveSpeaker'), only while already in focus view (never forces a
     * view-mode switch), and backs off once the user manually pins someone by
     * clicking a grid tile — re-saving the setting in Settings resumes it.
     * @param {string} peerId
     * @returns {void}
     */
    autoFocusTo(peerId) {
        if (localStorage.getItem('followActiveSpeaker') !== '1') return;
        if (this.autoFocusPaused) return;
        if (this.viewMode !== 'focus') return;
        if (peerId === this.focusedPeerId) return;
        if (!this.streams[peerId]) return;
        this.focusStream(peerId);
    }

    // --- Watched-tile tracking (drives bandwidth-saving pause/resume signalling) ---

    /**
     * Marks a stream as watched, evicting the least-recently-watched tile if over
     * maxWatchedTiles.
     * @param {string} streamKey
     * @returns {string[]} streamKeys evicted as a result, so callers (grid cell
     *   click handlers) can re-render those cells as placeholders.
     */
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
            this.addSystemMessage(`Paused ${nicknames.join(', ')} to save bandwidth (max ${this.maxWatchedTiles} watching)`, 'stream');
        }

        return evicted;
    }

    /**
     * Updates `watchedTiles` and fires `onWatchChange` only on a real
     * transition (not a redundant call), which is what actually triggers the
     * `watch-stream`/`unwatch-stream` signal to the owning peer.
     * @param {string} streamKey
     * @param {boolean} watched
     * @returns {void}
     */
    _setWatched(streamKey, watched) {
        if (watched) this.watchedTiles.add(streamKey);
        else this.watchedTiles.delete(streamKey);

        if (this._watchSentState.get(streamKey) === watched) return;
        this._watchSentState.set(streamKey, watched);
        if (this.onWatchChange) this.onWatchChange(streamKey, watched);
    }

    /**
     * Explicit user-initiated "stop watching" (the grid tile's stop button). Unlike
     * eviction this also drops the LRU bookkeeping entry, since the slot is freed
     * intentionally rather than reassigned to a newer tile.
     * @param {string} streamKey
     * @returns {void}
     */
    _unwatchTile(streamKey) {
        const idx = this._watchOrder.indexOf(streamKey);
        if (idx !== -1) this._watchOrder.splice(idx, 1);
        this._setWatched(streamKey, false);
    }

    // --- Stream grid ---

    /**
     * Rebuilds the entire grid view from `this.streams`: excludes self-views
     * and blocked peers, auto-watches the sole stream when there's only one,
     * and lays out a 1 or 2-column grid.
     * @returns {void}
     */
    buildGrid() {
        this.gridView.innerHTML = '';
        const remoteIds = Object.keys(this.streams).filter(id => id !== 'me' && id !== 'me-cam' && !this.isBlocked(id));
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

    /**
     * Builds one grid tile: either the live video (with mic icon, resolution
     * badge, and stop-watching button, if this stream is currently watched)
     * or a "paused · click to watch" placeholder otherwise.
     * @param {string} peerId - a stream key: bare peerId for screen share, `${peerId}-cam` for webcam.
     * @returns {HTMLElement}
     */
    _buildGridCell(peerId) {
        const isCam = peerId.endsWith('-cam');
        const actualPeerId = isCam ? peerId.slice(0, -4) : peerId;
        const nickname = this._peerNickname(actualPeerId);
        const micEnabled = this._micEnabled?.[actualPeerId] ?? false;

        const cell = document.createElement('div');
        cell.className = 'grid-tile relative overflow-hidden cursor-pointer bg-black flex items-center justify-center min-h-0 min-w-0';
        cell.dataset.peerId = peerId;

        const label = document.createElement('div');
        label.className = 'grid-tile-name absolute bottom-2.5 left-2.5 flex items-center gap-1.5 text-xs font-medium text-white pointer-events-none';

        const micIcon = document.createElement('span');
        micIcon.className = 'grid-tile-mic inline-flex items-center';
        micIcon.style.color = micEnabled ? '#22c55e' : '#ef4444';
        micIcon.innerHTML = micEnabled ? this._micOnSvg() : this._micOffSvg();
        label.appendChild(micIcon);

        const labelText = document.createElement('span');
        labelText.textContent = nickname + (isCam ? ' · Cam' : '');
        label.appendChild(labelText);

        if (this.watchedTiles.has(peerId)) {
            const video = document.createElement('video');
            video.muted = true;
            video.autoplay = true;
            video.playsInline = true;
            video.srcObject = this.streams[peerId];
            video.className = 'w-full h-full object-contain';
            cell.appendChild(video);
            cell.appendChild(label);

            if (!isCam) {
                const badge = document.createElement('div');
                badge.className = 'grid-tile-badge';
                badge.innerHTML = '<span class="material-symbols-rounded">screen_share</span>';
                const badgeText = document.createElement('span');
                badge.appendChild(badgeText);
                const updateBadge = () => {
                    if (video.videoWidth && video.videoHeight) badgeText.textContent = `${video.videoHeight}p`;
                };
                updateBadge();
                video.addEventListener('loadedmetadata', updateBadge);
                cell.appendChild(badge);
            }

            const stopBtn = document.createElement('button');
            stopBtn.type = 'button';
            stopBtn.title = 'Stop watching';
            stopBtn.className = 'grid-tile-stop-btn';
            stopBtn.innerHTML = '<span class="material-symbols-rounded">close</span>';
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
            const overlay = document.createElement('div');
            overlay.className = 'grid-tile-paused-overlay';

            const playCircle = document.createElement('span');
            playCircle.className = 'grid-tile-play-circle';
            playCircle.innerHTML = '<span class="material-symbols-rounded">play_arrow</span>';

            const hint = document.createElement('span');
            hint.className = 'grid-tile-paused-hint';
            hint.textContent = 'Click to watch';

            const sub = document.createElement('span');
            sub.className = 'grid-tile-paused-sub';
            sub.textContent = 'stream paused · saving bandwidth';

            overlay.appendChild(playCircle);
            overlay.appendChild(hint);
            overlay.appendChild(sub);
            cell.appendChild(overlay);
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

    /**
     * Handles a new peer joining: plays a sound, adds their participant
     * card immediately, and (after a short delay, to let their real
     * nickname arrive first) posts a "joined" system message.
     * @param {string} peerId
     * @returns {void}
     */
    addPeer(peerId) {
        playSound('peerJoin');
        this.addParticipant(peerId);
        if (!this._pendingJoinToasts) this._pendingJoinToasts = new Set();
        this._pendingJoinToasts.add(peerId);
        setTimeout(() => {
            if (this._pendingJoinToasts.has(peerId)) {
                this._pendingJoinToasts.delete(peerId);
                this.addSystemMessage(`${this._peerNickname(peerId)} joined`, 'join');
            }
        }, 2000);
    }

    /**
     * Handles a peer leaving: plays a sound, removes their audio element and
     * participant card, clears their typing indicator, and posts a "left"
     * system message.
     * @param {string} peerId
     * @returns {void}
     */
    removePeer(peerId) {
        const name = this._peerNickname(peerId);
        playSound('peerLeft');
        this.removeAudio(peerId);
        this.removeParticipant(peerId);
        this.chat.updateTypingIndicator(peerId, false);
        this.addSystemMessage(`${name} left`, 'leave');
    }

    /**
     * Creates the local user's own participant card (idempotent) and
     * populates the top-bar identity pill.
     * @param {string} peerId
     * @returns {void}
     */
    addSelf(peerId) {
        if (document.getElementById(`participant-${peerId}`)) return;
        this.selfPeerId = peerId;
        const nickname = localStorage.getItem('nickname') || 'You';
        this._createParticipantCard(peerId, nickname, true);

        const topbarName = document.getElementById('topbar-identity-name');
        const topbarAvatar = document.getElementById('topbar-identity-avatar');
        if (topbarName) topbarName.textContent = nickname;
        if (topbarAvatar) {
            topbarAvatar.textContent = this._avatarInitials(nickname);
            topbarAvatar.style.background = this._avatarSquareColor(peerId, true);
        }
    }

    /**
     * Creates a remote peer's participant card (idempotent), initially
     * shown with a shortened-peerId placeholder name until their real
     * nickname arrives.
     * @param {string} peerId
     * @returns {void}
     */
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

    /** @param {string} displayName @returns {string} up to 2 initials, one per word. */
    _avatarInitials(displayName) {
        return displayName.split(/\s+/).map(w => w[0]).join('').substring(0, 2).toUpperCase()
            || displayName.substring(0, 2).toUpperCase();
    }

    /**
     * Deterministic per-peer hue, same algorithm as lobby.html's hueFromString()
     * (duplicated rather than shared — lobby.html and this file are separate,
     * unbundled page entry points with no shared module today).
     * @param {string} str
     * @returns {number} 0-359
     */
    _hueFromString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) % 360;
        return Math.abs(hash);
    }

    /** @returns {string} a CSS color — the accent token for self, else a deterministic per-peer hue. */
    _avatarSquareColor(peerId, isSelf) {
        if (isSelf) return 'var(--accent)';
        return `oklch(0.64 0.15 ${this._hueFromString(peerId)})`;
    }

    /**
     * Builds and inserts one participant card: avatar, status dot, crown
     * badge, name, status label, signal icon, mic icon, and (for non-self
     * cards) the volume/block controls and moderator menu.
     * @param {string} peerId
     * @param {string} displayName
     * @param {boolean} isSelf
     * @returns {void}
     */
    _createParticipantCard(peerId, displayName, isSelf) {
        const container = document.getElementById('participants');

        const card = document.createElement('div');
        card.id = `participant-${peerId}`;
        card.className = 'participant-card';
        if (isSelf) card.dataset.self = '1';

        const avatarWrap = document.createElement('div');
        avatarWrap.className = 'relative flex-shrink-0';

        const avatar = document.createElement('div');
        avatar.className = 'participant-avatar flex items-center justify-center w-9 h-9 text-white text-xs font-bold select-none';
        avatar.style.background = this._avatarSquareColor(peerId, isSelf);
        avatar.textContent = this._avatarInitials(displayName);

        const statusDot = document.createElement('div');
        statusDot.className = 'participant-status-dot absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2';
        statusDot.style.background = this._statusColors.online;
        statusDot.title = 'Online';

        const crownBadge = document.createElement('span');
        crownBadge.className = 'participant-crown material-symbols-rounded';
        crownBadge.title = peerId === this.creatorPeerId ? 'Room creator' : 'Moderator';
        crownBadge.textContent = 'workspace_premium';
        crownBadge.style.display = this.moderatorPeerIds?.has(peerId) ? '' : 'none';

        avatarWrap.appendChild(avatar);
        avatarWrap.appendChild(statusDot);
        avatarWrap.appendChild(crownBadge);

        const info = document.createElement('div');
        info.className = 'flex flex-col min-w-0 flex-1';

        const nameRow = document.createElement('div');
        nameRow.className = 'flex items-center gap-1.5';

        const name = document.createElement('span');
        name.className = 'participant-name text-sm font-medium truncate';
        name.textContent = displayName;

        nameRow.appendChild(name);

        const statusRow = document.createElement('div');
        statusRow.className = 'participant-status-icons flex items-center gap-1.5 mt-0.5';

        const statusLabel = document.createElement('span');
        statusLabel.className = 'participant-status-label text-[10px] text-emerald-400';
        statusLabel.textContent = 'Online';
        statusRow.appendChild(statusLabel);

        info.appendChild(nameRow);
        info.appendChild(statusRow);

        const rightCol = document.createElement('div');
        rightCol.className = 'participant-right-col flex flex-col items-end gap-1 flex-shrink-0';

        if (!isSelf) {
            const sigIcon = document.createElement('span');
            sigIcon.className = 'participant-signal-icon inline-flex items-center';
            sigIcon.title = 'Connection: Unknown';
            sigIcon.innerHTML = this._signalBarsSvg('unknown');
            rightCol.appendChild(sigIcon);
        }

        const micIcon = document.createElement('span');
        micIcon.className = 'participant-mic inline-flex items-center';
        micIcon.style.color = '#ef4444';
        micIcon.innerHTML = this._micOffSvg();
        rightCol.appendChild(micIcon);

        if (!isSelf) {
            rightCol.appendChild(this._buildVolumeControl(peerId));
            rightCol.appendChild(this._buildBlockControl(peerId));
        }

        card.appendChild(avatarWrap);
        card.appendChild(info);
        card.appendChild(rightCol);

        if (!isSelf) {
            const modMenu = this._buildModeratorMenu(peerId);
            const iAmModerator = !!this.selfPeerId && this.moderatorPeerIds.has(this.selfPeerId);
            modMenu.style.display = iAmModerator ? 'flex' : 'none';
            card.appendChild(modMenu);
        }

        if (isSelf) {
            container.prepend(card);
        } else {
            container.appendChild(card);
        }
        this._updateMemberCount();
    }

    /**
     * Kebab button + tiny popover for moderator-only actions on another peer's card.
     * Hidden by default — updateModeratorStatus() reveals it only when the local user
     * is themselves a moderator. Enforcement is server-side regardless (see
     * WebSocketServer.js); this is just the UI entry point.
     *
     * Menu items are (re)built fresh every time the popover opens, not once at card
     * creation — "Stop their stream" is available to any moderator (including against
     * the room creator's own card), but "Kick"/"Make moderator"/"Remove moderator" are
     * creator-only and the promote/demote label depends on the target's *current*
     * moderator membership, both of which can change after the card already exists.
     * @param {string} peerId
     * @returns {HTMLElement}
     */
    _buildModeratorMenu(peerId) {
        const wrap = document.createElement('div');
        wrap.className = 'participant-mod-menu relative flex-shrink-0';
        wrap.style.display = 'none';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'participant-mod-btn';
        btn.title = 'Moderator actions';
        btn.innerHTML = '<span class="material-symbols-rounded">more_vert</span>';

        const menu = document.createElement('div');
        menu.className = 'participant-mod-popover hidden';

        const addMenuItem = (label, action, extraClass) => {
            const item = document.createElement('button');
            item.type = 'button';
            if (extraClass) item.className = extraClass;
            item.textContent = label;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.classList.add('hidden');
                this.onModeratorAction?.(action, peerId);
            });
            menu.appendChild(item);
        };

        const renderMenuItems = () => {
            menu.innerHTML = '';
            addMenuItem('Stop their stream', 'stop-stream');

            const iAmCreator = !!this.selfPeerId && this.selfPeerId === this.creatorPeerId;
            if (iAmCreator) {
                const isTargetMod = this.moderatorPeerIds.has(peerId);
                addMenuItem(isTargetMod ? 'Remove moderator' : 'Make moderator', isTargetMod ? 'demote' : 'promote');
                addMenuItem('Kick from room', 'kick', 'participant-mod-kick');
            }
        };

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.participant-mod-popover').forEach(p => { if (p !== menu) p.classList.add('hidden'); });
            const opening = menu.classList.contains('hidden');
            if (opening) renderMenuItems();
            menu.classList.toggle('hidden');
        });

        document.addEventListener('click', (e) => {
            if (!wrap.contains(e.target)) menu.classList.add('hidden');
        });

        wrap.appendChild(btn);
        wrap.appendChild(menu);
        return wrap;
    }

    /**
     * Local playback volume for this one peer — everyone's own preference, so
     * (unlike _buildModeratorMenu) this is never gated behind moderator status.
     * @param {string} peerId
     * @returns {HTMLElement}
     */
    _buildVolumeControl(peerId) {
        const wrap = document.createElement('div');
        wrap.className = 'participant-volume-menu relative flex-shrink-0';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'participant-volume-btn';
        btn.title = 'Adjust their volume';
        btn.innerHTML = '<span class="material-symbols-rounded">volume_up</span>';

        const popover = document.createElement('div');
        popover.className = 'participant-volume-popover hidden';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '1';
        slider.step = '0.05';
        slider.value = String(this.peerVolumes.get(peerId) ?? 1);

        const valueLabel = document.createElement('span');
        valueLabel.className = 'participant-volume-value';
        valueLabel.textContent = `${Math.round(slider.value * 100)}%`;

        slider.addEventListener('input', (e) => {
            e.stopPropagation();
            const volume = parseFloat(slider.value);
            valueLabel.textContent = `${Math.round(volume * 100)}%`;
            this.setPeerVolume(peerId, volume);
        });
        slider.addEventListener('click', (e) => e.stopPropagation());

        popover.appendChild(slider);
        popover.appendChild(valueLabel);

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.participant-volume-popover').forEach(p => { if (p !== popover) p.classList.add('hidden'); });
            popover.classList.toggle('hidden');
        });

        document.addEventListener('click', (e) => {
            if (!wrap.contains(e.target)) popover.classList.add('hidden');
        });

        wrap.appendChild(btn);
        wrap.appendChild(popover);
        return wrap;
    }

    /**
     * Local-only block toggle — no popover needed, unlike volume/mod menus, since
     * it's a single on/off action. Available to everyone (unlike the moderator
     * menu), since blocking is a personal preference, not a permission.
     * @param {string} peerId
     * @returns {HTMLElement}
     */
    _buildBlockControl(peerId) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'participant-block-btn';
        btn.title = this.blockedPeerIds.has(peerId) ? 'Unblock' : 'Block';
        btn.innerHTML = '<span class="material-symbols-rounded">block</span>';
        if (this.blockedPeerIds.has(peerId)) btn.classList.add('is-blocked');

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.setBlocked(peerId, !this.blockedPeerIds.has(peerId));
        });

        return btn;
    }

    /**
     * Updates one participant card's status dot color/icon and text label.
     * @param {string} peerId
     * @param {'online'|'away'|'dnd'|'offline'} status
     * @returns {void}
     */
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

    /** @param {'excellent'|'good'|'fair'|'poor'|'unknown'} tier @returns {string} colored signal-bars icon SVG markup. */
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

    /** Updates one participant card's signal-bars icon + tooltip. */
    updateConnectionQuality(peerId, tier) {
        const el = document.getElementById(`participant-${peerId}`);
        if (!el) return;
        const icon = el.querySelector('.participant-signal-icon');
        if (!icon) return;
        const labels = { excellent: 'Excellent', good: 'Good', fair: 'Fair', poor: 'Poor', unknown: 'Unknown' };
        icon.title = `Connection: ${labels[tier] || 'Unknown'}`;
        icon.innerHTML = this._signalBarsSvg(tier);
    }

    /** Removes one peer's participant card and refreshes the member count. */
    removeParticipant(peerId) {
        const el = document.getElementById(`participant-${peerId}`);
        if (el) el.remove();
        this._updateMemberCount();
    }

    /**
     * Called on a fresh 'init' (first join, or a reconnect after the socket dropped).
     * Every peerId — including our own — is freshly assigned per connection, so any
     * cards left over from before the drop are now orphaned and must be cleared first,
     * or they double up alongside the newly (re)assigned ones.
     * @returns {void}
     */
    clearAllParticipants() {
        const container = document.getElementById('participants');
        if (container) container.innerHTML = '';
        this.selfPeerId = null;
        this.peerVolumes.clear();
        this.blockedPeerIds.clear();
        this._updateMemberCount();
    }

    /** Refreshes the members-sidebar and top-bar "X / cap" participant counts. */
    _updateMemberCount() {
        const count = document.getElementById('participants')?.children.length || 0;
        const el = document.getElementById('member-count');
        if (el) el.textContent = `${count} / ${this.maxPeers}`;
        const topbarCount = document.getElementById('topbar-peer-count');
        if (topbarCount) topbarCount.textContent = count;
        const topbarCap = document.getElementById('topbar-peer-cap');
        if (topbarCap) topbarCap.textContent = this.maxPeers;
    }

    /**
     * Called once from the 'init' handler — populates the top bar's room-state pill
     * and stashes the cap so every later _updateMemberCount() reflects it.
     * @param {{name: string|null, code: string, hasPassword: boolean, maxPeers: number}} meta
     * @returns {void}
     */
    setRoomMeta({ name, code, hasPassword, maxPeers }) {
        this.roomName = name || null;
        this.maxPeers = maxPeers || 6;

        const nameEl = document.getElementById('topbar-room-name');
        if (nameEl) nameEl.textContent = name || code;
        // Inline style, not the `.hidden` utility class: `.material-symbols-rounded`
        // (fonts.css, unlayered) otherwise beats Tailwind's layered `.hidden` utility
        // in the cascade regardless of source order, silently keeping the icon visible.
        const lockEl = document.getElementById('topbar-room-lock');
        if (lockEl) lockEl.style.display = hasPassword ? '' : 'none';
        const codeEl = document.getElementById('topbar-room-code');
        if (codeEl) codeEl.textContent = code;

        this._updateMemberCount();
    }

    /**
     * Refreshes every participant card's crown badge + kebab-menu visibility when
     * moderator status changes (initial join, a promote/demote, or a reconnect-reclaim).
     * @param {string|null} creatorPeerId
     * @param {Set<string>|string[]} moderatorPeerIds - may be a Set or a plain array (WS payloads arrive as arrays).
     * @returns {void}
     */
    updateModeratorStatus(creatorPeerId, moderatorPeerIds) {
        this.creatorPeerId = creatorPeerId;
        this.moderatorPeerIds = moderatorPeerIds instanceof Set ? moderatorPeerIds : new Set(moderatorPeerIds || []);
        const iAmModerator = !!this.selfPeerId && this.moderatorPeerIds.has(this.selfPeerId);

        document.querySelectorAll('#participants .participant-card').forEach(card => {
            const peerId = card.id.replace('participant-', '');
            const crown = card.querySelector('.participant-crown');
            if (crown) {
                crown.style.display = this.moderatorPeerIds.has(peerId) ? '' : 'none';
                crown.title = peerId === this.creatorPeerId ? 'Room creator' : 'Moderator';
            }

            const modMenu = card.querySelector('.participant-mod-menu');
            if (modMenu) {
                const showMenu = iAmModerator && peerId !== this.selfPeerId;
                modMenu.style.display = showMenu ? 'flex' : 'none';
                // Force the popover closed and stale — it rebuilds fresh on next open,
                // so a permission change never leaves an outdated menu visibly open.
                modMenu.querySelector('.participant-mod-popover')?.classList.add('hidden');
            }
        });
    }

    /**
     * Replaces the old "Xms · mesh" text with the same colored signal-bars icon
     * used per-participant in the members list (_signalBarsSvg) — tier is the
     * worst connection quality across all mesh peers, ms is only for the tooltip.
     * @param {number|null} ms
     * @param {'excellent'|'good'|'fair'|'poor'|'unknown'} tier
     * @returns {void}
     */
    updateMeshSignal(ms, tier) {
        const wrap = document.getElementById('topbar-signal-wrap');
        const icon = document.getElementById('topbar-signal-icon');
        if (!wrap || !icon) return;
        if (ms === null) {
            wrap.classList.add('hidden');
            return;
        }
        const labels = { excellent: 'Excellent', good: 'Good', fair: 'Fair', poor: 'Poor', unknown: 'Unknown' };
        icon.innerHTML = this._signalBarsSvg(tier);
        icon.title = `${Math.round(ms)}ms · mesh · ${labels[tier] || 'Unknown'}`;
        wrap.classList.remove('hidden');
    }

    /** @returns {string} mic-on icon SVG markup. */
    _micOnSvg() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-2.5 h-2.5"><path d="M7 4a3 3 0 0 1 6 0v6a3 3 0 1 1-6 0V4Z" /><path d="M5.5 9.643a.75.75 0 0 1 .75.75v.357a3.75 3.75 0 0 0 7.5 0v-.357a.75.75 0 0 1 1.5 0v.357a5.25 5.25 0 0 1-4.5 5.196V17.5a.75.75 0 0 1-1.5 0v-1.554a5.25 5.25 0 0 1-4.5-5.196v-.357a.75.75 0 0 1 .75-.75Z" /></svg>`;
    }

    /** @returns {string} mic-off icon SVG markup. */
    _micOffSvg() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-2.5 h-2.5"><path d="M7.22 3.22a.75.75 0 0 1 1.06 0L12 6.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L13.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L12 9.06l-3.72 3.72a.75.75 0 0 1-1.06-1.06L10.94 8 7.22 4.28a.75.75 0 0 1 0-1.06Z" /></svg>`;
    }

    /**
     * Discord-style speaking ring — toggled by PeerManager's real audio-level polling
     * (not mic-enabled/disabled, which only tells you they *could* be making sound).
     * Applies to the participant card, any matching grid tile(s), and (for the
     * local user) the top-bar identity avatar.
     * @param {string} peerId
     * @param {boolean} speaking
     * @returns {void}
     */
    setSpeaking(peerId, speaking) {
        const el = document.getElementById(`participant-${peerId}`);
        if (el) {
            const avatar = el.querySelector('.flex-shrink-0 > div:first-child');
            if (avatar) avatar.classList.toggle('status-talking', speaking);
        }
        // A peer's stream(s) can appear as a grid tile under either key
        // (screen-share and/or webcam) — the ring reflects the person, not the tile.
        [peerId, `${peerId}-cam`].forEach(key => {
            const tile = this.gridView?.querySelector(`[data-peer-id="${key}"]`);
            if (tile) tile.classList.toggle('status-talking', speaking);
        });
        // Local user also gets the ring on their own top-bar avatar — you can't
        // hear your own mic, so this is the only feedback that voice-activity
        // mode is (or isn't) actually transmitting right now, useful for
        // diagnosing a sensitivity threshold that's too high/low for the room.
        if (peerId === this.selfPeerId) {
            document.getElementById('topbar-identity-avatar')?.classList.toggle('status-talking', speaking);
        }
    }

    /** Updates the mic icon on any grid tile(s) matching this peer. */
    _updateGridMicIcon(peerId, enabled) {
        [peerId, `${peerId}-cam`].forEach(key => {
            const tile = this.gridView?.querySelector(`[data-peer-id="${key}"]`);
            const icon = tile?.querySelector('.grid-tile-mic');
            if (!icon) return;
            icon.style.color = enabled ? '#22c55e' : '#ef4444';
            icon.innerHTML = enabled ? this._micOnSvg() : this._micOffSvg();
        });
    }

    /**
     * Updates a peer's mic icon everywhere it appears (card + grid tiles),
     * creating the participant card first if it doesn't exist yet. Muting
     * also immediately clears the speaking ring, rather than waiting for
     * the next speaking-poll tick.
     * @param {string} peerId
     * @param {boolean} enabled
     * @returns {void}
     */
    updateParticipantMic(peerId, enabled) {
        let el = document.getElementById(`participant-${peerId}`);
        if (!el) {
            this.addParticipant(peerId);
            el = document.getElementById(`participant-${peerId}`);
        }
        this._micEnabled = this._micEnabled || {};
        this._micEnabled[peerId] = enabled;
        this._updateGridMicIcon(peerId, enabled);
        const dot = el.querySelector('.participant-mic');
        const label = el.querySelector('.participant-mic-label');
        if (enabled) {
            dot.style.color = '#22c55e';
            dot.innerHTML = this._micOnSvg();
            if (label) label.textContent = 'Unmuted';
        } else {
            dot.style.color = '#ef4444';
            dot.innerHTML = this._micOffSvg();
            if (label) label.textContent = 'Muted';
            // A muted mic can't be producing real audio levels, but clear the ring
            // immediately rather than waiting on the next speaking-poll tick.
            this.setSpeaking(peerId, false);
        }
    }

    /** Shows/hides a peer's deafened-icon badge on their participant card. */
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

    /**
     * Updates a peer's displayed nickname (card, avatar initials, and the
     * top-bar identity pill if it's the local user), creating the
     * participant card first if it doesn't exist yet. If this nickname
     * update resolves a pending "joined" toast (see `addPeer`), posts the
     * join system message now that the real name is known.
     * @param {string} peerId
     * @param {string} nickname
     * @returns {void}
     */
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
        if (avatar) avatar.textContent = this._avatarInitials(nickname);

        if (peerId === this.selfPeerId) {
            const identityName = document.getElementById('topbar-identity-name');
            const identityAvatar = document.getElementById('topbar-identity-avatar');
            if (identityName) identityName.textContent = nickname;
            if (identityAvatar) identityAvatar.textContent = this._avatarInitials(nickname);
        }

        if (this._pendingJoinToasts && this._pendingJoinToasts.has(peerId)) {
            this._pendingJoinToasts.delete(peerId);
            this.addSystemMessage(`${nickname} joined`, 'join');
        }
    }

    /** Updates the top-bar identity pill's status-dot class for the local user. */
    updateIdentityStatus(status) {
        const dot = document.getElementById('topbar-identity-status-dot');
        if (dot) dot.className = `topbar-identity-status-dot ${status === 'online' ? '' : status}`.trim();
    }

    // --- Audio ---

    /**
     * Creates (or reuses) an `<audio>` element for one incoming audio track
     * and applies the current deafen/volume state to it.
     * @param {string} peerId - `audioKey` — bare peerId (mic) or `${peerId}-screen` (screen-share audio).
     * @param {MediaStreamTrack} track
     * @returns {void}
     */
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
        this._applyAudioVolume(peerId);
    }

    /** Removes and stops one audio element (see the `audioKey` note on `addAudio`). */
    removeAudio(peerId) {
        const audio = document.getElementById(`audio-${peerId}`);
        if (audio) {
            audio.srcObject = null;
            audio.remove();
        }
    }

    /**
     * `audioKey` is the id passed to addAudio/removeAudio — either a bare
     * peerId (mic) or `${peerId}-screen` (screen-share audio). Both share one
     * per-person volume, so strip the suffix to look it up. Forces 0 for a
     * blocked peer regardless of their saved volume.
     * @param {string} audioKey
     * @returns {void}
     */
    _applyAudioVolume(audioKey) {
        const audio = document.getElementById(`audio-${audioKey}`);
        if (!audio) return;
        const basePeerId = audioKey.endsWith('-screen') ? audioKey.slice(0, -'-screen'.length) : audioKey;
        audio.volume = this.blockedPeerIds.has(basePeerId) ? 0 : this.masterCallVolume * (this.peerVolumes.get(basePeerId) ?? 1);
    }

    /**
     * Sets one peer's local playback volume (mic + screen-share audio share it).
     * @param {string} peerId
     * @param {number} volume - 0-1.
     * @returns {void}
     */
    setPeerVolume(peerId, volume) {
        this.peerVolumes.set(peerId, volume);
        this._applyAudioVolume(peerId);
        this._applyAudioVolume(`${peerId}-screen`);
    }

    /**
     * `key` is a stream key, either a bare peerId (screen share) or `${peerId}-cam`
     * (webcam) — strip the cam suffix so both map to the same block entry.
     * @param {string} key
     * @returns {boolean}
     */
    isBlocked(key) {
        const basePeerId = key.endsWith('-cam') ? key.slice(0, -'-cam'.length) : key;
        return this.blockedPeerIds.has(basePeerId);
    }

    /**
     * Single entry point for toggling a block — mirrors setSpeaking()'s style of
     * querying the DOM fresh rather than caching element references, so any future
     * second call site (e.g. a "block" action from a chat message) can just call
     * this too instead of duplicating the video/audio/UI side effects.
     * @param {string} peerId
     * @param {boolean} blocked
     * @returns {void}
     */
    setBlocked(peerId, blocked) {
        if (blocked) {
            this.blockedPeerIds.add(peerId);
            // The grid/focus filters below will exclude this peer going forward, but
            // any tile of theirs already marked "watched" needs an explicit unwatch —
            // that's what actually signals unwatch-stream and stops their sender.
            [peerId, `${peerId}-cam`].forEach(key => {
                if (this.watchedTiles.has(key)) this._unwatchTile(key);
            });
            if (this.focusedPeerId === peerId) {
                this.focusedPeerId = null;
                this.focusedVideo.srcObject = null;
            }
        } else {
            this.blockedPeerIds.delete(peerId);
        }

        this._applyAudioVolume(peerId);
        this._applyAudioVolume(`${peerId}-screen`);

        const card = document.getElementById(`participant-${peerId}`);
        card?.classList.toggle('is-blocked', blocked);
        const btn = card?.querySelector('.participant-block-btn');
        if (btn) {
            btn.classList.toggle('is-blocked', blocked);
            btn.title = blocked ? 'Unblock' : 'Block';
        }

        this.updateLayout();
    }

    /**
     * Sets the overall call volume (persisted — a personal preference, not
     * tied to any peer/session) and re-applies it to every active audio element.
     * @param {number} volume - 0-1.
     * @returns {void}
     */
    setMasterCallVolume(volume) {
        this.masterCallVolume = volume;
        localStorage.setItem('masterCallVolume', String(volume));
        document.querySelectorAll('audio[id^="audio-"]').forEach(audio => {
            this._applyAudioVolume(audio.id.slice('audio-'.length));
        });
    }

    // --- Self-view PiPs ---

    /** Auto-stacks the screen/cam self-view PiPs against the right edge (skips any that's been manually dragged). */
    _updateSelfViewPositions() {
        const screenView = document.getElementById('self-view');
        const camView = document.getElementById('self-cam-view');
        // A manually-dragged PiP (dataset.dragged) keeps its own explicit
        // left/top — don't snap it back into the auto right-edge stacking.
        if (screenView && camView) {
            if (!screenView.dataset.dragged) screenView.style.right = '170px';
            if (!camView.dataset.dragged) camView.style.right = '10px';
        } else if (screenView && !screenView.dataset.dragged) {
            screenView.style.right = '10px';
        } else if (camView && !camView.dataset.dragged) {
            camView.style.right = '10px';
        }
    }

    /** Re-clamps a manually-dragged PiP back on-screen (e.g. after a window resize) and persists the new position. */
    _reclampDraggedPip(el, storageKey) {
        const maxLeft = Math.max(0, window.innerWidth - el.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - el.offsetHeight);
        const left = Math.min(Math.max(parseFloat(el.style.left) || 0, 0), maxLeft);
        const top = Math.min(Math.max(parseFloat(el.style.top) || 0, 0), maxTop);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        localStorage.setItem(`pipPosition:${storageKey}`, JSON.stringify({ left, top }));
    }

    /**
     * Drag-to-reposition for the self-view PiPs (Discord-style), via Pointer
     * Events so mouse and touch share one code path. Position is
     * remembered per PiP (`pipPosition:${storageKey}`) across stream stop/start
     * and page reloads, since it's a personal layout preference, not tied to any
     * one stream instance.
     * @param {HTMLElement} el
     * @param {string} storageKey
     * @returns {void}
     */
    _makeDraggable(el, storageKey) {
        el.style.cursor = 'grab';
        el.style.touchAction = 'none'; // prevent touch-drag from also scrolling the page
        let offsetX = 0;
        let offsetY = 0;

        const clamp = (left, top) => {
            const maxLeft = Math.max(0, window.innerWidth - el.offsetWidth);
            const maxTop = Math.max(0, window.innerHeight - el.offsetHeight);
            return [Math.min(Math.max(left, 0), maxLeft), Math.min(Math.max(top, 0), maxTop)];
        };

        const applyPosition = (left, top) => {
            const [clampedLeft, clampedTop] = clamp(left, top);
            el.style.left = `${clampedLeft}px`;
            el.style.top = `${clampedTop}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.dataset.dragged = 'true';
        };

        const saved = localStorage.getItem(`pipPosition:${storageKey}`);
        if (saved) {
            try {
                const { left, top } = JSON.parse(saved);
                if (Number.isFinite(left) && Number.isFinite(top)) applyPosition(left, top);
            } catch {}
        }

        el.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            applyPosition(rect.left, rect.top);
            el.setPointerCapture(e.pointerId);
            el.style.cursor = 'grabbing';
        });

        el.addEventListener('pointermove', (e) => {
            if (!el.hasPointerCapture?.(e.pointerId)) return;
            applyPosition(e.clientX - offsetX, e.clientY - offsetY);
        });

        el.addEventListener('pointerup', (e) => {
            if (!el.hasPointerCapture?.(e.pointerId)) return;
            el.releasePointerCapture(e.pointerId);
            el.style.cursor = 'grab';
            const rect = el.getBoundingClientRect();
            localStorage.setItem(`pipPosition:${storageKey}`, JSON.stringify({ left: rect.left, top: rect.top }));
        });
    }

    /**
     * Records an incoming (or local self-) stream and renders it: self-views
     * become a draggable PiP, a blocked peer's stream is recorded but never
     * shown, and a new remote stream auto-focuses if nothing else is
     * currently focused.
     * @param {string} peerId - a stream key: `'me'`/`'me-cam'` for local self-views, else a remote stream key.
     * @param {MediaStream} stream
     * @returns {void}
     */
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
                selfView.classList.add('self-view-pip');
                this.container.appendChild(selfView);
                this._makeDraggable(selfView, viewId);
            }
            this._updateSelfViewPositions();
            if (peerId === 'me') playSound('streamUp');
            this.updateLayout();
            return;
        }

        // Stream is still recorded above (so unblocking can redisplay it instantly,
        // no new ontrack needed) but a blocked peer never gets the streamUp sound,
        // auto-focus, or an auto-watch — buildGrid()/updateLayout() filter them out
        // of the grid/focus entirely.
        if (this.isBlocked(peerId)) {
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

    /**
     * Removes a recorded stream and its rendering, re-focusing another
     * stream if the removed one was currently focused.
     * @param {string} peerId - a stream key (see `addStream`).
     * @param {boolean} [silent=false] - suppress the streamDown sound (blanket cleanup on full disconnect already plays its own sound).
     * @returns {void}
     */
    removeStream(peerId, silent = false) {
        // A full peer disconnect (PeerManager.removePeer) calls this as blanket
        // cleanup for streams that may never have existed, and already plays its
        // own 'peerLeft' sound — hence the silent flag and the hadStream guard,
        // so one leave can't queue phantom streamDown sounds on top.
        const hadStream = !!this.streams[peerId];
        delete this.streams[peerId];
        this.watchedTiles.delete(peerId);
        this._watchSentState.delete(peerId);
        const orderIdx = this._watchOrder.indexOf(peerId);
        if (orderIdx !== -1) this._watchOrder.splice(orderIdx, 1);

        if (peerId === 'me' || peerId === 'me-cam') {
            const viewId = peerId === 'me' ? 'self-view' : 'self-cam-view';
            const selfView = document.getElementById(viewId);
            if (selfView) {
                if (peerId === 'me' && !silent) playSound('streamDown');
                selfView.remove();
            }
            this._updateSelfViewPositions();
            const placeholder = document.getElementById('stream-placeholder');
            if (placeholder) placeholder.remove();
            if (peerId === 'me') this.updateLayout();
            return;
        } else {
            if (hadStream && !silent) playSound('streamDown');

            if (this.focusedPeerId === peerId) {
                this.focusedPeerId = null;
                this.focusedVideo.srcObject = null;
                const remaining = Object.keys(this.streams).filter(id => id !== 'me' && id !== 'me-cam' && !this.isBlocked(id));
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

    /**
     * Re-renders the stage from current state: shows the spinner if there
     * are no remote streams, otherwise builds the grid or the focus view
     * per `viewMode`. The single entry point that should be called after
     * anything that could change what's on screen.
     * @returns {void}
     */
    updateLayout() {
        const remoteStreams = Object.keys(this.streams).filter(id => id !== 'me' && id !== 'me-cam' && !this.isBlocked(id));
        const spinner = document.getElementById('spinner');
        const stageHeader = document.getElementById('stage-header');

        if (remoteStreams.length === 0) {
            spinner.classList.remove('hidden');
            this.focusedView.style.display = 'none';
            this.gridView.style.display = 'none';
            if (stageHeader) stageHeader.style.display = 'none';
            return;
        }

        spinner.classList.add('hidden');

        if (stageHeader) stageHeader.style.display = 'flex';
        this._updateStageHeader();

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
            this._updateFocusMeta(this.focusedPeerId);
            this._renderFocusWatchState();
        }
    }

    /** Updates the stage header's grid/focus toggle active state and the watched-stream count. */
    _updateStageHeader() {
        const gridBtn = document.getElementById('stage-view-grid');
        const focusBtn = document.getElementById('stage-view-focus');
        if (gridBtn) gridBtn.classList.toggle('active', this.viewMode === 'grid');
        if (focusBtn) focusBtn.classList.toggle('active', this.viewMode === 'focus');

        const countEl = document.getElementById('stage-stream-count');
        if (countEl) countEl.textContent = `${this.watchedTiles.size} / ${this.maxWatchedTiles}`;
    }

    /**
     * Called by PeerManager whenever our own screen-share starts/stops/quality
     * changes — pass null to hide the segment (nothing meaningful while not sharing).
     * @param {string|null} label
     * @returns {void}
     */
    updateStageQuality(label) {
        const stat = document.getElementById('stage-quality-stat');
        const divider = document.getElementById('stage-quality-divider');
        const labelEl = document.getElementById('stage-quality-label');
        const show = !!label;
        if (stat) stat.style.display = show ? 'flex' : 'none';
        if (divider) divider.style.display = show ? '' : 'none';
        if (labelEl) labelEl.textContent = label || '';
    }

    /** @param {'push-to-talk'|'push-to-mute'|'voice-activity'|string} micMode shows the dock's PTT/PTM/VA badge, hidden for any other mode. */
    updateMicModeBadge(micMode) {
        const badge = document.getElementById('mic-mode-badge');
        if (!badge) return;
        const labels = { 'push-to-talk': 'PTT', 'push-to-mute': 'PTM', 'voice-activity': 'VA' };
        const text = labels[micMode];
        badge.textContent = text || '';
        badge.classList.toggle('hidden', !text);
    }

    /**
     * Shows/hides self-view PiPs and the "Still Streaming..." placeholder
     * badge when the window loses/regains focus (or the tab is hidden)
     * while actively streaming.
     * @param {boolean} blurred
     * @returns {void}
     */
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
