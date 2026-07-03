// --- public/client/PeerManager.js ---
const RES_RANK = { '640x360': 0, '640x480': 1, '1280x720': 2, '1920x1080': 3, '2560x1440': 4, source: 5 };

// Caps the effective stream quality as the room fills past the safe mesh size (6).
// Never raises quality above what the user picked in settings, only lowers it.
const QUALITY_TIERS = [
    { max: 6, cap: null },
    { max: 8, cap: { screenRes: '1920x1080', screenFps: 30, camRes: '1280x720', camFps: 24 } },
    { max: 10, cap: { screenRes: '1280x720', screenFps: 24, camRes: '640x480', camFps: 15 } },
    { max: 12, cap: { screenRes: '1280x720', screenFps: 15, camRes: '640x360', camFps: 15 } },
];

export class PeerManager {
    constructor(socket, ui) {
        this.socket = socket;
        this.ui = ui;
        this.peers = {};
        this.stream = null;
        this.peerId = null;
        this.isSharing = false;
        this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
        this.micStream = null;
        this.micEnabled = false;
        this.deafened = false;
        this.status = 'online';
        this._manualStatus = null;
        this.dataChannels = {};
        this.incomingTransfers = {};
        this.camStream = null;
        this.camEnabled = false;
        this.peerCamStreamIds = {};
        this._lastQualityTierKey = null;
        this.peerScreenStreamIds = {};
        this.senders = {};
        this._statsInterval = null;
    }

    // Adds every track of `stream` to `pc` and records the resulting RTCRtpSender
    // under this.senders[peerId]['<kind>-<track.kind>'] (e.g. 'screen-video',
    // 'screen-audio', 'cam-video'), so a later watch/unwatch request from that peer
    // can pause/resume this specific connection's sender without touching the other
    // peer connections sharing the same local stream. Keying by track kind too matters
    // once a stream carries both video and audio (screen share + its audio) — without
    // it the audio sender would silently overwrite the video sender's map entry.
    _addTrackedStream(pc, peerId, stream, kind) {
        stream.getTracks().forEach(track => {
            const sender = pc.addTrack(track, stream);
            if (!this.senders[peerId]) this.senders[peerId] = {};
            this.senders[peerId][`${kind}-${track.kind}`] = sender;
        });
    }

    // Pauses or resumes the video we're sending to `peerId` for the given kind, in
    // response to that peer reporting they've stopped/started watching it. Uses
    // replaceTrack(null) rather than transceiver renegotiation — it stops the encoder
    // (real bandwidth savings) without an SDP offer/answer round-trip.
    async setSenderPaused(peerId, kind, paused) {
        const sender = this.senders[peerId]?.[`${kind}-video`];
        if (!sender) return;
        try {
            if (paused) {
                await sender.replaceTrack(null);
            } else {
                const liveStream = kind === 'cam' ? this.camStream : this.stream;
                await sender.replaceTrack(liveStream?.getVideoTracks()[0] || null);
            }
        } catch (err) {
            console.warn(`Failed to ${paused ? 'pause' : 'resume'} ${kind} sender for ${peerId}:`, err);
        }
    }

    // Called by UIController when the local user starts/stops watching a remote
    // stream (streamKey is peerId for screen share, peerId-cam for webcam).
    setWatched(streamKey, watched) {
        const isCam = streamKey.endsWith('-cam');
        const peerId = isCam ? streamKey.slice(0, -4) : streamKey;
        this.send(watched ? 'watch-stream' : 'unwatch-stream', peerId, { kind: isCam ? 'cam' : 'screen' });
    }

