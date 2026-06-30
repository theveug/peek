// --- public/client/PeerManager.js ---
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
        this.senders = {};
    }

    // Adds every track of `stream` to `pc` and records the resulting RTCRtpSender
    // under this.senders[peerId][kind] ('screen' | 'cam'), so a later watch/unwatch
    // request from that peer can pause/resume this specific connection's sender
    // without touching the other peer connections sharing the same local stream.
    _addTrackedStream(pc, peerId, stream, kind) {
        stream.getTracks().forEach(track => {
            const sender = pc.addTrack(track, stream);
            if (!this.senders[peerId]) this.senders[peerId] = {};
            this.senders[peerId][kind] = sender;
        });
    }

    // Pauses or resumes the video we're sending to `peerId` for the given kind, in
    // response to that peer reporting they've stopped/started watching it. Uses
    // replaceTrack(null) rather than transceiver renegotiation — it stops the encoder
    // (real bandwidth savings) without an SDP offer/answer round-trip.
    async setSenderPaused(peerId, kind, paused) {
        const sender = this.senders[peerId]?.[kind];
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
                // Clean up stale connections from a previous session
                Object.keys(this.peers).forEach(id => this.removePeer(id));

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
                break;

            case 'stop-sharing':
                this.removePeerStream(from);
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
            const resVal = localStorage.getItem('screenShareRes') || '1280x720';
            const fpsVal = localStorage.getItem('screenShareFps') || 30;

            // Parse resolution
            let width, height;
            if (resVal !== 'source') {
                [width, height] = resVal.split('x').map(Number);
            }

            // Build constraint object dynamically
            const videoConstraints = {};
            if (width && height) {
                videoConstraints.width = { max: width };
                videoConstraints.height = { max: height };
            }

            videoConstraints.frameRate = parseInt(fpsVal, 10);

            const constraints = {
                video: videoConstraints,
                audio: false,
                cursor: 'always',
            };

            // Clean up previous screen share stream if active
            if (this.stream) {
                this.stream.getTracks().forEach(t => t.stop());

                Object.entries(this.peers).forEach(([peerId, pc]) => {
                    const sender = this.senders[peerId]?.screen;
                    if (sender) {
                        pc.removeTrack(sender);
                        delete this.senders[peerId].screen;
                    }
                });

                this.ui.removeStream('me');
            }

            this.stream = await navigator.mediaDevices.getDisplayMedia(constraints);
            this.ui.addStream('me', this.stream);
            this.isSharing = true;

            this.stream.getVideoTracks()[0].onended = () => {
                this.stopSharing();
                document.getElementById('share-play-icon')?.classList.remove('hidden');
                document.getElementById('share-stop-icon')?.classList.add('hidden');
            };

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

        const resVal = localStorage.getItem('screenShareRes') || '1280x720';
        const fpsVal = parseInt(localStorage.getItem('screenShareFps') || '30', 10);

        const constraints = {};
        if (resVal !== 'source') {
            const [width, height] = resVal.split('x').map(Number);
            constraints.width = { max: width };
            constraints.height = { max: height };
        }
        constraints.frameRate = fpsVal;

        await track.applyConstraints(constraints);
    }

    async applyCamQualitySettings() {
        if (!this.camStream) return;
        const track = this.camStream.getVideoTracks()[0];
        if (!track) return;

        const resVal = localStorage.getItem('camRes') || '640x480';
        const fpsVal = parseInt(localStorage.getItem('camFps') || '30', 10);

        const constraints = {};
        if (resVal !== 'source') {
            const [width, height] = resVal.split('x').map(Number);
            constraints.width = { max: width };
            constraints.height = { max: height };
        }
        constraints.frameRate = fpsVal;

        await track.applyConstraints(constraints);
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

    _pauseIncomingVideo() {
        Object.values(this.peers).forEach(pc => {
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
                this.ui.addAudio(remotePeerId, e.track);
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
            const msg = JSON.parse(data);
            if (msg.type === 'file-start') {
                if (!this._isFileAllowed(msg.fileName)) {
                    this.ui.showToast(`Blocked incoming file: ${msg.fileName}`, 'leave');
                    return;
                }
                this.incomingTransfers[msg.fileId] = {
                    fileName: msg.fileName, fileSize: msg.fileSize, fileType: msg.fileType,
                    totalChunks: msg.totalChunks, chunks: [], received: 0, from: peerId,
                };
                this.ui.updateFileProgress(msg.fileId, 0, 'download', msg.fileName);
            } else if (msg.type === 'file-end') {
                const t = this.incomingTransfers[msg.fileId];
                if (!t) return;
                const blob = new Blob(t.chunks, { type: t.fileType });
                const url = URL.createObjectURL(blob);
                const nickname = this.ui._peerNickname(peerId);
                this.ui.removeFileProgress(msg.fileId);
                this.ui.addFileMessage(nickname, msg.fileId, t.fileName, t.fileSize, t.fileType, url);
                delete this.incomingTransfers[msg.fileId];
            }
        } else {
            const keys = Object.keys(this.incomingTransfers);
            const activeId = keys.find(id => this.incomingTransfers[id].from === peerId);
            if (!activeId) return;
            const t = this.incomingTransfers[activeId];
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

    async sendFileToAll(file) {
        if (!this._isFileAllowed(file.name)) {
            this.ui.showToast(`Blocked: .${file.name.split('.').pop()} files are not allowed`, 'leave');
            return;
        }

        const MAX_SIZE = 500 * 1024 * 1024;
        if (file.size > MAX_SIZE) {
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
        const blob = new Blob([file], { type: file.type });
        const url = URL.createObjectURL(blob);
        this.ui.addFileMessage('Me', fileId, file.name, file.size, file.type, url);
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

        if (this.stream && !this.senders[from]?.screen) {
            this._addTrackedStream(pc, from, this.stream, 'screen');
        }

        if (this.camStream && !this.senders[from]?.cam) {
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
        delete this.peerCamStreamIds[peerId];
        delete this.senders[peerId];
        this.ui.removeStream(peerId);
        this.ui.removeStream(peerId + '-cam');
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
            const resVal = localStorage.getItem('camRes') || '640x480';
            const fpsVal = localStorage.getItem('camFps') || 30;

            const videoConstraints = {};
            if (resVal !== 'source') {
                const [width, height] = resVal.split('x').map(Number);
                videoConstraints.width = { max: width };
                videoConstraints.height = { max: height };
            }
            videoConstraints.frameRate = parseInt(fpsVal, 10);

            this.camStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
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
                const sender = this.senders[peerId]?.cam;
                if (sender) {
                    pc.removeTrack(sender);
                    delete this.senders[peerId].cam;
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