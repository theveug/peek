// --- public/client/UIController.js ---
export class UIController {
    constructor() {
        this.container = document.getElementById('videos');
        this.chatLog = document.getElementById('chat-log');
        this.videoContainer = document.getElementById('videos');
    }

    addStream(peerId, stream) {
        const existingVideo = document.querySelector(`[data-peer-id="${peerId}"]`);
        if (existingVideo) {
            // Fully remove existing video and cleanup before adding again
            existingVideo.srcObject.getTracks().forEach(track => track.stop());
            existingVideo.remove();
        }

        const video = document.createElement('video');
        video.muted = true;
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = stream;
        video.dataset.peerId = peerId;

        if (peerId === 'me') {
            video.style.position = 'fixed';
            video.style.bottom = '10px';
            video.style.right = '10px';
            video.style.width = '150px';
            video.style.border = '2px solid #ccc';
            video.style.zIndex = 1000;
        }

        this.container.appendChild(video);
    }


    removeStream(peerId) {
        const video = document.querySelector(`[data-peer-id="${peerId}"]`);
        if (video && video.srcObject) {
            video.srcObject.getTracks().forEach(track => track.stop());
            video.srcObject = null;
            video.remove();
        }

        const placeholder = document.getElementById('stream-placeholder');
        if (placeholder && peerId === 'me') placeholder.remove();
    }


    addChatMessage(from, text) {
        const message = document.createElement('div');
        message.textContent = `${from}: ${text}`;
        this.chatLog.appendChild(message);
        this.chatLog.scrollTop = this.chatLog.scrollHeight;
    }

    handleVisibilityChange(blurred) {
        const myVideo = document.querySelector('[data-peer-id="me"]');
        let placeholder = document.getElementById('stream-placeholder');

        // Only do something if the user is actually streaming
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

    removeStream(peerId) {
        const video = document.querySelector(`[data-peer-id="${peerId}"]`);
        if (video) video.remove();

        const placeholder = document.getElementById('stream-placeholder');
        if (placeholder) placeholder.remove();
    }


}