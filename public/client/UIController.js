import { playSound } from './SoundPlayer.js';
import { ChatUI } from './ChatUI.js';
import { escapeHtml } from './escapeHtml.js';
import * as chatHistoryStore from './chatHistoryStore.js';

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
        this.chat = new ChatUI({
            getNickname: (id) => this._peerNickname(id),
            avatarInitials: (name) => this._avatarInitials(name),
            getAllNicknames: () => this._allNicknames(),
            isModerator: () => !!this.selfPeerId && this.moderatorPeerIds.has(this.selfPeerId),
            getAvatar: (id) => this.peerAvatars.get(id) || null,
            getRoomCode: () => this.roomCode,
        });
        // A dragged self-view PiP's saved left/top can end up off-screen after the
        // window shrinks (e.g. undocking to a smaller monitor) — reclamp on resize.
        window.addEventListener('resize', () => {
            ['self-view', 'self-cam-view'].forEach(id => {
                const el = document.getElementById(id);
                if (el?.dataset.dragged) this._reclampDraggedPip(el, id);
            });
        });
        this._sharedFiles = [];
        // Every nickname seen this session (self + every peer who ever sent a real
        // nickname), for session-recap export's "Attendees" section — deliberately
        // never pruned on leave/removeParticipant, unlike peerVolumes/blockedPeerIds
        // above, since someone who left mid-session still attended it. Not reset in
        // clearAllParticipants() either: an 'init' there is a reconnect within the
        // same session (fresh peerIds, not a new room), so past attendees still count.
        this._attendees = new Set();
        this.maxPeers = 6;
        this.roomName = null;
        this.roomCode = null;
        // Local-only playback volume per remote peer (0-1, default 1). Not
        // persisted: peerIds are freshly assigned every reconnect, so a
        // localStorage entry keyed by peerId would never be looked up again.
        this.peerVolumes = new Map();
        // Local-only block list: hides a peer's video/audio/chat/reactions/files/polls
        // until unblocked. Same non-persistence rationale as peerVolumes above — cleared
        // in clearAllParticipants(), never written to localStorage.
        this.blockedPeerIds = new Set();
        // peerId → validated `data:image/(webp|jpeg|png);base64,...` avatar, received
        // via PeerManager's 'avatar-update' (already allowlist-validated there before
        // this map ever sees it). Same non-persistence rationale as peerVolumes above.
        this.peerAvatars = new Map();
        // peerId → Date.now() when their hand went up; Map insertion order is
        // the sidebar queue's order. Same non-persistence rationale as
        // peerVolumes above — cleared in clearAllParticipants().
        this.raisedHands = new Map();
        // Overall call volume, multiplied with each peer's own volume. This one
        // *is* persisted — it's a personal preference, not tied to any peer/session.
        this.masterCallVolume = parseFloat(localStorage.getItem('masterCallVolume'));
        if (Number.isNaN(this.masterCallVolume)) this.masterCallVolume = 1;
        // Empty string means "system default" — applied to every remote
        // peer's <audio> element in addAudio() below, and to all of them at
        // once via setAudioOutputDevice() when the user changes it in Settings.
        this._audioOutputDeviceId = localStorage.getItem('speakerDeviceId') || '';
        this.setupZoom();
        this.setupPictureInPicture();
        this.setupFocusControls();
        this._createToastContainer();
        this._initFilesTab();
    }

    // --- Files tab ---

    /** Wires the chat/files tab switcher, the "download all" button, and the recap export button. */
    _initFilesTab() {
        document.getElementById('tab-chat').addEventListener('click', () => this._switchTab('chat'));
        document.getElementById('tab-files').addEventListener('click', () => this._switchTab('files'));
        document.getElementById('files-download-all').addEventListener('click', () => this._downloadAllFiles());
        document.getElementById('export-recap-btn')?.addEventListener('click', () => this.exportSessionRecap());
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
            <button class="shrink-0 p-1.5 rounded text-muted hover:text-foreground transition-colors" data-tip="Download"></button>
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

    /**
     * Adds every entry in `this._sharedFiles` into `zip` under `folder`
     * (root if omitted), de-duplicating identically-named files as
     * "name (1).ext", "name (2).ext", etc. Shared by `_downloadAllFiles()`
     * and `exportSessionRecap()` so the naming logic exists exactly once.
     * @param {JSZip} zip
     * @param {string} [folder='']
     * @returns {void}
     */
    _addFilesToZip(zip, folder = '') {
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
            zip.file(folder ? `${folder}/${name}` : name, f.blob);
        });
    }

    /**
     * Generates `zip` and triggers a browser download as `filename` — the
     * blob-URL-and-`<a download>` dance shared by `_downloadAllFiles()` and
     * `exportSessionRecap()`.
     * @param {JSZip} zip
     * @param {string} filename
     * @returns {Promise<void>}
     */
    async _downloadZip(zip, filename) {
        const content = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    /** Zips (client-side, via JSZip) and downloads every file shared this session. */
    async _downloadAllFiles() {
        if (!this._sharedFiles.length || typeof JSZip === 'undefined') return;
        const zip = new JSZip();
        this._addFilesToZip(zip);
        await this._downloadZip(zip, 'peek-files.zip');
    }

    /**
     * Every nickname seen this session, for session-recap export's
     * "Attendees" section — sorted for a stable, readable list.
     * @returns {string[]}
     */
    getAttendees() {
        return [...this._attendees].sort((a, b) => a.localeCompare(b));
    }

    /**
     * Builds the recap markdown text (source for both `recap.md` and
     * `recap.html` — see `exportSessionRecap()`): an "Attendees" list, a
     * "Pinned messages" section from `ChatUI.getPinnedMessages()`, a "Polls"
     * section, then a "Chat transcript" section from the retained message
     * history — supplied by `getAttendees()` and ChatUI's read-only
     * accessors (`getPinnedMessages()`/`getPollSummaries()`/`getMessageHistory()`).
     * Named "Pinned messages" rather than "Decisions" since pinning isn't
     * specific to decision-tracking/team-meeting use — any message worth
     * flagging can be pinned.
     * @param {string[]} attendees
     * @param {{sender: string, text: string, pinnedAt: number}[]} pinned
     * @param {{sender: string, question: string, totalVotes: number, options: {text: string, count: number, voters: string[]}[]}[]} polls
     * @param {{sender: string, text: string, timestamp: string}[]} history
     * @returns {string}
     */
    _buildRecapText(attendees, pinned, polls, history) {
        const title = this.roomName || this.roomCode || 'Peek session';
        const lines = [`# ${title} — session recap`, `_Exported ${new Date().toLocaleString()}_`, ''];

        lines.push('## Attendees', '');
        if (attendees.length) {
            attendees.forEach(name => lines.push(`- ${name}`));
        } else {
            lines.push('_No attendees recorded._');
        }
        lines.push('');

        lines.push('## Pinned messages', '');
        if (pinned.length) {
            pinned.forEach(p => lines.push(`- **${p.sender}**: ${p.text}`));
        } else {
            lines.push('_No messages were pinned this session._');
        }
        lines.push('');

        lines.push('## Polls', '');
        if (polls.length) {
            polls.forEach(poll => {
                lines.push(`- **${poll.question}** (by ${poll.sender}, ${poll.totalVotes} ${poll.totalVotes === 1 ? 'vote' : 'votes'})`);
                poll.options.forEach(o => {
                    const who = o.voters.length ? ` — ${o.voters.join(', ')}` : '';
                    lines.push(`  - ${o.text}: ${o.count}${who}`);
                });
            });
        } else {
            lines.push('_No polls were created this session._');
        }
        lines.push('');

        lines.push('## Chat transcript', '');
        lines.push('_Only the most recent messages still held in memory are included — Peek keeps no server-side chat history._', '');
        if (history.length) {
            history.forEach(m => lines.push(`_[${m.timestamp}]_ **${m.sender}**: ${m.text}`));
        } else {
            lines.push('_No chat messages this session._');
        }
        lines.push('');

        return lines.join('\n');
    }

    /**
     * Renders the recap markdown (from `_buildRecapText()`) to a
     * self-contained `recap.html` — same `marked` + `DOMPurify` pipeline
     * chat messages already go through, so it's exactly as safe, wrapped in
     * a minimal inline-styled page (light/dark via `prefers-color-scheme`,
     * no external assets) that opens by double-clicking in any browser.
     * Added alongside `recap.md`, not instead of it — not everyone has a
     * markdown reader, but some people specifically want the plain-text
     * source too (e.g. to paste elsewhere).
     * @param {string} markdown
     * @param {string} title
     * @returns {string}
     */
    _buildRecapHtml(markdown, title) {
        const bodyHtml = DOMPurify.sanitize(marked.parse(markdown));
        return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #1a1a1a; background: #fff; }
  h1, h2 { border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; }
  code { background: #f0f0f0; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.9em; }
  ul { padding-left: 1.4rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181d; color: #e5e7eb; }
    h1, h2 { border-color: #333; }
    code { background: #2a2d35; }
  }
</style></head>
<body>${bodyHtml}</body></html>`;
    }

    /**
     * Bundles the attendee list, retained chat transcript, pinned messages,
     * poll results, and every shared file into one zip download — the
     * client-side "session recap" (`TODO.md`'s meeting-recap workflow, step
     * 3). Available with zero files/pins/polls too (a text-only recap is
     * still useful), unlike `_downloadAllFiles()` which only ever appears
     * once 2+ files exist. Exports only what this local peer has personally
     * already seen — no moderator gating, same trust level as a local
     * screenshot. Bundles both `recap.md` (plain markdown source) and
     * `recap.html` (self-contained, styled, opens in any browser without a
     * markdown reader) built from the exact same text, so neither format
     * can drift from the other.
     * @returns {Promise<void>}
     */
    async exportSessionRecap() {
        if (typeof JSZip === 'undefined') return;
        const zip = new JSZip();
        const title = this.roomName || this.roomCode || 'Peek session';
        const markdown = this._buildRecapText(this.getAttendees(), this.chat.getPinnedMessages(), this.chat.getPollSummaries(), this.chat.getMessageHistory());
        zip.file('recap.md', markdown);
        zip.file('recap.html', this._buildRecapHtml(markdown, `${title} — session recap`));
        this._addFilesToZip(zip, 'files');
        const dateStamp = new Date().toISOString().slice(0, 10);
        const slug = (this.roomName || this.roomCode || 'session').replace(/[^a-z0-9-]+/gi, '-');
        await this._downloadZip(zip, `peek-recap-${slug}-${dateStamp}.zip`);
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
    set onEditMessage(fn) { this.chat.onEditMessage = fn; }
    set onDeleteMessage(fn) { this.chat.onDeleteMessage = fn; }
    set onPinMessage(fn) { this.chat.onPinMessage = fn; }
    set onUnpinMessage(fn) { this.chat.onUnpinMessage = fn; }
    addChatMessage(...a) { return this.chat.addChatMessage(...a); }
    applyChatEdit(...a) { return this.chat.applyChatEdit(...a); }
    applyChatDelete(...a) { return this.chat.applyChatDelete(...a); }
    applyPin(...a) { return this.chat.applyPin(...a); }
    addSystemMessage(...a) { return this.chat.addSystemMessage(...a); }
    addPollMessage(...a) { return this.chat.addPollMessage(...a); }
    updatePollVote(...a) { return this.chat.updatePollVote(...a); }

    /**
     * Proxies to `ChatUI.addFileMessage`, then also records the file in the
     * Files tab (`_addFileToTab`) when a Blob is available — the one proxy
     * here with extra behavior beyond forwarding, since the Files tab is a
     * UIController concern, not ChatUI's.
     */
    addFileMessage(sender, fileId, fileName, fileSize, fileType, blobUrl, blob, groupId, isSelf = false) {
        this.chat.addFileMessage(sender, fileId, fileName, fileSize, fileType, blobUrl, blob, groupId, isSelf);
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
     * Every current participant's display nickname (including the local
     * user's own), for @mention detection — ChatUI has no direct access to
     * the participant list, so this is passed into its constructor as
     * `getAllNicknames`.
     * @returns {string[]}
     */
    _allNicknames() {
        return Array.from(document.querySelectorAll('#participants .participant-name'))
            .map(el => el.textContent)
            .filter(Boolean);
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
     * Auto-watches a stream, unless the user's 'audioOnlyMode' preference
     * (Settings > Screen & Video) is on — in which case it's explicitly left
     * unwatched instead of just skipped. A stream that's never had `_watchTile`
     * or `_setWatched` called on it has no `_watchSentState` entry, so its
     * sender defaults to actively transmitting; calling `_setWatched(key, false)`
     * sends the initial `unwatch-stream` signal so it actually pauses, rather
     * than the video staying paused locally while still being sent and decoded
     * for nothing. Only gates *automatic* watches (new stream arriving, focus
     * auto-picking someone) — manual clicks on a tile always call `_watchTile`
     * directly and work regardless of this setting.
     * @param {string} streamKey
     * @returns {void}
     */
    _autoWatchOrSkip(streamKey) {
        if (localStorage.getItem('audioOnlyMode') === '1') this._setWatched(streamKey, false);
        else this._watchTile(streamKey);
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
            this._autoWatchOrSkip(remoteIds[0]);
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
            stopBtn.dataset.tip = 'Stop watching';
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
        this._attendees.add(nickname);
        // Seed our own avatar from localStorage before anything renders — unlike a
        // remote peer's avatar (which only ever arrives via their 'avatar-update'
        // broadcast, handled by updateParticipantAvatar()), nothing else populates
        // peerAvatars for our own peerId this early. Without this, a previously-set
        // avatar (from this session's own Settings change, or a prior session) never
        // shows on our own card/topbar-pill/chat messages until we change it again
        // while already connected (SettingsPanel._wireAvatar() applies it locally
        // going forward, but has nothing to apply retroactively at load time).
        const savedAvatar = localStorage.getItem('avatarDataUrl');
        if (savedAvatar) this.peerAvatars.set(peerId, savedAvatar);
        this._createParticipantCard(peerId, nickname, true);

        const topbarName = document.getElementById('topbar-identity-name');
        const topbarAvatar = document.getElementById('topbar-identity-avatar');
        if (topbarName) topbarName.textContent = nickname;
        if (topbarAvatar) {
            topbarAvatar.style.background = this._avatarSquareColor(peerId, true);
            this._renderAvatarInto(topbarAvatar, peerId, nickname);
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
        online:    '#22c55e',
        unfocused: '#22c55e',
        away:      '#eab308',
        dnd:       '#ef4444',
        offline:   '#6b7280',
    };

    _statusLabels = {
        online:    'Online',
        unfocused: 'Not in focus',
        away:      'Away',
        dnd:       'Do Not Disturb',
        offline:   'Offline',
    };

    /** @param {string} displayName @returns {string} up to 2 initials, one per word. */
    _avatarInitials(displayName) {
        return displayName.split(/\s+/).map(w => w[0]).join('').substring(0, 2).toUpperCase()
            || displayName.substring(0, 2).toUpperCase();
    }

    /**
     * Fills an avatar container (`.participant-avatar` or
     * `#topbar-identity-avatar`) with either the peer's custom avatar image
     * or the initials fallback — the single call site every avatar-render
     * spot (`_createParticipantCard`, `addSelf`, `updateParticipantNickname`,
     * `updateParticipantAvatar`) goes through, so "image vs. initials" logic
     * exists exactly once. In initials mode, `el`'s own colored `background`
     * square + `textContent` drive the look. In image mode, an
     * `<img class="avatar-img">` is layered in instead, and the container's
     * background is cleared to transparent — some custom avatars are
     * uploaded with a transparent background specifically so a non-square
     * logo/shape shows through as its own silhouette, which the initials
     * color square would otherwise defeat by showing solid color through
     * the "transparent" parts. The speaking-ring CSS (`.status-talking`,
     * `tailwind.css`) relies on this too: it targets the ring at `.avatar-img`
     * itself via `filter: drop-shadow()` (which traces the image's actual
     * alpha channel) rather than `box-shadow` on the square container, so the
     * ring only looks right once the container background isn't showing
     * through and fighting it.
     * @param {HTMLElement} el
     * @param {string} peerId
     * @param {string} displayName
     * @returns {void}
     */
    _renderAvatarInto(el, peerId, displayName) {
        if (!el) return;
        const avatarDataUrl = this.peerAvatars.get(peerId);
        if (avatarDataUrl) {
            el.textContent = '';
            el.style.background = 'transparent';
            let img = el.querySelector('.avatar-img');
            if (!img) {
                img = document.createElement('img');
                img.className = 'avatar-img';
                el.appendChild(img);
            }
            img.src = avatarDataUrl; // DOM property assignment, not string-interpolated HTML
        } else {
            el.querySelector('.avatar-img')?.remove();
            el.style.background = this._avatarSquareColor(peerId, peerId === this.selfPeerId);
            el.textContent = this._avatarInitials(displayName);
        }
    }

    /**
     * Applies a peer's avatar-update (already allowlist-validated by
     * PeerManager before this is ever called — see its `_isValidAvatarDataUrl`)
     * to every avatar surface that shows peerId directly: participant cards
     * and, for the local user, the top-bar identity pill. Chat-message
     * avatars are a deliberate scope cut — ChatUI.addChatMessage() only ever
     * receives a resolved nickname string, never a peerId (same limitation
     * already documented for why per-peer block can't retroactively hide
     * chat history).
     * @param {string} peerId
     * @param {string} avatarDataUrl - validated data URL, or '' to clear.
     * @returns {void}
     */
    updateParticipantAvatar(peerId, avatarDataUrl) {
        if (avatarDataUrl) this.peerAvatars.set(peerId, avatarDataUrl);
        else this.peerAvatars.delete(peerId);

        const card = document.getElementById(`participant-${peerId}`);
        const cardAvatar = card?.querySelector('.participant-avatar');
        if (cardAvatar) {
            const nameEl = card.querySelector('.participant-name');
            this._renderAvatarInto(cardAvatar, peerId, nameEl?.textContent || '?');
        }

        if (peerId === this.selfPeerId) {
            const identityAvatar = document.getElementById('topbar-identity-avatar');
            const identityName = document.getElementById('topbar-identity-name');
            this._renderAvatarInto(identityAvatar, peerId, identityName?.textContent || '?');
        }
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
        card.className = 'participant-card px-2 py-2';
        if (isSelf) card.dataset.self = '1';

        const avatarWrap = document.createElement('div');
        avatarWrap.className = 'relative flex-shrink-0';

        const avatar = document.createElement('div');
        avatar.className = 'participant-avatar flex items-center justify-center w-9 h-9 text-white text-xs font-bold select-none';
        avatar.style.background = this._avatarSquareColor(peerId, isSelf);
        this._renderAvatarInto(avatar, peerId, displayName);

        const statusDot = document.createElement('div');
        statusDot.className = 'participant-status-dot absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2';
        statusDot.style.background = this._statusColors.online;
        statusDot.dataset.tip = 'Online';

        const crownBadge = document.createElement('span');
        crownBadge.className = 'participant-crown material-symbols-rounded';
        crownBadge.dataset.tip = peerId === this.creatorPeerId ? 'Room creator' : 'Moderator';
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
        rightCol.className = 'participant-right-col flex items-center gap-1 flex-shrink-0';

        if (!isSelf) {
            // Reveal is otherwise hover-only (see the .participant-actions CSS
            // rule) which a keyboard-only user can never trigger — nothing else
            // in the card is focusable to land on first. tabindex makes the
            // card itself a tab stop so :focus-within can reveal the cluster,
            // same effect a mouse hover already gets.
            card.tabIndex = 0;
            card.setAttribute('aria-label', `${displayName} — show actions`);

            // Action cluster (volume/block/mod kebab) is hover-revealed via
            // .participant-actions CSS so the always-visible row stays one icon
            // tall. It goes first so the persistent status icons (signal/mic)
            // keep their spot at the far right when the cluster appears.
            const actions = document.createElement('div');
            actions.className = 'participant-actions';
            actions.appendChild(this._buildVolumeControl(peerId));
            actions.appendChild(this._buildBlockControl(peerId));
            const modMenu = this._buildModeratorMenu(peerId);
            const iAmModerator = !!this.selfPeerId && this.moderatorPeerIds.has(this.selfPeerId);
            modMenu.style.display = iAmModerator ? 'flex' : 'none';
            actions.appendChild(modMenu);
            rightCol.appendChild(actions);
        }

        // Passive status icons (signal/mic) live in one group so the CSS can
        // hide them while the action cluster is shown — the two swap in place
        // rather than stacking up side by side and squeezing the name.
        const passiveIcons = document.createElement('div');
        passiveIcons.className = 'participant-passive-icons';

        if (!isSelf) {
            const sigIcon = document.createElement('span');
            sigIcon.className = 'participant-signal-icon inline-flex items-center';
            sigIcon.dataset.tip = 'Connection: Unknown';
            sigIcon.innerHTML = this._signalBarsSvg('unknown');
            passiveIcons.appendChild(sigIcon);
        }

        const micIcon = document.createElement('span');
        micIcon.className = 'participant-mic inline-flex items-center';
        micIcon.style.color = '#ef4444';
        micIcon.innerHTML = this._micOffSvg();
        passiveIcons.appendChild(micIcon);
        rightCol.appendChild(passiveIcons);

        card.appendChild(avatarWrap);
        card.appendChild(info);
        card.appendChild(rightCol);

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
        btn.dataset.tip = 'Moderator actions';
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
                addMenuItem('Ban from room', 'ban', 'participant-mod-kick');
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
        btn.dataset.tip = 'Adjust their volume';
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
        btn.dataset.tip = this.blockedPeerIds.has(peerId) ? 'Unblock' : 'Block';
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
     * @param {'online'|'unfocused'|'away'|'dnd'|'offline'} status
     * @param {string} [statusText] - free-text caption (e.g. "In a meeting");
     *   shown instead of the plain enum label when set, same as Discord's
     *   custom status message. The dot's color still always follows `status`.
     * @returns {void}
     */
    updateParticipantStatus(peerId, status, statusText) {
        let el = document.getElementById(`participant-${peerId}`);
        if (!el) return;
        const dot = el.querySelector('.participant-status-dot');
        const label = el.querySelector('.participant-status-label');
        const color = this._statusColors[status] || this._statusColors.online;
        const text = this._statusLabels[status] || 'Online';
        const displayText = statusText || text;
        if (dot) {
            dot.style.background = color;
            dot.dataset.tip = displayText;
            if (status === 'dnd') {
                dot.innerHTML = `<svg viewBox="0 0 10 10" class="w-1.5 h-1.5" style="margin:auto"><rect x="2" y="4" width="6" height="2" rx="1" fill="white"/></svg>`;
            } else {
                dot.innerHTML = '';
            }
        }
        if (label) {
            label.textContent = displayText;
            label.className = `participant-status-label text-[10px]`;
            if (status === 'online' || status === 'unfocused') label.classList.add('text-emerald-400');
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
        // Scaled up alongside the mic/deafen icons (w-4, 16px) so the passive-icons
        // row stays visually consistent rather than mixing a tiny signal icon with
        // much larger mic/deafen ones.
        return `<svg width="16" height="13" viewBox="0 0 12 10" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="6" width="3" height="4" rx="0.5" fill="${c[0]}"/><rect x="4.5" y="3" width="3" height="7" rx="0.5" fill="${c[1]}"/><rect x="9" y="0" width="3" height="10" rx="0.5" fill="${c[2]}"/></svg>`;
    }

    /** Updates one participant card's signal-bars icon + tooltip. */
    updateConnectionQuality(peerId, tier) {
        const el = document.getElementById(`participant-${peerId}`);
        if (!el) return;
        const icon = el.querySelector('.participant-signal-icon');
        if (!icon) return;
        const labels = { excellent: 'Excellent', good: 'Good', fair: 'Fair', poor: 'Poor', unknown: 'Unknown' };
        icon.dataset.tip = `Connection: ${labels[tier] || 'Unknown'}`;
        icon.innerHTML = this._signalBarsSvg(tier);
    }

    /** Removes one peer's participant card and refreshes the member count. */
    removeParticipant(peerId) {
        const el = document.getElementById(`participant-${peerId}`);
        if (el) el.remove();
        if (this.raisedHands.delete(peerId)) this._renderRaisedHands();
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
        this.peerAvatars.clear();
        this.raisedHands.clear();
        this._renderRaisedHands();
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
        // Compare before overwriting: a same-room reconnect (network blip, server
        // restart) must not re-load and re-render history a second time, only an
        // actual room change (first join, or RoomRail switching rooms) should.
        const isNewRoom = !!code && code !== this.roomCode;

        this.roomName = name || null;
        this.roomCode = code || null;
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

        if (isNewRoom) this._loadChatHistory(code);
    }

    /**
     * Renders a room's locally-persisted chat history (see `chatHistoryStore.js`)
     * above the live chat log on join/room-switch, oldest-first, read-only
     * (`isHistorical = true` — no hover action bar, never re-persisted). No-ops
     * entirely when the opt-in `chatHistoryEnabled` setting is off. A one-time
     * "today" divider separates the loaded scrollback from whatever live traffic
     * arrives next.
     * @param {string} code
     * @returns {Promise<void>}
     */
    async _loadChatHistory(code) {
        if (localStorage.getItem('chatHistoryEnabled') !== '1') return;
        const days = parseInt(localStorage.getItem('chatHistoryDays'), 10) || 7;
        const entries = await chatHistoryStore.getHistory(code, days);
        if (!entries.length) return;
        // The room may have changed again (fast room-switch) by the time this
        // async read resolves — don't paint stale history into the wrong room.
        if (this.roomCode !== code) return;

        for (const entry of entries) {
            this.chat.addChatMessage(entry.sender, entry.text, entry.messageId, null, entry.isSelf, null, true);
        }
        const chatLog = document.getElementById('chat-log');
        if (chatLog) {
            const divider = document.createElement('div');
            divider.className = 'chat-history-divider';
            divider.textContent = 'Today';
            chatLog.appendChild(divider);
        }
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
                crown.dataset.tip = peerId === this.creatorPeerId ? 'Room creator' : 'Moderator';
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
        icon.dataset.tip = `${Math.round(ms)}ms · mesh · ${labels[tier] || 'Unknown'}`;
        wrap.classList.remove('hidden');
    }

    /** @returns {string} mic-on icon SVG markup. */
    _micOnSvg() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path d="M7 4a3 3 0 0 1 6 0v6a3 3 0 1 1-6 0V4Z" /><path d="M5.5 9.643a.75.75 0 0 1 .75.75v.357a3.75 3.75 0 0 0 7.5 0v-.357a.75.75 0 0 1 1.5 0v.357a5.25 5.25 0 0 1-4.5 5.196V17.5a.75.75 0 0 1-1.5 0v-1.554a5.25 5.25 0 0 1-4.5-5.196v-.357a.75.75 0 0 1 .75-.75Z" /></svg>`;
    }

    // Discord-style mic-off: the same mic glyph as _micOnSvg (so "muted" reads
    // as "the mic icon, but slashed" rather than an unrelated shape), plus a
    // bold diagonal slash — not a plain X, which used to be easy to mistake
    // for a generic close/dismiss icon rather than "this person is muted".
    /** @returns {string} mic-off icon SVG markup. */
    _micOffSvg() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path d="M7 4a3 3 0 0 1 6 0v6a3 3 0 1 1-6 0V4Z" /><path d="M5.5 9.643a.75.75 0 0 1 .75.75v.357a3.75 3.75 0 0 0 7.5 0v-.357a.75.75 0 0 1 1.5 0v.357a5.25 5.25 0 0 1-4.5 5.196V17.5a.75.75 0 0 1-1.5 0v-1.554a5.25 5.25 0 0 1-4.5-5.196v-.357a.75.75 0 0 1 .75-.75Z" /><line x1="3" y1="3" x2="17" y2="17" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" /></svg>`;
    }

    /** @returns {string} deafened icon SVG markup (headphones with a slash) — shared by every render spot so the icon only exists once. */
    _deafenSvg() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path d="M10.047 3.062a.75.75 0 0 1 .453.688v12.5a.75.75 0 0 1-1.264.546L5.203 13H2.667a.75.75 0 0 1-.7-.48A6.985 6.985 0 0 1 1.5 10c0-.622.082-1.225.234-1.798a.75.75 0 0 1 .467-.512L5.203 7l4.033-3.796a.75.75 0 0 1 .811-.142ZM13.78 7.22a.75.75 0 1 0-1.06 1.06L14.44 10l-1.72 1.72a.75.75 0 1 0 1.06 1.06l1.72-1.72 1.72 1.72a.75.75 0 1 0 1.06-1.06L16.56 10l1.72-1.72a.75.75 0 1 0-1.06-1.06l-1.72 1.72-1.72-1.72Z" /></svg>`;
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

    /**
     * Shows/hides a peer's deafened-icon badge on their participant card,
     * and applies a solid red ring to their avatar (same box-shadow/
     * drop-shadow `.status-deafened` split as `.status-talking`'s speaking
     * ring, but static rather than pulsing — see tailwind.css). For the
     * local user, also mirrors the ring onto the top-bar identity avatar,
     * same dual-write `setSpeaking()` already does for its own ring.
     * @param {string} peerId
     * @param {boolean} deafened
     * @returns {void}
     */
    updateParticipantDeafen(peerId, deafened) {
        let el = document.getElementById(`participant-${peerId}`);
        if (!el) return;
        const status = el.querySelector('.participant-status-icons');
        let deafIcon = el.querySelector('.participant-deafen-icon');
        if (deafened) {
            if (!deafIcon) {
                deafIcon = document.createElement('span');
                deafIcon.className = 'participant-deafen-icon inline-flex items-center text-red-400';
                deafIcon.dataset.tip = 'Deafened';
                deafIcon.innerHTML = this._deafenSvg();
                status.appendChild(deafIcon);
            }
        } else {
            if (deafIcon) deafIcon.remove();
        }

        const avatar = el.querySelector('.flex-shrink-0 > div:first-child');
        if (avatar) avatar.classList.toggle('status-deafened', deafened);
        if (peerId === this.selfPeerId) {
            document.getElementById('topbar-identity-avatar')?.classList.toggle('status-deafened', deafened);
        }
    }

    /**
     * Shows/hides a peer's raised-hand badge on their participant card and
     * keeps the sidebar's raised-hands queue in sync. `raisedHands` is a
     * Map<peerId, raisedAt-ms> — Map insertion order IS the queue order, so
     * rendering just iterates it; a re-raise re-enters at the back. Session-
     * scoped like peerVolumes/blockedPeerIds (peerIds don't survive a
     * reconnect): cleared in clearAllParticipants(), pruned per-peer in
     * removeParticipant().
     * @param {string} peerId
     * @param {boolean} raised
     * @returns {void}
     */
    updateParticipantHand(peerId, raised) {
        if (raised && !this.raisedHands.has(peerId)) {
            this.raisedHands.set(peerId, Date.now());
        } else if (!raised) {
            this.raisedHands.delete(peerId);
        }

        const el = document.getElementById(`participant-${peerId}`);
        if (el) {
            const status = el.querySelector('.participant-status-icons');
            let handIcon = el.querySelector('.participant-hand-icon');
            if (raised) {
                if (!handIcon && status) {
                    handIcon = document.createElement('span');
                    handIcon.className = 'participant-hand-icon material-symbols-rounded';
                    handIcon.dataset.tip = 'Hand raised';
                    handIcon.textContent = 'front_hand';
                    status.appendChild(handIcon);
                }
            } else {
                if (handIcon) handIcon.remove();
            }
        }

        this._renderRaisedHands();
    }

    /**
     * Rebuilds the `#raised-hands-section` queue at the bottom of the members
     * sidebar from `raisedHands` — hidden entirely while nobody's hand is up,
     * so it costs no sidebar space in the common case. Built with
     * createElement/textContent (nicknames are peer-controlled). Visibility is
     * toggled via inline style.display, not the `.hidden` utility — the
     * unlayered custom `.raised-hands-section` class would beat it in the
     * cascade (standing rule).
     * @returns {void}
     */
    _renderRaisedHands() {
        const section = document.getElementById('raised-hands-section');
        const list = document.getElementById('raised-hands-list');
        if (!section || !list) return;

        if (this.raisedHands.size === 0) {
            section.style.display = 'none';
            list.innerHTML = '';
            return;
        }

        section.style.display = '';
        list.innerHTML = '';
        let i = 1;
        for (const peerId of this.raisedHands.keys()) {
            const row = document.createElement('li');
            row.className = 'raised-hands-row';
            const num = document.createElement('span');
            num.className = 'raised-hands-num';
            num.textContent = `${i++}.`;
            const name = document.createElement('span');
            name.className = 'raised-hands-name';
            name.textContent = this._peerNickname(peerId) + (peerId === this.selfPeerId ? ' (you)' : '');
            row.appendChild(num);
            row.appendChild(name);
            list.appendChild(row);
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
        this._attendees.add(nickname);
        const nameEl = el.querySelector('.participant-name');
        if (nameEl) nameEl.textContent = nickname;
        const avatar = el.querySelector('.flex-shrink-0 > div:first-child');
        if (avatar) this._renderAvatarInto(avatar, peerId, nickname);

        if (peerId === this.selfPeerId) {
            const identityName = document.getElementById('topbar-identity-name');
            const identityAvatar = document.getElementById('topbar-identity-avatar');
            if (identityName) identityName.textContent = nickname;
            if (identityAvatar) this._renderAvatarInto(identityAvatar, peerId, nickname);
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
        const deafened = !document.getElementById('deafen-off-icon') || document.getElementById('deafen-off-icon').classList.contains('hidden');
        // Screen-share audio is opt-in on the receiving end too (Settings ->
        // Audio & Mic) — separate from deafen, which is about not hearing
        // anyone at all, not specifically about a peer's system audio.
        const isScreenAudio = peerId.endsWith('-screen');
        audio.muted = deafened || (isScreenAudio && localStorage.getItem('playShareAudio') !== '1');
        this._applyAudioVolume(peerId);
        // New joiners (and reconnects) get whatever output device was already
        // chosen — setSinkId can reject if the browser doesn't support it or
        // the device has since disappeared, neither of which should break
        // playback on the default device.
        if (this._audioOutputDeviceId && audio.setSinkId) {
            audio.setSinkId(this._audioOutputDeviceId).catch(() => {});
        }
    }

    /**
     * Routes every current (and future — see addAudio above) remote peer's
     * audio through a specific output device. `deviceId` empty/falsy means
     * "system default", which setSinkId('') also means natively.
     * @param {string} deviceId
     * @returns {Promise<void>}
     */
    async setAudioOutputDevice(deviceId) {
        this._audioOutputDeviceId = deviceId || '';
        localStorage.setItem('speakerDeviceId', this._audioOutputDeviceId);
        if (typeof HTMLMediaElement === 'undefined' || !HTMLMediaElement.prototype.setSinkId) return; // unsupported browser — silently a no-op
        const audios = document.querySelectorAll('audio[id^="audio-"]');
        await Promise.all(Array.from(audios).map(a => a.setSinkId(this._audioOutputDeviceId).catch(() => {})));
    }

    /**
     * Re-applies the "Play audio from screen shares" setting to every
     * already-attached screen-share `<audio>` element, so flipping the
     * toggle mid-call takes effect immediately instead of only on the next
     * `addAudio` (which won't come again until the share is restarted).
     * @returns {void}
     */
    applyPlayShareAudio() {
        const deafened = !document.getElementById('deafen-off-icon') || document.getElementById('deafen-off-icon').classList.contains('hidden');
        const enabled = localStorage.getItem('playShareAudio') === '1';
        document.querySelectorAll('audio[id$="-screen"]').forEach((audio) => {
            audio.muted = deafened || !enabled;
        });
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
            btn.dataset.tip = blocked ? 'Unblock' : 'Block';
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
            if (!screenView.dataset.dragged) screenView.style.right = '10.625rem';
            if (!camView.dataset.dragged) camView.style.right = '0.625rem';
        } else if (screenView && !screenView.dataset.dragged) {
            screenView.style.right = '0.625rem';
        } else if (camView && !camView.dataset.dragged) {
            camView.style.right = '0.625rem';
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
            this._autoWatchOrSkip(peerId);
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
                    this._autoWatchOrSkip(remaining[0]);
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
                this._autoWatchOrSkip(remoteStreams[0]);
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

    /** @param {'push-to-talk'|'voice-activity'|string} micMode shows the dock's PTT/VA badge, hidden for any other mode (including 'toggle'). */
    updateMicModeBadge(micMode) {
        const badge = document.getElementById('mic-mode-badge');
        if (!badge) return;
        const labels = { 'push-to-talk': 'PTT', 'voice-activity': 'VA' };
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
                placeholder.style.cssText = 'position:fixed; bottom:0.625rem; right:0.625rem; padding:0.625rem 0.9375rem; background:#000; color:#fff; border-radius:0.25rem; font-size:0.875rem; z-index:1000;';
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
