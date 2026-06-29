import { playSound } from './SoundPlayer.js';
// --- public/client/UIController.js ---
export class UIController {
    constructor() {
        this.container = document.getElementById('videos');
        this.chatLog = document.getElementById('chat-log');
        this.videoContainer = document.getElementById('videos');
        this.thumbnails = document.getElementById('thumbnails');
        this.focusedView = document.getElementById('focused-view');
        this.focusedVideo = document.getElementById('focused-video');
        this.maxMessages = 100;
        this.streams = {};
        this.focusedPeerId = null;
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

        const maxX = 0;
        const minX = viewRect.width - scaledW;
        const maxY = 0;
        const minY = viewRect.height - scaledH;

        this.panX = Math.min(maxX, Math.max(minX, this.panX));
        this.panY = Math.min(maxY, Math.max(minY, this.panY));
    }

    applyTransform() {
        this.focusedVideo.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
        this.focusedView.style.cursor = this.zoom > 1 ? 'grab' : '';
    }

    focusStream(peerId) {
        const stream = this.streams[peerId];
        if (!stream) return;

        this.focusedPeerId = peerId;
        this.focusedVideo.srcObject = stream;
        this.focusedView.style.display = 'flex';
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.applyTransform();

        this.thumbnails.querySelectorAll('.thumb').forEach(t => {
            t.classList.toggle('ring-2', t.dataset.peerId === peerId);
            t.classList.toggle('ring-blue-500', t.dataset.peerId === peerId);
            t.classList.toggle('opacity-50', t.dataset.peerId !== peerId);
        });
    }

    addPeer(peerId) {
        playSound('peerJoin');
    }

    removePeer(peerId) {
        playSound('peerLeft');
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

        const existing = this.thumbnails.querySelector(`[data-peer-id="${peerId}"]`);
        if (existing) {
            existing.querySelector('video').srcObject = stream;
        } else {
            const thumb = document.createElement('div');
            thumb.className = 'thumb relative cursor-pointer rounded overflow-hidden flex-shrink-0';
            thumb.dataset.peerId = peerId;
            thumb.style.cssText = 'width:160px; height:90px;';
            const video = document.createElement('video');
            video.muted = true;
            video.autoplay = true;
            video.playsInline = true;
            video.srcObject = stream;
            video.className = 'w-full h-full object-cover';
            thumb.appendChild(video);
            thumb.addEventListener('click', () => this.focusStream(peerId));
            this.thumbnails.appendChild(thumb);
        }

        playSound('streamUp');
        this.updateLayout();

        if (!this.focusedPeerId || !this.streams[this.focusedPeerId]) {
            this.focusStream(peerId);
        }
    }

    addChatMessage(sender, text) {
        const chatLog = document.getElementById('chat-log');
        const msgContainer = document.createElement('div');

        // Sanitize + parse markdown
        const raw = marked.parse(text);
        const timestanmp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        msgContainer.innerHTML = `<div class="p-2 hover:bg-neutral-950 text-sm"><div class="flex justify-between"><span class="text-blue-600">${sender}:</span><span class="text-neutral-700 text-xs">${timestanmp}</span></div><div class="chat-markdown prose prose-invert">${raw}</div></div>`;
        chatLog.appendChild(msgContainer);

        while (chatLog.children.length > this.maxMessages) {
            chatLog.removeChild(chatLog.firstChild);
        }

        msgContainer.querySelectorAll('pre code').forEach((block) => {
            hljs.highlightElement(block);

            // Add copy button
            const pre = block.parentElement;
            pre.style.position = 'relative';

            const copyBtn = document.createElement('button');
            copyBtn.textContent = '📋';
            copyBtn.title = 'Copy code';
            copyBtn.className = 'copy-btn';

            copyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(block.textContent).then(() => {
                    copyBtn.textContent = '✅';
                    setTimeout(() => (copyBtn.textContent = '📋'), 1500);
                });
            });

            pre.appendChild(copyBtn);
        });
        const newMessageIndicator = document.getElementById('new-message-indicator');
        const chatInput = document.getElementById('chat-input');
        const threshold = chatInput.scrollHeight + 50; // pixels from the bottom to trigger scroll
        const isAtBottom = (chatLog.scrollTop + chatLog.clientHeight) >= (chatLog.scrollHeight - threshold);
        if (isAtBottom) {
            newMessageIndicator.classList.add('hidden');
            requestAnimationFrame(() => {
                chatLog.scrollTo({
                    top: chatLog.scrollHeight,
                    behavior: 'smooth'
                });
            });
        } else {
            console.log('not at bottom', sender, chatLog.scrollTop, chatLog.clientHeight, chatLog.scrollHeight);
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
            return;  // Exit early if not streaming
        }

        if (blurred) {
            if (myVideo) myVideo.style.display = 'none';

            if (!placeholder) {
                placeholder = document.createElement('div');
                placeholder.id = 'stream-placeholder';
                placeholder.textContent = '🟢 Still Streaming...';
                placeholder.style.position = 'fixed';
                placeholder.style.bottom = '10px';
                placeholder.style.right = '10px';
                placeholder.style.padding = '10px 15px';
                placeholder.style.background = '#000';
                placeholder.style.color = '#fff';
                placeholder.style.borderRadius = '4px';
                placeholder.style.fontSize = '14px';
                placeholder.style.zIndex = '1000';
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

        if (remoteStreams.length === 0) {
            spinner.classList.remove('hidden');
            this.focusedView.style.display = 'none';
            this.thumbnails.style.display = 'none';
        } else {
            spinner.classList.add('hidden');
            this.focusedView.style.display = 'flex';
            this.thumbnails.style.display = remoteStreams.length > 1 ? 'flex' : 'none';
        }
    }

    removeStream(peerId) {
        delete this.streams[peerId];

        if (peerId === 'me') {
            const selfView = document.getElementById('self-view');
            if (selfView) {
                playSound('streamDown');
                selfView.remove();
            }
        } else {
            const thumb = this.thumbnails.querySelector(`[data-peer-id="${peerId}"]`);
            if (thumb) {
                playSound('streamDown');
                thumb.remove();
            }

            if (this.focusedPeerId === peerId) {
                this.focusedPeerId = null;
                this.focusedVideo.srcObject = null;
                const remaining = Object.keys(this.streams).filter(id => id !== 'me');
                if (remaining.length > 0) {
                    this.focusStream(remaining[0]);
                }
            }
        }

        const placeholder = document.getElementById('stream-placeholder');
        if (placeholder) placeholder.remove();

        this.updateLayout();
    }


}