// --- public/client/PeerManager.js ---
export class PeerManager {
    constructor(socket, ui) {
        this.socket = socket;
        this.ui = ui;
        this.peers = {};
        this.stream = null;
        this.peerId = null;
        this.isSharing = false;
    }

    async handleSignal({ type, peerId, peers, from, payload }) {
        // console.groupCollapsed(`PeerManager.handleSignal(${type})`);
        // console.log('[SIGNAL]', type, { peerId, peers, from, payload });

        switch (type) {
            case 'init':
                this.peerId = peerId;
                peers.forEach(id => {
                    if (this.peerId > id) {
                        this.initiateConnection(id);
                    }
                });
                break;

            case 'peer-joined':
                if (this.peerId > peerId) {
                    this.initiateConnection(peerId);
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

            // Detect when user manually stops sharing
            this.stream.getVideoTracks()[0].onended = () => {
                this.stopSharing();
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


    initiateConnection(peerId) {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        this.peers[peerId] = pc;

        if (this.stream) {
            this.stream.getTracks().forEach(track => pc.addTrack(track, this.stream));
        }

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.send('ice-candidate', peerId, e.candidate);
            }
        };

        pc.ontrack = (e) => {
            this.ui.addStream(peerId, e.streams[0]);
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'disconnected') {
                this.removePeer(peerId);
            }
        };

        pc.createOffer()
            .then(offer => pc.setLocalDescription(offer))
            .then(() => {
                this.send('offer', peerId, pc.localDescription);
            });
    }

    receiveOffer(from, offer) {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        this.peers[from] = pc;

        if (this.stream) {
            this.stream.getTracks().forEach(track => pc.addTrack(track, this.stream));
        }

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.send('ice-candidate', from, e.candidate);
            }
        };

        pc.ontrack = (e) => {
            this.ui.addStream(from, e.streams[0]);
        };

        pc.setRemoteDescription(new RTCSessionDescription(offer))
            .then(() => pc.createAnswer())
            .then(answer => pc.setLocalDescription(answer))
            .then(() => {
                this.send('answer', from, pc.localDescription);
            });
    }

    receiveAnswer(from, answer) {
        this.peers[from].setRemoteDescription(new RTCSessionDescription(answer));
    }

    receiveCandidate(from, candidate) {
        this.peers[from].addIceCandidate(new RTCIceCandidate(candidate));
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
        this.socket.send(JSON.stringify({ type, to, payload }));
    }
}