    async handleSignal({ type, peerId, peers, from, payload, iceServers }) {
        // console.groupCollapsed(`PeerManager.handleSignal(${type})`);
        // console.log('[SIGNAL]', type, { peerId, peers, from, payload });

        switch (type) {
            case 'init':
                // Clean up stale connections/UI from a previous session (e.g. a server
                // restart or network blip triggered App.js's auto-reconnect). Every
                // peerId, including our own, is reassigned per connection, so old
                // participant cards are now orphaned and must be cleared explicitly.
                Object.keys(this.peers).forEach(id => this.removePeer(id));
                this.ui.clearAllParticipants();

                this.peerId = peerId;
                if (iceServers) this.iceServers = iceServers;
                this.ui.addSelf(peerId);
                peers.forEach(id => {
                    this.ui.addParticipant(id);
                    if (this.peerId > id) {
                        this.initiateConnection(id);
                    }
                });
                setTimeout(() => {
                    this.broadcastMicStatus();
                    this.broadcastDeafenStatus();
                    this.broadcastNickname();
                    this.broadcastStatus();
                }, 500);
                break;

            case 'peer-joined':
                if (this.peerId > peerId) {
                    this.initiateConnection(peerId);
                    this.ui.addPeer(peerId);
                }
                this.broadcastMicStatus();
                this.broadcastDeafenStatus();
                this.broadcastNickname();
                this.broadcastStatus();
                this.broadcastCamStreamId();
                this.applyQualitySettings();
                this.applyCamQualitySettings();
                this._announceQualityTierChange();
                break;

            case 'offer':
                this.receiveOffer(from, payload);
                break;

            case 'answer':
                this.receiveAnswer(from, payload);
                break;

            case 'ice-candidate':
                this.receiveCandidate(from, payload);
                break;

            case 'peer-left':
                this.removePeer(peerId);
                this.ui.removePeer(peerId);
                this.applyQualitySettings();
                this.applyCamQualitySettings();
                this._announceQualityTierChange();
                break;

            case 'start-sharing':
                this.peerScreenStreamIds[from] = payload.streamId;
                break;

            case 'stop-sharing':
                delete this.peerScreenStreamIds[from];
                this.removePeerStream(from);
                this.ui.removeAudio(from + '-screen');
                break;

            case 'webcam-start':
                this.peerCamStreamIds[from] = payload.streamId;
                break;

            case 'webcam-stop':
                delete this.peerCamStreamIds[from];
                this.ui.removeStream(from + '-cam');
                break;

            case 'watch-stream':
                this.setSenderPaused(from, payload.kind, false);
                break;

            case 'unwatch-stream':
                this.setSenderPaused(from, payload.kind, true);
                break;

            case 'mic-status':
                this.ui.updateParticipantMic(from, payload.enabled);
                break;

            case 'deafen-status':
                this.ui.updateParticipantDeafen(from, payload.deafened);
                break;

            case 'nickname-update':
                this.ui.updateParticipantNickname(from, payload.nickname);
                break;

            case 'status-update':
                this.ui.updateParticipantStatus(from, payload.status);
                break;

            case 'typing':
                this.ui.updateTypingIndicator(from, payload.isTyping);
                break;
        }
        // console.groupEnd();
    }

    async startSharing() {
        try {
            const constraints = {
                video: this._resolveQuality('screen'),
                audio: true,
                cursor: 'always',
            };

            // Request the new source first — if the user cancels the picker while
            // switching windows, the currently-active share must keep running untouched.
            const newStream = await navigator.mediaDevices.getDisplayMedia(constraints);

            // Now tear down the previous screen share stream, if any (switching source)
            if (this.stream) {
                this.stream.getTracks().forEach(t => t.stop());

                Object.entries(this.peers).forEach(([peerId, pc]) => {
                    ['screen-video', 'screen-audio'].forEach(key => {
                        const sender = this.senders[peerId]?.[key];
                        if (sender) {
                            pc.removeTrack(sender);
                            delete this.senders[peerId][key];
                        }
                    });
                });

                this.ui.removeStream('me');
            }

            this.stream = newStream;
            this.ui.addStream('me', this.stream);
            this.isSharing = true;

            this.stream.getVideoTracks()[0].onended = () => {
                this.stopSharing();
                document.getElementById('stop-share-button')?.classList.add('hidden');
                document.getElementById('share-toggle').title = 'Share screen';
            };

            // Signal peers about the stream ID before tracks arrive via WebRTC, so
            // they can tell this stream's audio track apart from mic audio in ontrack.
            this.send('start-sharing', null, { streamId: this.stream.id });

            // Add tracks to existing connections
            Object.entries(this.peers).forEach(async ([peerId, pc]) => {
                this._addTrackedStream(pc, peerId, this.stream, 'screen');

                // Now explicitly create and send offer
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                this.send('offer', peerId, offer);
            });

        } catch (err) {
            console.warn('User cancelled screen share:', err);
        }
    }

    async applyQualitySettings() {
        if (!this.stream) return;
        const track = this.stream.getVideoTracks()[0];
        if (!track) return;
        await track.applyConstraints(this._resolveQuality('screen'));
    }

