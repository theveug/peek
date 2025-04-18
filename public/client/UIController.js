// --- public/client/UIController.js ---
export class UIController {
    constructor() {
        this.container = document.getElementById('videos');
        this.chatLog = document.getElementById('chat-log');
        this.videoContainer = document.getElementById('videos');
        this.maxMessages = 100; // adjust as needed
    }

    addStream(peerId, stream) {
        const spinner = document.getElementById(`spinner`);
        const existingVideo = document.querySelector(`[data-peer-id="${peerId}"]`);
        if (existingVideo) {
            // Fully remove existing video and cleanup before adding again
            existingVideo.srcObject.getTracks().forEach(track => track.stop());
            existingVideo.remove();
            spinner.classList.remove('hidden');
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
        } else {
            spinner.classList.add('hidden');
        }

        this.container.appendChild(video);

        this.handleSpinner();
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
            newMessageIndicator.classList.remove('hidden');
        }
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

    handleSpinner() {
        const spinner = document.getElementById(`spinner`);
        const videos = Array.from(this.videoContainer.querySelectorAll('video')).filter((el) => el.dataset['peerId'] != 'me');
        if (videos.length === 0) {
            spinner.classList.remove('hidden');
        } else {
            spinner.classList.add('hidden');
        }
    }

    removeStream(peerId) {
        console.log('(2) Removing stream for peerId:', peerId);
        const video = document.querySelector(`[data-peer-id="${peerId}"]`);
        if (video) video.remove();

        const placeholder = document.getElementById('stream-placeholder');
        if (placeholder) placeholder.remove();

        this.handleSpinner();
    }


}