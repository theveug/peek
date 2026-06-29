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
                peers.forEach(id => {
                    if (this.peerId > id) {
                        this.initiateConnection(id);
                    }
                });
                break;

            case 'peer-joined':
                if (this.peerId > peerId) {
                    this.initiateConnection(peerId);
                    this.ui.addPeer(peerId);
                }
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

            // Clean up previous stream if active
            if (this.stream) {
                this.stream.getTracks().forEach(t => t.stop());

                Object.values(this.peers).forEach(pc => {
                    pc.getSenders().forEach(sender => {
                        if (sender.track && sender.track.kind === 'video') {
                            pc.removeTrack(sender);
                        }
                    });
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
                this.stream.getTracks().forEach(track => pc.addTrack(track, this.stream));

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

    async toggleMic() {
        if (this.micEnabled) {
            this.muteMic();
        } else {
            await this.unmuteMic();
        }
        return this.micEnabled;
    }

    async unmuteMic() {
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
        }
    }

    muteMic() {
        if (this.micStream) {
            this.micStream.getTracks().forEach(t => t.stop());
            this.micStream = null;
        }

        Object.values(this.peers).forEach(pc => {
            pc.getSenders().forEach(sender => {
                if (sender.track && sender.track.kind === 'audio') {
                    pc.removeTrack(sender);
                }
            });
        });

        this.micEnabled = false;
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
                this.ui.addStream(remotePeerId, stream);
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                this.removePeer(remotePeerId);
            }
        };

        this.peers[remotePeerId] = pc;
        return pc;
    }

    initiateConnection(peerId) {
        const pc = this.createPeerConnection(peerId);

        if (this.stream) {
            this.stream.getTracks().forEach(track => pc.addTrack(track, this.stream));
        } else {
            pc.addTransceiver('video', { direction: 'recvonly' });
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

        if (this.stream) {
            const hasVideoSender = pc.getSenders().some(s => s.track && s.track.kind === 'video');
            if (!hasVideoSender) {
                this.stream.getTracks().forEach(track => pc.addTrack(track, this.stream));
            }
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
        this.ui.removeStream(peerId);
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



    send(type, to, payload) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type, to, payload }));
        }
    }
}