    async applyCamQualitySettings() {
        if (!this.camStream) return;
        const track = this.camStream.getVideoTracks()[0];
        if (!track) return;
        await track.applyConstraints(this._resolveQuality('cam'));
    }

    // Returns the cap for the current room size, or null if the room is small
    // enough (<=6) that the user's chosen settings apply unmodified.
    _qualityTier() {
        const peerCount = Object.keys(this.peers).length + 1;
        const tier = QUALITY_TIERS.find(t => peerCount <= t.max);
        return tier ? tier.cap : QUALITY_TIERS[QUALITY_TIERS.length - 1].cap;
    }

    _capResolution(userVal, capVal) {
        if (!capVal) return userVal;
        if (userVal === 'source') return capVal;
        return (RES_RANK[userVal] ?? 99) <= (RES_RANK[capVal] ?? 99) ? userVal : capVal;
    }

    _capFps(userVal, capVal) {
        return capVal ? Math.min(userVal, capVal) : userVal;
    }

    // Builds getUserMedia/applyConstraints-style video constraints for 'screen' or
    // 'cam', honoring the user's saved settings but never exceeding the current
    // room-size quality tier.
    _resolveQuality(kind) {
        const isCam = kind === 'cam';
        const resVal = localStorage.getItem(isCam ? 'camRes' : 'screenShareRes') || (isCam ? '640x480' : '1280x720');
        const fpsVal = parseInt(localStorage.getItem(isCam ? 'camFps' : 'screenShareFps') || '30', 10);

        const tier = this._qualityTier();
        const cappedRes = this._capResolution(resVal, tier ? (isCam ? tier.camRes : tier.screenRes) : null);
        const cappedFps = this._capFps(fpsVal, tier ? (isCam ? tier.camFps : tier.screenFps) : null);

        const constraints = {};
        if (cappedRes !== 'source') {
            const [width, height] = cappedRes.split('x').map(Number);
            constraints.width = { max: width };
            constraints.height = { max: height };
        }
        constraints.frameRate = cappedFps;
        return constraints;
    }

    // Toasts only on an actual tier transition (not on every join/leave), and only
    // while there's an active screen/cam stream for the cap to matter to.
    _announceQualityTierChange() {
        const tier = this._qualityTier();
        const key = tier ? JSON.stringify(tier) : null;
        if (key === this._lastQualityTierKey) return;
        const hadCap = !!this._lastQualityTierKey;
        this._lastQualityTierKey = key;

        if (!this.stream && !this.camStream) return;
        if (tier) {
            this.ui.showToast(`Lowered stream quality (room has ${Object.keys(this.peers).length + 1} participants)`, 'info');
        } else if (hadCap) {
            this.ui.showToast('Stream quality restored', 'info');
        }
    }

    _connectionQualityFromStats(rtt, lossRate) {
        if (rtt === null) return 'unknown';
        const ms = rtt * 1000;
        if (lossRate > 0.08 || ms >= 400) return 'poor';
        if (ms >= 200) return 'fair';
        if (ms >= 100) return 'good';
        return 'excellent';
    }

    async _pollConnectionStats() {
        for (const [peerId, pc] of Object.entries(this.peers)) {
            try {
                const stats = await pc.getStats();
                let rtt = null;
                let packetsLost = 0;
                let packetsReceived = 0;
                stats.forEach(r => {
                    if (r.type === 'candidate-pair' && r.nominated) rtt = r.currentRoundTripTime ?? null;
                    if (r.type === 'inbound-rtp') {
                        packetsLost += r.packetsLost || 0;
                        packetsReceived += r.packetsReceived || 0;
                    }
                });
                const total = packetsReceived + packetsLost;
                const lossRate = total > 0 ? packetsLost / total : 0;
                this.ui.updateConnectionQuality(peerId, this._connectionQualityFromStats(rtt, lossRate));
            } catch (_) {}
        }
    }

    _startStatsPolling() {
        if (this._statsInterval) return;
        this._statsInterval = setInterval(() => this._pollConnectionStats(), 3000);
    }

    _stopStatsPolling() {
        clearInterval(this._statsInterval);
        this._statsInterval = null;
    }

