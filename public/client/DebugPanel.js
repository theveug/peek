export class DebugPanel {
    constructor(peerManager) {
        this.peerManager = peerManager;
        this.socket = null;
        this.panel = null;
        this.visible = false;
        this.interval = null;
        this.createPanel();
    }

    createPanel() {
        this.panel = document.createElement('div');
        this.panel.id = 'debug-panel';
        this.panel.style.cssText = `
            position: fixed; top: 10px; left: 10px; z-index: 9999;
            background: rgba(0,0,0,0.9); color: #0f0; font-family: monospace;
            font-size: 12px; padding: 12px; border-radius: 6px;
            border: 1px solid #333; max-width: 380px; display: none;
            max-height: 90vh; overflow-y: auto;
        `;
        document.body.appendChild(this.panel);

        const btn = document.createElement('button');
        btn.textContent = 'DBG';
        btn.style.cssText = `
            position: fixed; top: 10px; right: 10px; z-index: 10000;
            background: rgba(0,0,0,0.7); color: #0f0; font-family: monospace;
            font-size: 11px; padding: 4px 8px; border-radius: 4px;
            border: 1px solid #333; cursor: pointer;
        `;
        btn.addEventListener('click', () => this.toggle());
        document.body.appendChild(btn);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'F2') {
                this.toggle();
            }
        });
    }

    toggle() {
        this.visible = !this.visible;
        this.panel.style.display = this.visible ? 'block' : 'none';
        if (this.visible) {
            this.update();
            this.interval = setInterval(() => this.update(), 1000);
        } else {
            clearInterval(this.interval);
        }
    }

    setSocket(socket) {
        this.socket = socket;
    }

    update() {
        const ws = this.socket;
        const pm = this.peerManager;

        const wsStates = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
        const wsState = ws ? wsStates[ws.readyState] : 'NULL';
        const wsColor = ws?.readyState === 1 ? '#0f0' : '#f44';

        let html = `
            <div style="margin-bottom:8px; font-size:14px; color:#fff; border-bottom:1px solid #333; padding-bottom:4px;">
                Debug Panel <span style="color:#666; font-size:11px;">(Ctrl+\` to toggle)</span>
            </div>
            <div style="margin-bottom:8px;">
                <span style="color:#888;">Session:</span> ${location.pathname.split('/').pop()}<br>
                <span style="color:#888;">Peer ID:</span> ${pm.peerId ? pm.peerId.substring(0, 8) + '...' : 'none'}<br>
                <span style="color:#888;">WebSocket:</span> <span style="color:${wsColor};">${wsState}</span><br>
                <span style="color:#888;">Sharing:</span> ${pm.isSharing ? '<span style="color:#0f0;">YES</span>' : '<span style="color:#f44;">NO</span>'}
            </div>
        `;

        // ICE servers
        html += `<div style="margin-bottom:8px; border-top:1px solid #333; padding-top:4px;">
            <span style="color:#fff;">ICE Servers:</span><br>`;
        pm.iceServers.forEach(server => {
            const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
            urls.forEach(url => {
                const isTurn = url.startsWith('turn');
                html += `<span style="color:${isTurn ? '#ff0' : '#0ff'};">${isTurn ? 'TURN' : 'STUN'}</span> ${url}<br>`;
            });
            if (server.username) {
                html += `<span style="color:#888;">  user:</span> ${server.username}<br>`;
            }
        });
        html += `</div>`;

        // Peer connections
        const peerIds = Object.keys(pm.peers);
        html += `<div style="border-top:1px solid #333; padding-top:4px;">
            <span style="color:#fff;">Peers (${peerIds.length}):</span><br>`;

        if (peerIds.length === 0) {
            html += `<span style="color:#666;">No peers connected</span><br>`;
        }

        peerIds.forEach(id => {
            const pc = pm.peers[id];
            const connState = pc.connectionState || 'unknown';
            const iceState = pc.iceConnectionState || 'unknown';
            const iceGatherState = pc.iceGatheringState || 'unknown';
            const sigState = pc.signalingState || 'unknown';

            const connColor = {
                'connected': '#0f0', 'completed': '#0f0',
                'checking': '#ff0', 'new': '#ff0',
                'disconnected': '#f80', 'failed': '#f44', 'closed': '#f44'
            }[connState] || '#888';

            const iceColor = {
                'connected': '#0f0', 'completed': '#0f0',
                'checking': '#ff0', 'new': '#ff0',
                'disconnected': '#f80', 'failed': '#f44', 'closed': '#f44'
            }[iceState] || '#888';

            html += `
                <div style="margin:4px 0; padding:4px; background:rgba(255,255,255,0.05); border-radius:3px;">
                    <span style="color:#0ff;">${id.substring(0, 8)}...</span><br>
                    <span style="color:#888;">conn:</span> <span style="color:${connColor};">${connState}</span>
                    <span style="color:#888;">ice:</span> <span style="color:${iceColor};">${iceState}</span><br>
                    <span style="color:#888;">gather:</span> ${iceGatherState}
                    <span style="color:#888;">signal:</span> ${sigState}
                </div>`;
        });

        html += `</div>`;

        // Local stream info
        if (pm.stream) {
            const track = pm.stream.getVideoTracks()[0];
            if (track) {
                const settings = track.getSettings();
                html += `<div style="border-top:1px solid #333; padding-top:4px; margin-top:4px;">
                    <span style="color:#fff;">Local Stream:</span><br>
                    <span style="color:#888;">Resolution:</span> ${settings.width}x${settings.height}<br>
                    <span style="color:#888;">FPS:</span> ${settings.frameRate?.toFixed(1) || '?'}<br>
                    <span style="color:#888;">Track state:</span> ${track.readyState}
                </div>`;
            }
        }

        this.panel.innerHTML = html;
    }
}