    async toggleMic() {
        if (!this.micStream) {
            try {
                this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                const audioTrack = this.micStream.getAudioTracks()[0];
                this.micEnabled = true;

                for (const [peerId, pc] of Object.entries(this.peers)) {
                    pc.addTrack(audioTrack, this.micStream);
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    this.send('offer', peerId, offer);
                }
            } catch (err) {
                console.warn('Mic access denied:', err);
                return false;
            }
        } else {
            this.micEnabled = !this.micEnabled;
            this.micStream.getAudioTracks().forEach(t => { t.enabled = this.micEnabled; });
        }

        this.broadcastMicStatus();
        return this.micEnabled;
    }

    broadcastMicStatus() {
        this.send('mic-status', null, { enabled: this.micEnabled });
    }

    broadcastDeafenStatus() {
        this.send('deafen-status', null, { deafened: this.deafened || false });
    }

    broadcastNickname() {
        const nickname = (localStorage.getItem('nickname') || 'Anonymous').trim();
        this.send('nickname-update', null, { nickname });
    }

    setStatus(status) {
        this.status = status;
        this.send('status-update', null, { status });
        this.ui.updateParticipantStatus(this.peerId, status);
    }

    setManualStatus(status) {
        this._manualStatus = status;
        this.setStatus(status);
    }

    broadcastStatus() {
        this.send('status-update', null, { status: this.status });
    }

    handleTabVisibility(hidden) {
        if (hidden) {
            this._pauseIncomingVideo();
            if (this._manualStatus !== 'dnd') {
                this.setStatus('away');
            }
        } else {
            this._resumeIncomingVideo();
            if (this._manualStatus !== 'dnd') {
                this.setStatus(this._manualStatus || 'online');
            }
        }
    }

    // A peer's video stays enabled if its stream is the one currently floating
    // in native picture-in-picture — tab-hidden doesn't mean unwatched there.
    _isPeerInPictureInPicture(peerId) {
        if (document.pictureInPictureElement !== this.ui.focusedVideo) return false;
        const focusedPeerId = this.ui.focusedPeerId;
        if (!focusedPeerId) return false;
        const basePeerId = focusedPeerId.endsWith('-cam') ? focusedPeerId.slice(0, -4) : focusedPeerId;
        return basePeerId === peerId;
    }

    _pauseIncomingVideo() {
        Object.entries(this.peers).forEach(([peerId, pc]) => {
            if (this._isPeerInPictureInPicture(peerId)) return;
            pc.getReceivers().forEach(r => {
                if (r.track && r.track.kind === 'video') {
                    r.track.enabled = false;
                }
            });
        });
    }

    _resumeIncomingVideo() {
        Object.values(this.peers).forEach(pc => {
            pc.getReceivers().forEach(r => {
                if (r.track && r.track.kind === 'video') {
                    r.track.enabled = true;
                }
            });
        });
    }

    stopSharing() {
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }

        this.ui.removeStream('me');
        this.isSharing = false;

        // Notify peers that streaming stopped
        this.send('stop-sharing', null, {});
    }


    createPeerConnection(remotePeerId) {
        const pc = new RTCPeerConnection({ iceServers: this.iceServers });

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.send('ice-candidate', remotePeerId, e.candidate);
            }
        };

        pc.ontrack = (e) => {
            if (e.track.kind === 'audio') {
                const screenStreamId = this.peerScreenStreamIds[remotePeerId];
                const isScreenAudio = screenStreamId && e.streams[0]?.id === screenStreamId;
                this.ui.addAudio(isScreenAudio ? remotePeerId + '-screen' : remotePeerId, e.track);
            } else {
                const stream = e.streams[0] || new MediaStream([e.track]);
                const camStreamId = this.peerCamStreamIds[remotePeerId];
                const streamKey = (camStreamId && stream.id === camStreamId)
                    ? remotePeerId + '-cam'
                    : remotePeerId;
                this.ui.addStream(streamKey, stream);
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                this.removePeer(remotePeerId);
            }
        };

        const dc = pc.createDataChannel('file-transfer', { ordered: true });
        dc.binaryType = 'arraybuffer';
        this._setupDataChannel(dc, remotePeerId);

        pc.ondatachannel = (e) => {
            e.channel.binaryType = 'arraybuffer';
            this._setupDataChannel(e.channel, remotePeerId);
        };

        if (Object.keys(this.peers).length === 0) this._startStatsPolling();
        this.peers[remotePeerId] = pc;
        return pc;
    }

    _setupDataChannel(dc, peerId) {
        dc.onopen = () => { this.dataChannels[peerId] = dc; };
        dc.onclose = () => { delete this.dataChannels[peerId]; };
        dc.onmessage = (e) => this._handleDataChannelMessage(peerId, e.data);
    }

    _handleDataChannelMessage(peerId, data) {
        if (typeof data === 'string') {
            let msg;
            try {
                msg = JSON.parse(data);
            } catch {
                return; // malformed message from a peer — drop, don't throw
            }
            if (msg.type === 'file-start') {
                if (!this._isFileAllowed(msg.fileName)) {
                    this.ui.showToast(`Blocked incoming file: ${msg.fileName}`, 'leave');
                    return;
                }
                const fileSize = Number(msg.fileSize);
                if (!Number.isFinite(fileSize) || fileSize < 0 || fileSize > this._maxFileSize) {
                    this.ui.showToast(`Blocked incoming file: ${msg.fileName} (too large)`, 'leave');
                    return;
                }
                this.incomingTransfers[msg.fileId] = {
                    fileName: msg.fileName, fileSize, fileType: this._safeMimeType(msg.fileName),
                    totalChunks: msg.totalChunks, chunks: [], received: 0, receivedBytes: 0, from: peerId,
                };
                this.ui.updateFileProgress(msg.fileId, 0, 'download', msg.fileName);
            } else if (msg.type === 'file-end') {
                const t = this.incomingTransfers[msg.fileId];
                if (!t) return;
                const blob = new Blob(t.chunks, { type: t.fileType });
                const url = URL.createObjectURL(blob);
                const nickname = this.ui._peerNickname(peerId);
                this.ui.removeFileProgress(msg.fileId);
                this.ui.addFileMessage(nickname, msg.fileId, t.fileName, t.fileSize, t.fileType, url, blob);
                delete this.incomingTransfers[msg.fileId];
            } else if (msg.type === 'poll-create') {
                const nickname = this.ui._peerNickname(peerId);
                this.ui.addPollMessage(nickname, msg.pollId, msg.question, msg.options, this.peerId);
            } else if (msg.type === 'poll-vote') {
                this.ui.updatePollVote(msg.pollId, msg.optionIndex, msg.voterId);
            } else if (msg.type === 'chat') {
                this.ui.addChatMessage(this.ui._peerNickname(peerId), msg.text, msg.messageId, msg.replyTo || null);
                this.ui.updateTypingIndicator(peerId, false);
            } else if (msg.type === 'reaction') {
                this.ui.addReaction(msg.messageId, msg.emoji, msg.nickname, peerId);
            } else if (msg.type === 'typing') {
                this.ui.updateTypingIndicator(peerId, msg.isTyping);
            }
        } else {
            const keys = Object.keys(this.incomingTransfers);
            const activeId = keys.find(id => this.incomingTransfers[id].from === peerId);
            if (!activeId) return;
            const t = this.incomingTransfers[activeId];
            // Enforce the declared size on the receive side — the sender's own size check
            // is honor-system, a modified client can stream unbounded chunks.
            t.receivedBytes += data.byteLength ?? data.size ?? 0;
            if (t.receivedBytes > t.fileSize + 65536) {
                delete this.incomingTransfers[activeId];
                this.ui.removeFileProgress(activeId);
                this.ui.showToast(`Blocked incoming file: ${t.fileName} (exceeded declared size)`, 'leave');
                return;
            }
            t.chunks.push(data);
            t.received++;
            const progress = t.totalChunks > 0 ? t.received / t.totalChunks : 0;
            this.ui.updateFileProgress(activeId, progress, 'download', t.fileName);
        }
    }

    _allowedExtensions = new Set([
        // Images
        'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
        // Documents
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
        // Text & code
        'txt', 'md', 'csv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log',
        'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'scss', 'less', 'py', 'rb', 'go', 'rs',
        'java', 'kt', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'swift', 'lua', 'sh', 'sql',
        // Archives
        'zip', 'tar', 'gz', 'bz2', '7z', 'rar',
        // Audio & video
        'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a',
        'mp4', 'webm', 'mkv', 'avi', 'mov',
        // Fonts
        'woff', 'woff2', 'ttf', 'otf', 'eot',
    ]);

    _isFileAllowed(fileName) {
        const ext = fileName.split('.').pop().toLowerCase();
        return this._allowedExtensions.has(ext);
    }

    _maxFileSize = 500 * 1024 * 1024;

    _rasterMimeByExt = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
        webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon',
    };

    // The peer-supplied MIME type is untrusted: a blob typed image/svg+xml (or text/html)
    // opened via its blob: URL runs scripts in THIS origin. Derive the type from the
    // extension instead — raster images keep a previewable MIME, everything else
    // (including svg) becomes an opaque binary that only gets download links.
    _safeMimeType(fileName) {
        const ext = (fileName || '').split('.').pop().toLowerCase();
        return this._rasterMimeByExt[ext] || 'application/octet-stream';
    }

    async sendFileToAll(file) {
        if (!this._isFileAllowed(file.name)) {
            this.ui.showToast(`Blocked: .${file.name.split('.').pop()} files are not allowed`, 'leave');
            return;
        }

        if (file.size > this._maxFileSize) {
            this.ui.showToast(`File too large (max 500 MB)`, 'leave');
            return;
        }

        const fileId = 'file-' + Date.now() + '-' + Math.random().toString(36).substr(2, 8);
        const CHUNK_SIZE = 16384;
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

        const meta = { type: 'file-start', fileId, fileName: file.name, fileSize: file.size, fileType: file.type, totalChunks };

        const peerIds = Object.keys(this.dataChannels);
        if (peerIds.length === 0) return;

        this.ui.updateFileProgress(fileId, 0, 'upload', file.name);

        for (const pid of peerIds) {
            const dc = this.dataChannels[pid];
            if (!dc || dc.readyState !== 'open') continue;
            dc.send(JSON.stringify(meta));
        }

        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const slice = file.slice(start, start + CHUNK_SIZE);
            const buffer = await slice.arrayBuffer();

            for (const pid of peerIds) {
                const dc = this.dataChannels[pid];
                if (!dc || dc.readyState !== 'open') continue;

                while (dc.bufferedAmount > 1024 * 1024) {
                    await new Promise(r => {
                        dc.bufferedAmountLowThreshold = 256 * 1024;
                        dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); };
                    });
                }
                dc.send(buffer);
            }

            this.ui.updateFileProgress(fileId, (i + 1) / totalChunks, 'upload', file.name);
        }

        for (const pid of peerIds) {
            const dc = this.dataChannels[pid];
            if (!dc || dc.readyState !== 'open') continue;
            dc.send(JSON.stringify({ type: 'file-end', fileId }));
        }

        this.ui.removeFileProgress(fileId);
        const safeType = this._safeMimeType(file.name);
        const blob = new Blob([file], { type: safeType });
        const url = URL.createObjectURL(blob);
        this.ui.addFileMessage('Me', fileId, file.name, file.size, safeType, url, blob);
    }

    broadcastChat(text, nickname, messageId, replyTo) {
        const msg = JSON.stringify({ type: 'chat', text, nickname, messageId, replyTo: replyTo || null });
        for (const dc of Object.values(this.dataChannels)) {
            if (dc.readyState === 'open') dc.send(msg);
        }
    }

    broadcastReaction(messageId, emoji, nickname) {
        const msg = JSON.stringify({ type: 'reaction', messageId, emoji, nickname });
        for (const dc of Object.values(this.dataChannels)) {
            if (dc.readyState === 'open') dc.send(msg);
        }
    }

    broadcastTyping(isTyping) {
        const msg = JSON.stringify({ type: 'typing', isTyping });
        for (const dc of Object.values(this.dataChannels)) {
            if (dc.readyState === 'open') dc.send(msg);
        }
    }

    broadcastPollCreate(pollId, question, options) {
        const msg = JSON.stringify({ type: 'poll-create', pollId, question, options });
        for (const dc of Object.values(this.dataChannels)) {
            if (dc.readyState === 'open') dc.send(msg);
        }
    }

    broadcastPollVote(pollId, optionIndex) {
        const msg = JSON.stringify({ type: 'poll-vote', pollId, optionIndex, voterId: this.peerId });
        for (const dc of Object.values(this.dataChannels)) {
            if (dc.readyState === 'open') dc.send(msg);
        }
    }

    initiateConnection(peerId) {
        const pc = this.createPeerConnection(peerId);

        if (this.stream) {
            this._addTrackedStream(pc, peerId, this.stream, 'screen');
        } else {
            pc.addTransceiver('video', { direction: 'recvonly' });
        }

        if (this.camStream) {
            this._addTrackedStream(pc, peerId, this.camStream, 'cam');
        }

        if (this.micStream) {
            this.micStream.getTracks().forEach(track => pc.addTrack(track, this.micStream));
        } else {
            pc.addTransceiver('audio', { direction: 'recvonly' });
        }

        pc.createOffer()
            .then(offer => pc.setLocalDescription(offer))
            .then(() => {
                this.send('offer', peerId, pc.localDescription);
            });
    }

    async receiveOffer(from, offer) {
        let pc = this.peers[from];

        if (!pc) {
            pc = this.createPeerConnection(from);
        }

        await pc.setRemoteDescription(new RTCSessionDescription(offer));

        if (this.stream && !this.senders[from]?.['screen-video']) {
            this._addTrackedStream(pc, from, this.stream, 'screen');
        }

        if (this.camStream && !this.senders[from]?.['cam-video']) {
            this._addTrackedStream(pc, from, this.camStream, 'cam');
        }

        if (this.micStream) {
            const hasAudioSender = pc.getSenders().some(s => s.track && s.track.kind === 'audio');
            if (!hasAudioSender) {
                this.micStream.getTracks().forEach(track => pc.addTrack(track, this.micStream));
            }
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send('answer', from, pc.localDescription);
    }

    receiveAnswer(from, answer) {
        const pc = this.peers[from];
        if (pc) {
            pc.setRemoteDescription(new RTCSessionDescription(answer));
        }
    }

    receiveCandidate(from, candidate) {
        const pc = this.peers[from];
        if (pc) {
            pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    }

    removePeer(peerId) {
        const pc = this.peers[peerId];
        if (pc) pc.close();
        delete this.peers[peerId];
        if (Object.keys(this.peers).length === 0) this._stopStatsPolling();
        delete this.peerCamStreamIds[peerId];
        delete this.peerScreenStreamIds[peerId];
        delete this.senders[peerId];
        this.ui.removeStream(peerId);
        this.ui.removeStream(peerId + '-cam');
        this.ui.removeAudio(peerId + '-screen');
    }

    removePeerStream(peerId) {
        const pc = this.peers[peerId];
        if (pc) {
            pc.getSenders().forEach(sender => {
                if (sender.track) {
                    pc.removeTrack(sender);
                }
            });
        }
        this.ui.removeStream(peerId);
    }



    async toggleCam() {
        if (this.camEnabled) {
            this.stopCam();
            return false;
        }
        if (!navigator.mediaDevices?.getUserMedia) {
            this.ui.showToast('Camera requires a secure connection (HTTPS)', 'info');
            return false;
        }

        try {
            this.camStream = await navigator.mediaDevices.getUserMedia({ video: this._resolveQuality('cam'), audio: false });
            this.camEnabled = true;

            this.camStream.getVideoTracks()[0].onended = () => {
                this.stopCam();
                document.getElementById('cam-on-icon')?.classList.add('hidden');
                document.getElementById('cam-off-icon')?.classList.remove('hidden');
            };

            // Signal peers about the stream ID before tracks arrive via WebRTC
            this.send('webcam-start', null, { streamId: this.camStream.id });

            this.ui.addStream('me-cam', this.camStream);

            for (const [peerId, pc] of Object.entries(this.peers)) {
                this._addTrackedStream(pc, peerId, this.camStream, 'cam');
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                this.send('offer', peerId, offer);
            }

            return true;
        } catch (err) {
            console.warn('Camera error:', err);
            this.camStream = null;
            this.camEnabled = false;
            const msg = err.name === 'NotAllowedError' ? 'Camera permission denied'
                : err.name === 'NotFoundError' ? 'No camera found on this device'
                : 'Could not access camera';
            this.ui.showToast(msg, 'info');
            return false;
        }
    }

    stopCam() {
        if (this.camStream) {
            this.camStream.getTracks().forEach(t => t.stop());
            Object.entries(this.peers).forEach(([peerId, pc]) => {
                const sender = this.senders[peerId]?.['cam-video'];
                if (sender) {
                    pc.removeTrack(sender);
                    delete this.senders[peerId]['cam-video'];
                }
            });
            this.camStream = null;
        }
        this.camEnabled = false;
        this.ui.removeStream('me-cam');
        this.send('webcam-stop', null, {});
    }

    broadcastCamStreamId() {
        if (this.camStream) {
            this.send('webcam-start', null, { streamId: this.camStream.id });
        }
    }

    send(type, to, payload) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type, to, payload }));
        }
    }
}