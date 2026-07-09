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

/**
 * Owns the entire WebRTC mesh: per-peer connections, local/remote media
 * tracks (screen, cam, mic), the signalling handshake over `socket`, file
 * transfers via `RTCDataChannel`, chat/reaction/poll broadcast, active-speaker
 * detection, adaptive quality tiers, and moderator actions. `ui` (a
 * `UIController`) is the sole outlet for anything that touches the DOM —
 * this class never queries or mutates it directly.
 */
export class PeerManager {
    /**
     * @param {WebSocket|null} socket - the signalling connection; null until App.js's connect() assigns one.
     * @param {import('./UIController.js').UIController} ui
     */
    constructor(socket, ui) {
        this.socket = socket;
        this.ui = ui;
        this.peers = {};
        this.stream = null;
        this.peerId = null;
        this.creatorPeerId = null;
        this.moderatorPeerIds = new Set();
        this.onForceStopped = null; // set by App.js — keeps share/cam button icons in sync
        this.isSharing = false;
        // Placeholder until the server's 'init' supplies the real list (built
        // from the deployment's STUN_URL/TURN env config). Deliberately empty,
        // not a public-STUN fallback — no third party should see call metadata
        // by default, and on a LAN host candidates alone connect fine.
        this.iceServers = [];
        this.micStream = null;
        this.micEnabled = false;
        this.deafened = false;
        this.status = 'online';
        this._manualStatus = null;
        this.dataChannels = {};
        this.incomingTransfers = {};
        this._offeredFiles = {};
        this._pendingFileOffers = {};
        this._filePeerProgress = {};
        // Per-peer chain of accepted file transfers still awaiting their actual
        // chunk stream — see _sendFileToPeer for why this must be serialized.
        this._sendQueues = {};
        this.camStream = null;
        this.camEnabled = false;
        this._camFacingMode = 'user';
        this.peerCamStreamIds = {};
        this._lastQualityTierKey = null;
        this.peerScreenStreamIds = {};
        this.senders = {};
        this._statsInterval = null;

        // --- Active-speaker detection (drives optional auto-focus + per-peer speaking rings) ---
        this.onActiveSpeakerChange = null; // set by App.js
        this.onSpeakingChange = null; // set by App.js — (peerId, isSpeaking), includes local peerId
        this._speakerInterval = null;
        this._activeSpeakerId = null;
        this._speakerCandidateSince = {};
        this._lastSpeakerSwitch = -Infinity;
        this._speakingState = {};
        this._lastLoudAt = {};
        this._noiseFloor = {};
        this._localAnalyser = null;
        this._localAnalyserStream = null;
    }

    /**
     * Adds every track of `stream` to `pc` and records the resulting RTCRtpSender
     * under this.senders[peerId]['<kind>-<track.kind>'] (e.g. 'screen-video',
     * 'screen-audio', 'cam-video'), so a later watch/unwatch request from that peer
     * can pause/resume this specific connection's sender without touching the other
     * peer connections sharing the same local stream. Keying by track kind too matters
     * once a stream carries both video and audio (screen share + its audio) — without
     * it the audio sender would silently overwrite the video sender's map entry.
     * @param {RTCPeerConnection} pc
     * @param {string} peerId
     * @param {MediaStream} stream
     * @param {'screen'|'cam'|'mic'} kind
     * @returns {void}
     */
    _addTrackedStream(pc, peerId, stream, kind) {
        stream.getTracks().forEach(track => {
            const sender = pc.addTrack(track, stream);
            if (!this.senders[peerId]) this.senders[peerId] = {};
            this.senders[peerId][`${kind}-${track.kind}`] = sender;
        });
    }

    /**
     * Pauses or resumes the video we're sending to `peerId` for the given kind, in
     * response to that peer reporting they've stopped/started watching it. Uses
     * replaceTrack(null) rather than transceiver renegotiation — it stops the encoder
     * (real bandwidth savings) without an SDP offer/answer round-trip.
     * @param {string} peerId
     * @param {'screen'|'cam'} kind
     * @param {boolean} paused
     * @returns {Promise<void>}
     */
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

    /**
     * Called by UIController when the local user starts/stops watching a remote
     * stream (streamKey is peerId for screen share, peerId-cam for webcam) —
     * signals the owning peer to pause/resume that sender.
     * @param {string} streamKey
     * @param {boolean} watched
     * @returns {void}
     */
    setWatched(streamKey, watched) {
        const isCam = streamKey.endsWith('-cam');
        const peerId = isCam ? streamKey.slice(0, -4) : streamKey;
        this.send(watched ? 'watch-stream' : 'unwatch-stream', peerId, { kind: isCam ? 'cam' : 'screen' });
    }

    /**
     * Single dispatch point for every message the signalling server relays
     * (WebSocketServer.js) — one `case` per `type`. Handles session bootstrap
     * ('init'), peer join/leave, WebRTC offer/answer/ICE relay, stream
     * start/stop announcements, watch/unwatch pause requests, and presence
     * (mic/deafen/nickname/status/typing) broadcasts.
     * @param {object} msg
     * @param {string} msg.type
     * @param {string} [msg.peerId] - this client's own peerId (only on 'init').
     * @param {string[]} [msg.peers] - existing room members (only on 'init').
     * @param {string} [msg.from] - the sending peer, for peer-relative message types.
     * @param {*} [msg.payload]
     * @param {RTCIceServer[]} [msg.iceServers]
     * @param {string|null} [msg.creatorPeerId]
     * @param {string[]} [msg.moderatorPeerIds]
     * @returns {Promise<void>}
     */
    async handleSignal({ type, peerId, peers, from, payload, iceServers, creatorPeerId, moderatorPeerIds }) {
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
                    // Same reasoning as 'peer-joined' below: register the connection
                    // synchronously for both sides, not just the initiator, so
                    // this.peers stays an accurate room-size count from the start.
                    if (!this.peers[id]) this.createPeerConnection(id);
                    if (this.peerId > id) {
                        this.initiateConnection(id);
                    }
                });
                this.creatorPeerId = creatorPeerId || null;
                this.moderatorPeerIds = new Set(moderatorPeerIds || []);
                this.ui.updateModeratorStatus(this.creatorPeerId, this.moderatorPeerIds);
                setTimeout(() => {
                    this.broadcastMicStatus();
                    this.broadcastDeafenStatus();
                    this.broadcastNickname();
                    this.broadcastStatus();
                }, 500);
                break;

            case 'moderator-update':
                this.creatorPeerId = creatorPeerId || null;
                this.moderatorPeerIds = new Set(moderatorPeerIds || []);
                this.ui.updateModeratorStatus(this.creatorPeerId, this.moderatorPeerIds);
                break;

            case 'force-stop-stream':
                if (this.isSharing) this.stopSharing();
                if (this.camStream) this.stopCam();
                this.ui.addSystemMessage('The room moderator stopped your stream to save bandwidth', 'stream');
                // Button icon state (share/cam toggles) is owned by App.js's click
                // handlers, not by stopSharing()/stopCam() themselves — this callback
                // lets it stay in sync when the stop is triggered remotely instead.
                this.onForceStopped?.();
                break;

            case 'peer-joined':
                // Only the "larger" peerId initiates the WebRTC offer (avoids both
                // sides racing to offer at once) — but the join notification/card
                // must fire for every existing peer regardless of who initiates,
                // or whichever side loses this comparison never sees it.
                //
                // The connection itself (this.peers[peerId]) must exist synchronously
                // right here regardless of who initiates, not just on the offering
                // side — _qualityTier() below counts Object.keys(this.peers).length,
                // and on the non-initiating side that entry otherwise wouldn't appear
                // until the offer actually arrives (an async round-trip later), making
                // every quality-tier recalculation on that side undercount by one for
                // this peer until the *next* join/leave event corrects it.
                // initiateConnection() reuses this entry instead of creating a second one.
                if (!this.peers[peerId]) this.createPeerConnection(peerId);
                if (this.peerId > peerId) {
                    this.initiateConnection(peerId);
                }
                this.ui.addPeer(peerId);
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

    /**
     * Starts (or switches the source of) an outgoing screen share. Requests
     * the new `getDisplayMedia` stream before tearing down any existing
     * share, so cancelling the picker mid-switch leaves the current share
     * running untouched.
     * @returns {Promise<void>}
     */
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
            this.ui.updateStageQuality?.(this.getScreenQualityLabel());

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

    /** Re-applies the current screen-share track's resolved quality constraints (e.g. after a Settings change or a quality-tier shift). */
    async applyQualitySettings() {
        if (!this.stream) return;
        const track = this.stream.getVideoTracks()[0];
        if (!track) return;
        await track.applyConstraints(this._resolveQuality('screen'));
    }

    /** Re-applies the current webcam track's resolved quality constraints. */
    async applyCamQualitySettings() {
        if (!this.camStream) return;
        const track = this.camStream.getVideoTracks()[0];
        if (!track) return;
        await track.applyConstraints(this._resolveQuality('cam'));
    }

    /**
     * @returns {{screenRes: string, screenFps: number, camRes: string, camFps: number}|null}
     *   the cap for the current room size, or null if the room is small
     *   enough (<=6) that the user's chosen settings apply unmodified.
     */
    _qualityTier() {
        const peerCount = Object.keys(this.peers).length + 1;
        const tier = QUALITY_TIERS.find(t => peerCount <= t.max);
        return tier ? tier.cap : QUALITY_TIERS[QUALITY_TIERS.length - 1].cap;
    }

    /** @returns {string} `userVal` if it's already <= `capVal` in RES_RANK, else `capVal`. */
    _capResolution(userVal, capVal) {
        if (!capVal) return userVal;
        if (userVal === 'source') return capVal;
        return (RES_RANK[userVal] ?? 99) <= (RES_RANK[capVal] ?? 99) ? userVal : capVal;
    }

    /** @returns {number} the lesser of `userVal` and `capVal` (or `userVal` if uncapped). */
    _capFps(userVal, capVal) {
        return capVal ? Math.min(userVal, capVal) : userVal;
    }

    /**
     * Builds getUserMedia/applyConstraints-style video constraints for 'screen' or
     * 'cam', honoring the user's saved settings but never exceeding the current
     * room-size quality tier.
     * @param {'screen'|'cam'} kind
     * @returns {MediaTrackConstraints}
     */
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
            // `ideal` alongside `max` matters, not just belt-and-suspenders: a bare
            // number (like frameRate below) is treated as `ideal` by the constraint
            // algorithm, but a `{ max }`-only dict has no ideal, so the browser only
            // changes the current resolution when it's needed to satisfy that max —
            // it never climbs back up once a smaller room's cap lifts. `cappedRes` is
            // already the tier-clamped target, so it's safe to also request it as the
            // ideal: this made the 2026-07-09 quality-tier-verify test's "room shrinks
            // back down" case fail (fps recovered since it was already ideal-based,
            // resolution silently stayed capped).
            constraints.width = { max: width, ideal: width };
            constraints.height = { max: height, ideal: height };
        }
        constraints.frameRate = cappedFps;
        return constraints;
    }

    /**
     * Posts a system-message toast only on an actual tier transition (not on
     * every join/leave), and only while there's an active screen/cam stream
     * for the cap to matter to.
     * @returns {void}
     */
    _announceQualityTierChange() {
        const tier = this._qualityTier();
        const key = tier ? JSON.stringify(tier) : null;
        if (key === this._lastQualityTierKey) return;
        const hadCap = !!this._lastQualityTierKey;
        this._lastQualityTierKey = key;

        if (!this.stream && !this.camStream) return;
        if (tier) {
            this.ui.addSystemMessage(`Lowered stream quality (room has ${Object.keys(this.peers).length + 1} participants)`, 'stream');
        } else if (hadCap) {
            this.ui.addSystemMessage('Stream quality restored', 'stream');
        }
    }

    /**
     * @param {number|null} rtt - round-trip time in seconds, or null if unknown.
     * @param {number} lossRate - 0-1 fraction of packets lost.
     * @returns {'unknown'|'poor'|'fair'|'good'|'excellent'}
     */
    _connectionQualityFromStats(rtt, lossRate) {
        if (rtt === null) return 'unknown';
        const ms = rtt * 1000;
        if (lossRate > 0.08 || ms >= 400) return 'poor';
        if (ms >= 200) return 'fair';
        if (ms >= 100) return 'good';
        return 'excellent';
    }

    // Worse-is-first ranking so the topbar's own signal icon reflects whichever
    // mesh connection is currently the weakest link, not just an average that
    // could mask one bad peer among several good ones.
    _qualityRank = { excellent: 0, good: 1, fair: 2, poor: 3, unknown: 0 };

    /**
     * Runs every 3s (see `_startStatsPolling`): reads each connection's ICE
     * stats for RTT/packet loss, pushes a per-peer quality tier to the UI,
     * and pushes the mesh-wide average RTT + worst-connection tier to the
     * top bar's signal icon.
     * @returns {Promise<void>}
     */
    async _pollConnectionStats() {
        const rttSamples = [];
        let worstTier = 'unknown';
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
                const tier = this._connectionQualityFromStats(rtt, lossRate);
                this.ui.updateConnectionQuality(peerId, tier);
                if (rtt !== null) rttSamples.push(rtt * 1000);
                if (this._qualityRank[tier] >= this._qualityRank[worstTier]) worstTier = tier;
            } catch (_) {}
        }
        const avgMs = rttSamples.length ? rttSamples.reduce((a, b) => a + b, 0) / rttSamples.length : null;
        this.ui.updateMeshSignal?.(avgMs, worstTier);
    }

    /** Starts the 3s connection-quality poll (idempotent). */
    _startStatsPolling() {
        if (this._statsInterval) return;
        this._statsInterval = setInterval(() => this._pollConnectionStats(), 3000);
    }

    /** Stops the connection-quality poll (called once the last peer leaves). */
    _stopStatsPolling() {
        clearInterval(this._statsInterval);
        this._statsInterval = null;
    }

    /**
     * Public entry point for the Settings panel's live mic-level meter (see
     * SettingsPanel._startMicMeter) — lets someone test/tune their sensitivity
     * threshold before anyone else has joined. _pollActiveSpeaker's regular
     * 200ms loop only runs once there's at least one peer connection
     * (createPeerConnection's `Object.keys(this.peers).length === 0` check), so
     * testing solo needs its own call into the same real detection function
     * rather than just reading stale/never-populated `_speakingState`. Reuses
     * the exact production algorithm (not a reimplementation) so the meter
     * matches what would actually happen once someone's in the room — if a
     * call *is* already in progress, this runs alongside the regular poll
     * harmlessly (same deterministic math over the same signal, just sampled
     * at a different cadence while Settings happens to be open).
     * @returns {{level: number, speaking: boolean}}
     */
    pollSelfMicActivity() {
        if (!this.peerId) return { level: 0, speaking: false };
        const level = this._localMicLevel();
        const speaking = this._updateSpeakingStates({ [this.peerId]: level }, Date.now())[this.peerId];
        return { level, speaking };
    }

    /**
     * RMS level (roughly 0-1) of the local mic, via a Web Audio analyser on micStream.
     * Recreated whenever micStream itself changes (e.g. mic toggled off then on again).
     * @returns {number}
     */
    _localMicLevel() {
        if (!this.micEnabled || !this.micStream) return 0;
        if (this._localAnalyserStream !== this.micStream) {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const source = ctx.createMediaStreamSource(this.micStream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            source.connect(analyser);
            this._localAnalyser = analyser;
            this._localAnalyserData = new Uint8Array(analyser.frequencyBinCount);
            this._localAnalyserStream = this.micStream;
        }
        this._localAnalyser.getByteTimeDomainData(this._localAnalyserData);
        let sumSquares = 0;
        for (const v of this._localAnalyserData) {
            const norm = (v - 128) / 128;
            sumSquares += norm * norm;
        }
        return Math.sqrt(sumSquares / this._localAnalyserData.length);
    }

    /** @returns {Promise<Object<string, number>>} peerId -> current inbound audio level, from ICE stats. */
    async _remotePeerLevels() {
        const levels = {};
        for (const [peerId, pc] of Object.entries(this.peers)) {
            try {
                const stats = await pc.getStats();
                stats.forEach(r => {
                    if (r.type === 'inbound-rtp' && r.kind === 'audio' && typeof r.audioLevel === 'number') {
                        levels[peerId] = Math.max(levels[peerId] || 0, r.audioLevel);
                    }
                });
            } catch (_) {}
        }
        return levels;
    }

    /**
     * Picks the active speaker from current audio levels, excluding the local user
     * (you already know when you're talking). `speaking` is the same adaptive-floor
     * signal driving the speaking-ring (see _updateSpeakingStates) — not a raw level
     * — so a mic with a high self-noise floor can't win purely by being loud at rest.
     * Requires a candidate to be the (only) one speaking for a sustained hold time
     * before switching to them, and enforces a minimum gap between switches —
     * otherwise normal back-and-forth conversation makes the focused view flicker.
     * @param {Object<string, boolean>} speaking - remote peerId -> currently speaking.
     * @param {number} now - `Date.now()` at call time.
     * @returns {string|null} the current active-speaker peerId, or null.
     */
    _pickActiveSpeaker(speaking, now) {
        const HOLD_MS = 500;
        const MIN_SWITCH_GAP_MS = 1500;

        // If more than one remote peer is currently flagged speaking, don't guess —
        // wait for it to resolve to a single candidate rather than picking arbitrarily.
        const candidates = Object.keys(speaking).filter(id => speaking[id]);
        const loudest = candidates.length === 1 ? candidates[0] : null;

        for (const peerId of Object.keys(this._speakerCandidateSince)) {
            if (peerId !== loudest) delete this._speakerCandidateSince[peerId];
        }

        if (!loudest) return this._activeSpeakerId;
        if (loudest === this._activeSpeakerId) return this._activeSpeakerId;

        if (this._speakerCandidateSince[loudest] === undefined) this._speakerCandidateSince[loudest] = now;
        const heldLongEnough = now - this._speakerCandidateSince[loudest] >= HOLD_MS;
        const gapOk = now - this._lastSpeakerSwitch >= MIN_SWITCH_GAP_MS;

        if (heldLongEnough && gapOk) {
            this._activeSpeakerId = loudest;
            this._lastSpeakerSwitch = now;
            delete this._speakerCandidateSince[loudest];
        }
        return this._activeSpeakerId;
    }

    // Toggles the speaking-ring indicator per peer (including the local user, keyed
    // by the real peerId — not the 'me' stream-key used elsewhere for video tiles).
    // Deliberately more responsive/less sticky than _pickActiveSpeaker's hold-time —
    // a visual ring flickering briefly is cheap, unlike yanking the focused view
    // around — but still has a short release window so it doesn't blink off between
    // individual words.
    //
    // Uses an adaptive per-peer noise floor rather than one fixed threshold — a flat
    // threshold reads as "always speaking" for anyone whose mic/room has a higher
    // self-noise floor than that constant (fan noise, mic gain, open-mic hum with no
    // push-to-talk), and reads as "never speaking" for someone with a very quiet mic.
    // The floor tracks each peer's own ambient level and only adapts while they're NOT
    // currently counted as speaking, so a sustained loud voice doesn't drag its own
    // floor up and mask itself.
    /**
     * The single source of truth both the speaking-ring and `_pickActiveSpeaker`
     * consume for "is this peer currently speaking" — adaptive per-peer noise
     * floor (not a fixed threshold) plus a release-window debounce so the
     * ring doesn't blink off between individual words. Fires `onSpeakingChange`
     * for any peer whose speaking state actually flips.
     * @param {Object<string, number>} levels - peerId -> current audio level (includes the local peerId, if present).
     * @param {number} now - `Date.now()` at call time.
     * @returns {Object<string, boolean>} peerId -> currently speaking.
     */
    _updateSpeakingStates(levels, now) {
        // User-adjustable via Settings' "Mic sensitivity" slider (voice-activity
        // mode only, but this one constant drives speech detection for every
        // peer as computed locally, so it also subtly tunes how sensitive
        // everyone else's speaking-ring looks on this client — a harmless,
        // local-only side effect).
        const MARGIN = parseFloat(typeof localStorage !== 'undefined' ? localStorage.getItem('micThreshold') : null) || 0.03;
        // User-adjustable via Settings' "Mic hold time" slider (voice-activity mode
        // only) — how long the gate stays open after the last loud sample before
        // closing again. Naturally speech-paced talkers (pauses mid-sentence while
        // thinking) need this longer than the 400ms default, or the gate closes
        // mid-sentence and has to re-detect speech on the next word, clipping both
        // the tail of the pause and the onset of what follows.
        const RELEASE_MS = parseFloat(typeof localStorage !== 'undefined' ? localStorage.getItem('micHoldTime') : null) || 400;
        const FLOOR_ADAPT_UP = 0.02;
        const FLOOR_ADAPT_DOWN = 0.2;

        const speaking = {};
        for (const [peerId, level] of Object.entries(levels)) {
            if (this._noiseFloor[peerId] === undefined) this._noiseFloor[peerId] = level;
            const floor = this._noiseFloor[peerId];
            const isSpeech = level > floor + MARGIN;

            if (!isSpeech) {
                const rate = level > floor ? FLOOR_ADAPT_UP : FLOOR_ADAPT_DOWN;
                this._noiseFloor[peerId] = floor + (level - floor) * rate;
            }

            if (isSpeech) this._lastLoudAt[peerId] = now;
            const isSpeaking = (now - (this._lastLoudAt[peerId] ?? -Infinity)) < RELEASE_MS;
            speaking[peerId] = isSpeaking;

            if (this._speakingState[peerId] !== isSpeaking) {
                this._speakingState[peerId] = isSpeaking;
                if (this.onSpeakingChange) this.onSpeakingChange(peerId, isSpeaking);
            }
        }
        return speaking;
    }

    /**
     * Runs every 200ms (see `_startSpeakerPolling`): samples local + remote
     * audio levels, updates speaking states (driving the speaking rings and
     * the voice-activity mic gate), and updates auto-focus's active speaker.
     * @returns {Promise<void>}
     */
    async _pollActiveSpeaker() {
        const levels = await this._remotePeerLevels();
        if (this.peerId) levels[this.peerId] = this._localMicLevel();

        const now = Date.now();
        const speaking = this._updateSpeakingStates(levels, now);

        if (this.peerId) this._reconcileMicGate(!!speaking[this.peerId]);

        const remoteSpeaking = { ...speaking };
        delete remoteSpeaking[this.peerId];

        const speaker = this._pickActiveSpeaker(remoteSpeaking, now);
        if (speaker && this.onActiveSpeakerChange) this.onActiveSpeakerChange(speaker);
    }

    /**
     * Gates actual transmission for every mic mode, not just voice-activity —
     * toggleMic() only ever flips track.enabled (see its comment), which mutes
     * *content* but never stops the RTP sender: a disabled track still gets
     * encoded and sent as continuous silence, so push-to-talk/push-to-mute
     * were transmitting the whole time regardless of whether the key was held
     * (confirmed via DebugPanel's per-track byte counters climbing with the
     * key untouched). Uses replaceTrack(null) on each connection's mic sender
     * (the same pause primitive setSenderPaused uses for video) rather than
     * track.enabled, since the track is shared with _localMicLevel()'s
     * analyser — disabling the track itself would silence that too and the
     * gate could never reopen.
     * @param {boolean} speakingLocally
     * @returns {void}
     */
    _reconcileMicGate(speakingLocally) {
        const micMode = (typeof localStorage !== 'undefined' && localStorage.getItem('micMode')) || 'toggle';
        const shouldTransmit = this.micEnabled && (micMode !== 'voice-activity' || speakingLocally);
        // Exposed for DebugPanel — lets a "ring says speaking but no audio
        // arrives" report be diagnosed from what this function actually
        // computed, rather than only what the ring displayed.
        this._micGateState = { micMode, micEnabled: this.micEnabled, speakingLocally, shouldTransmit };

        // Reconciled unconditionally (not just on a state change) so a sender
        // added mid-gate — e.g. a new peer joining while voice-activity has the
        // gate closed — is brought in line on the very next 200ms tick rather
        // than being stuck open until the next actual speaking transition.
        // replaceTrack with the track it's already carrying is a cheap no-op.
        const liveTrack = this.micStream?.getAudioTracks()[0] || null;
        for (const peerId of Object.keys(this.senders)) {
            const sender = this.senders[peerId]?.['mic-audio'];
            if (sender) sender.replaceTrack(shouldTransmit ? liveTrack : null).catch(() => {});
        }
    }

    /** Starts the 200ms active-speaker/mic-gate poll (idempotent). */
    _startSpeakerPolling() {
        if (this._speakerInterval) return;
        this._speakerInterval = setInterval(() => this._pollActiveSpeaker(), 200);
    }

    /** Stops the active-speaker poll and clears all speaking-state (called once the last peer leaves). */
    _stopSpeakerPolling() {
        clearInterval(this._speakerInterval);
        this._speakerInterval = null;
        this._activeSpeakerId = null;
        this._speakerCandidateSince = {};
        this._lastSpeakerSwitch = -Infinity;

        for (const [peerId, speaking] of Object.entries(this._speakingState)) {
            if (speaking && this.onSpeakingChange) this.onSpeakingChange(peerId, false);
        }
        this._speakingState = {};
        this._lastLoudAt = {};
        this._noiseFloor = {};
    }

    /**
     * Requests mic permission on first use, then toggles enabled/disabled on
     * subsequent calls. Broadcasts the new state to peers either way.
     * @returns {Promise<boolean>} the resulting `micEnabled` state.
     */
    async toggleMic() {
        if (!this.micStream) {
            try {
                this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                this.micEnabled = true;

                for (const [peerId, pc] of Object.entries(this.peers)) {
                    this._addTrackedStream(pc, peerId, this.micStream, 'mic');
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

    /** Sends the current `micEnabled` state to every peer. */
    broadcastMicStatus() {
        this.send('mic-status', null, { enabled: this.micEnabled });
    }

    /** Sends the current deafen state to every peer. */
    broadcastDeafenStatus() {
        this.send('deafen-status', null, { deafened: this.deafened || false });
    }

    /** Sends the current (localStorage-persisted) nickname to every peer. */
    broadcastNickname() {
        const nickname = (localStorage.getItem('nickname') || 'Anonymous').trim();
        this.send('nickname-update', null, { nickname });
    }

    /**
     * Sets and broadcasts the local presence status, and updates the local
     * UI to match. Does not touch `_manualStatus` — callers that represent a
     * deliberate user choice should use `setManualStatus` instead.
     * @param {'online'|'away'|'dnd'} status
     * @returns {void}
     */
    setStatus(status) {
        this.status = status;
        this.send('status-update', null, { status });
        this.ui.updateParticipantStatus(this.peerId, status);
        this.ui.updateIdentityStatus?.(status);
    }

    /**
     * Records a deliberate user choice from the status picker (as opposed to
     * an automatic away/idle transition) and applies it immediately.
     * `_reconcileAwayStatus` reads `_manualStatus` back to decide what to
     * restore once an automatic away condition clears.
     * @param {'online'|'away'|'dnd'} status
     * @returns {void}
     */
    setManualStatus(status) {
        this._manualStatus = status;
        this.setStatus(status);
    }

    /** Re-sends the current status to every peer (e.g. on a new peer joining). */
    broadcastStatus() {
        this.send('status-update', null, { status: this.status });
    }

    /**
     * Called on every `visibilitychange` — pauses/resumes incoming video
     * (bandwidth-saving while the tab is backgrounded) and reconciles the
     * away status.
     * @param {boolean} hidden - `document.hidden` at call time.
     * @returns {void}
     */
    handleTabVisibility(hidden) {
        if (hidden) {
            this._pauseIncomingVideo();
        } else {
            this._resumeIncomingVideo();
        }
        this._reconcileAwayStatus(hidden);
    }

    /**
     * Shared by handleTabVisibility and handleIdleChange — both are just
     * different signals for "the user isn't really here right now." Never
     * overrides a manually-chosen DND, and reverts to whatever status was
     * manually chosen before (not hardcoded 'online') once the away
     * condition clears, so a manually-chosen 'away' stays put too.
     * @param {boolean} away
     * @returns {void}
     */
    _reconcileAwayStatus(away) {
        if (this._manualStatus === 'dnd') return;
        this.setStatus(away ? 'away' : (this._manualStatus || 'online'));
    }

    /**
     * Idle-timeout auto-away (mouse/keyboard/touch inactivity), distinct from
     * handleTabVisibility's tab-switch trigger — no video pause/resume here,
     * since an idle-but-visible tab should keep rendering incoming streams.
     * @param {boolean} idle
     * @returns {void}
     */
    handleIdleChange(idle) {
        this._reconcileAwayStatus(idle);
    }

    /**
     * A peer's video stays enabled if its stream is the one currently floating
     * in native picture-in-picture — tab-hidden doesn't mean unwatched there.
     * @param {string} peerId
     * @returns {boolean}
     */
    _isPeerInPictureInPicture(peerId) {
        if (document.pictureInPictureElement !== this.ui.focusedVideo) return false;
        const focusedPeerId = this.ui.focusedPeerId;
        if (!focusedPeerId) return false;
        const basePeerId = focusedPeerId.endsWith('-cam') ? focusedPeerId.slice(0, -4) : focusedPeerId;
        return basePeerId === peerId;
    }

    /** Disables every remote video receiver track (except one in native PiP) — tab hidden/idle bandwidth saving. */
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

    /** Re-enables every remote video receiver track. */
    _resumeIncomingVideo() {
        Object.values(this.peers).forEach(pc => {
            pc.getReceivers().forEach(r => {
                if (r.track && r.track.kind === 'video') {
                    r.track.enabled = true;
                }
            });
        });
    }

    /** Stops the outgoing screen share and notifies peers. */
    stopSharing() {
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }

        this.ui.removeStream('me');
        this.isSharing = false;
        this.ui.updateStageQuality?.(null);

        // Notify peers that streaming stopped
        this.send('stop-sharing', null, {});
    }

    /**
     * Formats the effective (room-size-capped) outgoing screen-share quality for
     * the stage header's "Auto · 1280x720 · 30fps" readout — reuses the same
     * resolved constraints _resolveQuality() already computes for getUserMedia.
     * @returns {string}
     */
    getScreenQualityLabel() {
        const { width, height, frameRate } = this._resolveQuality('screen');
        const res = width && height ? `${width.max}x${height.max}` : 'source';
        return `Auto · ${res} · ${frameRate}fps`;
    }


    /**
     * Creates and wires a new `RTCPeerConnection` for `remotePeerId`: ICE
     * candidate relay, incoming track routing (mic vs. screen-share audio,
     * screen vs. cam video — disambiguated via the announced stream IDs),
     * connection-failure cleanup, and the file-transfer data channel. Starts
     * the stats/speaker polls if this is the first peer connection.
     * @param {string} remotePeerId
     * @returns {RTCPeerConnection}
     */
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

        if (Object.keys(this.peers).length === 0) {
            this._startStatsPolling();
            this._startSpeakerPolling();
        }
        this.peers[remotePeerId] = pc;
        return pc;
    }

    /** Wires open/close/message handlers for one peer's file-transfer data channel. */
    _setupDataChannel(dc, peerId) {
        dc.onopen = () => { this.dataChannels[peerId] = dc; };
        dc.onclose = () => { delete this.dataChannels[peerId]; };
        dc.onmessage = (e) => this._handleDataChannelMessage(peerId, e.data);
    }

    /**
     * Demuxes one incoming data-channel message. JSON string messages are
     * one of: file-offer/accept/decline/start/end, poll-create/vote, chat,
     * reaction, or typing — each re-validated here (peer-controlled input is
     * never trusted, see the file-transfer trust-boundary note in
     * CLAUDE.md), and dropped silently for a blocked peer. Binary messages
     * are file chunks, demuxed to the one in-flight transfer from that
     * sender (see the per-peer send-queue serialization note on
     * `_sendFileToPeer` for why only one transfer per sender is ever active
     * on the receive side at a time).
     * @param {string} peerId
     * @param {string|ArrayBuffer} data
     * @returns {void}
     */
    _handleDataChannelMessage(peerId, data) {
        if (typeof data === 'string') {
            let msg;
            try {
                msg = JSON.parse(data);
            } catch {
                return; // malformed message from a peer — drop, don't throw
            }
            if (msg.type === 'file-offer') {
                // Checked first, before anything gets rendered: a blocked peer's
                // offers (including their caption/groupId) must leave zero visible
                // trace, same as their chat/reactions/typing/polls do.
                if (this.ui.isBlocked(peerId)) {
                    this._respondToOffer(peerId, msg.fileId, false);
                    return;
                }

                const fileSize = Number(msg.fileSize);
                const nickname = this.ui._peerNickname(peerId);
                // Ensured here, before the allow/size checks below, so the caption
                // (and any of the batch's other, allowed files) still renders even
                // when this particular file gets bounced.
                this.ui.ensureFileGroup(nickname, {
                    groupId: msg.groupId, caption: msg.caption, replyTo: msg.replyTo, messageId: msg.messageId,
                });

                if (!this._isFileAllowed(msg.fileName)) {
                    this.ui.addSystemMessage(`Blocked incoming file: ${msg.fileName}`, 'leave');
                    this._respondToOffer(peerId, msg.fileId, false);
                    return;
                }
                if (!Number.isFinite(fileSize) || fileSize < 0 || fileSize > this._maxFileSize) {
                    this.ui.addSystemMessage(`Blocked incoming file: ${msg.fileName} (too large)`, 'leave');
                    this._respondToOffer(peerId, msg.fileId, false);
                    return;
                }

                this._offeredFiles[msg.fileId] = {
                    fileName: msg.fileName, fileSize, fileType: this._safeMimeType(msg.fileName), from: peerId,
                    groupId: msg.groupId,
                };

                if (this._autoAcceptFiles()) {
                    this._respondToOffer(peerId, msg.fileId, true);
                } else {
                    this.ui.showFileOffer(nickname, msg.fileId, msg.fileName, fileSize,
                        () => this._respondToOffer(peerId, msg.fileId, true),
                        () => this._respondToOffer(peerId, msg.fileId, false),
                        msg.groupId);
                }
            } else if (msg.type === 'file-accept' || msg.type === 'file-decline') {
                const key = `${msg.fileId}:${peerId}`;
                this._pendingFileOffers[key]?.(msg.type === 'file-accept');
                delete this._pendingFileOffers[key];
            } else if (msg.type === 'file-start') {
                const offer = this._offeredFiles[msg.fileId];
                if (!offer) return; // we never offered-accepted this fileId — ignore
                delete this._offeredFiles[msg.fileId];
                this.incomingTransfers[msg.fileId] = {
                    fileName: offer.fileName, fileSize: offer.fileSize, fileType: offer.fileType,
                    totalChunks: msg.totalChunks, chunks: [], received: 0, receivedBytes: 0, from: peerId,
                    groupId: offer.groupId,
                };
                this.ui.updateFileProgress(msg.fileId, 0, 'download', offer.fileName, offer.groupId);
            } else if (msg.type === 'file-end') {
                const t = this.incomingTransfers[msg.fileId];
                if (!t) return;
                const blob = new Blob(t.chunks, { type: t.fileType });
                const url = URL.createObjectURL(blob);
                const nickname = this.ui._peerNickname(peerId);
                this.ui.removeFileProgress(msg.fileId, t.groupId);
                this.ui.addFileMessage(nickname, msg.fileId, t.fileName, t.fileSize, t.fileType, url, blob, t.groupId);
                delete this.incomingTransfers[msg.fileId];
            } else if (msg.type === 'poll-create') {
                if (this.ui.isBlocked(peerId)) return;
                const nickname = this.ui._peerNickname(peerId);
                this.ui.addPollMessage(nickname, msg.pollId, msg.question, msg.options, this.peerId);
            } else if (msg.type === 'poll-vote') {
                if (this.ui.isBlocked(peerId)) return;
                // Use the connection's real peerId, not the sender-supplied voterId —
                // trusting msg.voterId lets any peer cast/overwrite votes as someone else.
                this.ui.updatePollVote(msg.pollId, msg.optionIndex, peerId);
            } else if (msg.type === 'chat') {
                if (this.ui.isBlocked(peerId)) return;
                this.ui.addChatMessage(this.ui._peerNickname(peerId), msg.text, msg.messageId, msg.replyTo || null);
                this.ui.updateTypingIndicator(peerId, false);
            } else if (msg.type === 'reaction') {
                if (this.ui.isBlocked(peerId)) return;
                this.ui.addReaction(msg.messageId, msg.emoji, msg.nickname, peerId);
            } else if (msg.type === 'typing') {
                if (this.ui.isBlocked(peerId)) return;
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
                this.ui.removeFileProgress(activeId, t.groupId);
                this.ui.addSystemMessage(`Blocked incoming file: ${t.fileName} (exceeded declared size)`, 'leave');
                return;
            }
            t.chunks.push(data);
            t.received++;
            const progress = t.totalChunks > 0 ? t.received / t.totalChunks : 0;
            this.ui.updateFileProgress(activeId, progress, 'download', t.fileName, t.groupId);
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

    /** @returns {boolean} true if the file's extension is on the allowlist. */
    _isFileAllowed(fileName) {
        const ext = fileName.split('.').pop().toLowerCase();
        return this._allowedExtensions.has(ext);
    }

    _maxFileSize = 500 * 1024 * 1024;

    _rasterMimeByExt = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
        webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon',
    };

    /**
     * The peer-supplied MIME type is untrusted: a blob typed image/svg+xml (or text/html)
     * opened via its blob: URL runs scripts in THIS origin. Derive the type from the
     * extension instead — raster images keep a previewable MIME, everything else
     * (including svg) becomes an opaque binary that only gets download links.
     * @param {string} fileName
     * @returns {string}
     */
    _safeMimeType(fileName) {
        const ext = (fileName || '').split('.').pop().toLowerCase();
        return this._rasterMimeByExt[ext] || 'application/octet-stream';
    }

    /**
     * Receiver decides per-file whether to accept (unless they've turned on
     * "auto-accept files" for a room they trust) — see `settings-auto-accept-files`.
     * @returns {boolean}
     */
    _autoAcceptFiles() {
        return localStorage.getItem('autoAcceptFiles') === '1';
    }

    /** Sends a file-accept or file-decline reply for an incoming offer. */
    _respondToOffer(peerId, fileId, accepted) {
        if (!accepted) delete this._offeredFiles[fileId];
        const dc = this.dataChannels[peerId];
        if (!dc || dc.readyState !== 'open') return;
        dc.send(JSON.stringify({ type: accepted ? 'file-accept' : 'file-decline', fileId }));
    }

    /**
     * Waits (with a timeout, so a peer who never answers — or leaves — doesn't
     * hang the transfer forever) for each peer's file-accept/file-decline before
     * sending a single byte, so a declined file never wastes bandwidth.
     * @param {string} peerId
     * @param {string} fileId
     * @param {number} [timeoutMs=60000]
     * @returns {Promise<boolean>} whether the peer accepted.
     */
    _awaitOfferResponse(peerId, fileId, timeoutMs = 60_000) {
        const key = `${fileId}:${peerId}`;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                delete this._pendingFileOffers[key];
                resolve(false);
            }, timeoutMs);
            this._pendingFileOffers[key] = (accepted) => {
                clearTimeout(timer);
                resolve(accepted);
            };
        });
    }

    /**
     * Entry point for the composer's Send button: one or more staged files plus an
     * optional caption, all rendered as one bubble (see ChatUI.ensureFileGroup).
     * Each file still gets its own independent per-peer offer/accept/transfer
     * (sendFileToAll below) — grouping is purely a rendering concern, not a
     * transport one, so one AFK peer or one blocked/oversized file can never hold
     * up any other file in the batch.
     * @param {File[]} files
     * @param {string|null} caption
     * @param {{messageId: string, sender: string, text: string}|null} replyTo
     * @param {string} messageId
     * @returns {Promise<void>}
     */
    async sendFilesWithCaption(files, caption, replyTo, messageId) {
        const groupId = 'grp-' + Date.now() + '-' + Math.random().toString(36).substr(2, 8);
        const group = { groupId, caption: caption || null, replyTo: replyTo || null, messageId };
        for (const file of files) {
            await this.sendFileToAll(file, group);
        }
    }

    /**
     * Sends one file to every connected peer: local echo first (regardless
     * of whether anyone accepts), then an independent offer/accept/transfer
     * per peer (see `_sendFileToPeer`) — one AFK or declining peer never
     * blocks delivery to the others.
     * @param {File} file
     * @param {{groupId: string, caption: string|null, replyTo: object|null, messageId: string|null}} group
     * @returns {Promise<void>}
     */
    async sendFileToAll(file, group) {
        if (!this._isFileAllowed(file.name)) {
            this.ui.addSystemMessage(`Blocked: .${file.name.split('.').pop()} files are not allowed`, 'leave');
            return;
        }

        if (file.size > this._maxFileSize) {
            this.ui.addSystemMessage(`File too large (max 500 MB)`, 'leave');
            return;
        }

        const fileId = 'file-' + Date.now() + '-' + Math.random().toString(36).substr(2, 8);
        const peerIds = Object.keys(this.dataChannels).filter(pid => this.dataChannels[pid]?.readyState === 'open');
        if (peerIds.length === 0) return;

        // Local echo happens regardless of whether anyone accepts.
        const safeType = this._safeMimeType(file.name);
        const blob = new Blob([file], { type: safeType });
        const url = URL.createObjectURL(blob);
        this.ui.ensureFileGroup('Me', group);
        this.ui.addFileMessage('Me', fileId, file.name, file.size, safeType, url, blob, group.groupId);

        const offer = {
            type: 'file-offer', fileId, fileName: file.name, fileSize: file.size, fileType: file.type,
            groupId: group.groupId, caption: group.caption, replyTo: group.replyTo, messageId: group.messageId,
        };
        // Each peer's offer/accept/transfer runs independently, not gathered behind
        // a single Promise.all — an AFK peer sitting on their accept/decline prompt
        // (up to the 60s timeout in _awaitOfferResponse) must not hold up delivery
        // to peers who already accepted.
        this._filePeerProgress[fileId] = new Map();
        Promise.all(peerIds.map(pid => this._sendFileToPeer(pid, file, fileId, offer))).then(() => {
            delete this._filePeerProgress[fileId];
            this.ui.removeFileProgress(fileId, group.groupId);
        });
    }

    /**
     * Sends the offer to one peer, waits for their accept/decline, then
     * queues the actual chunk stream behind any transfer already in flight
     * to that same peer.
     *
     * Binary WebRTC messages carry no fileId of their own — the receiver can
     * only tell one file's chunks apart from another's by assuming at most one
     * transfer is in flight per sender at a time (see the binary branch of
     * handleDataChannelMessage). Sending a caption+files batch (or just two
     * drops close together) fires every file's offer/accept near-simultaneously,
     * so without this queue two accepted files' chunk loops would interleave on
     * the same connection and get demuxed into the wrong incomingTransfers entry
     * on the other end — corrupting both and often tripping the declared-size
     * guard. Chaining behind this peer's previous transfer only delays *when*
     * the next file's bytes start going out; it doesn't affect other peers,
     * preserving the existing "one AFK/declining peer can't block another peer"
     * guarantee.
     * @param {string} pid
     * @param {File} file
     * @param {string} fileId
     * @param {object} offer
     * @returns {Promise<void>}
     */
    async _sendFileToPeer(pid, file, fileId, offer) {
        const awaited = this._awaitOfferResponse(pid, fileId);
        this.dataChannels[pid]?.send(JSON.stringify(offer));
        const accepted = await awaited;
        if (!accepted) return;

        // Binary WebRTC messages carry no fileId of their own — the receiver can
        // only tell one file's chunks apart from another's by assuming at most one
        // transfer is in flight per sender at a time (see the binary branch of
        // handleDataChannelMessage). Sending a caption+files batch (or just two
        // drops close together) fires every file's offer/accept near-simultaneously,
        // so without this queue two accepted files' chunk loops would interleave on
        // the same connection and get demuxed into the wrong incomingTransfers entry
        // on the other end — corrupting both and often tripping the declared-size
        // guard. Chaining behind this peer's previous transfer only delays *when*
        // the next file's bytes start going out; it doesn't affect other peers,
        // preserving the existing "one AFK/declining peer can't block another peer"
        // guarantee below.
        const prevInQueue = this._sendQueues[pid] || Promise.resolve();
        const thisTransfer = prevInQueue.then(() => this._streamFileToPeer(pid, file, fileId, offer.groupId));
        this._sendQueues[pid] = thisTransfer.catch(() => {});
        return thisTransfer;
    }

    /**
     * Streams one file's bytes to one peer in 16KB chunks, respecting the
     * data channel's own backpressure (`bufferedAmount`).
     * @param {string} pid
     * @param {File} file
     * @param {string} fileId
     * @param {string} groupId
     * @returns {Promise<void>}
     */
    async _streamFileToPeer(pid, file, fileId, groupId) {
        const dc = this.dataChannels[pid];
        if (!dc || dc.readyState !== 'open') return;

        const CHUNK_SIZE = 16384;
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        dc.send(JSON.stringify({ type: 'file-start', fileId, totalChunks }));

        for (let i = 0; i < totalChunks; i++) {
            if (dc.readyState !== 'open') return;
            const start = i * CHUNK_SIZE;
            const buffer = await file.slice(start, start + CHUNK_SIZE).arrayBuffer();

            while (dc.bufferedAmount > 1024 * 1024) {
                await new Promise(r => {
                    dc.bufferedAmountLowThreshold = 256 * 1024;
                    dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); };
                });
            }
            dc.send(buffer);

            this._filePeerProgress[fileId]?.set(pid, (i + 1) / totalChunks);
            this._reportUploadProgress(fileId, file.name, groupId);
        }

        this._filePeerProgress[fileId]?.delete(pid);
        dc.send(JSON.stringify({ type: 'file-end', fileId }));
    }

    /**
     * With multiple peers accepting at different times / uploading at different
     * rates (each connection's own bufferedAmount backpressure), one shared
     * progress bar can only show one number — report the least-advanced peer
     * still in flight, since that's the one still holding up "done".
     * @returns {void}
     */
    _reportUploadProgress(fileId, fileName, groupId) {
        const map = this._filePeerProgress[fileId];
        if (!map || map.size === 0) return;
        this.ui.updateFileProgress(fileId, Math.min(...map.values()), 'upload', fileName, groupId);
    }

    /**
     * Sends a chat message to every peer over their data channel.
     * @param {string} text
     * @param {string} nickname
     * @param {string} messageId
     * @param {object|null} replyTo
     * @returns {void}
     */
    broadcastChat(text, nickname, messageId, replyTo) {
        const msg = JSON.stringify({ type: 'chat', text, nickname, messageId, replyTo: replyTo || null });
        for (const dc of Object.values(this.dataChannels)) {
            if (dc.readyState === 'open') dc.send(msg);
        }
    }

    /** Sends a reaction toggle to every peer. */
    broadcastReaction(messageId, emoji, nickname) {
        const msg = JSON.stringify({ type: 'reaction', messageId, emoji, nickname });
        for (const dc of Object.values(this.dataChannels)) {
            if (dc.readyState === 'open') dc.send(msg);
        }
    }

    /** Sends the local typing state to every peer. */
    broadcastTyping(isTyping) {
        const msg = JSON.stringify({ type: 'typing', isTyping });
        for (const dc of Object.values(this.dataChannels)) {
            if (dc.readyState === 'open') dc.send(msg);
        }
    }

    /** Sends a new poll to every peer. */
    broadcastPollCreate(pollId, question, options) {
        const msg = JSON.stringify({ type: 'poll-create', pollId, question, options });
        for (const dc of Object.values(this.dataChannels)) {
            if (dc.readyState === 'open') dc.send(msg);
        }
    }

    /** Sends the local peer's poll vote to every peer, tagged with the real local peerId. */
    broadcastPollVote(pollId, optionIndex) {
        const msg = JSON.stringify({ type: 'poll-vote', pollId, optionIndex, voterId: this.peerId });
        for (const dc of Object.values(this.dataChannels)) {
            if (dc.readyState === 'open') dc.send(msg);
        }
    }

    /**
     * Initiates the WebRTC offer side of a connection (only called by the
     * "larger" peerId in a pair, per `handleSignal`'s join handling, so both
     * sides don't race to offer at once). Attaches any active local
     * streams, or a recvonly transceiver in their place, then sends the offer.
     * @param {string} peerId
     * @returns {void}
     */
    initiateConnection(peerId) {
        const pc = this.peers[peerId] || this.createPeerConnection(peerId);

        if (this.stream) {
            this._addTrackedStream(pc, peerId, this.stream, 'screen');
        } else {
            pc.addTransceiver('video', { direction: 'recvonly' });
        }

        if (this.camStream) {
            this._addTrackedStream(pc, peerId, this.camStream, 'cam');
        }

        if (this.micStream) {
            this._addTrackedStream(pc, peerId, this.micStream, 'mic');
        } else {
            pc.addTransceiver('audio', { direction: 'recvonly' });
        }

        pc.createOffer()
            .then(offer => pc.setLocalDescription(offer))
            .then(() => {
                this.send('offer', peerId, pc.localDescription);
            });
    }

    /**
     * Handles an incoming WebRTC offer: creates the connection if needed,
     * attaches any active local streams not already attached (checked via
     * the `senders` map, not live track kinds — a mic sender gated closed by
     * the voice-activity gate has `.track === null` and would otherwise be
     * missed and re-added, see the inline note below on the mic-audio check),
     * and replies with an answer.
     * @param {string} from
     * @param {RTCSessionDescriptionInit} offer
     * @returns {Promise<void>}
     */
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

        // Consult the senders map, NOT pc.getSenders() track kinds — a mic sender
        // gated closed by _reconcileMicGate (muted, or silent in voice-activity
        // mode) has .track === null, so a live-track check misses it and re-adds
        // the mic. The duplicate transceiver (created after setRemoteDescription)
        // can't be negotiated in the answer, and it overwrites senders[from]
        // ['mic-audio'] — leaving the gate driving a dead sender while the real
        // one is stranded at replaceTrack(null): mic permanently silent to that
        // peer even though the local speaking ring still lights up.
        if (this.micStream && !this.senders[from]?.['mic-audio']) {
            this._addTrackedStream(pc, from, this.micStream, 'mic');
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send('answer', from, pc.localDescription);
    }

    /** Applies an incoming WebRTC answer to the matching connection. */
    receiveAnswer(from, answer) {
        const pc = this.peers[from];
        if (pc) {
            pc.setRemoteDescription(new RTCSessionDescription(answer));
        }
    }

    /** Applies an incoming ICE candidate to the matching connection. */
    receiveCandidate(from, candidate) {
        const pc = this.peers[from];
        if (pc) {
            pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    }

    /**
     * Full teardown of a peer connection (disconnect, kick, or connection
     * failure): closes the RTCPeerConnection, stops the stats/speaker polls
     * if it was the last peer, and clears every per-peer map entry plus that
     * peer's video/audio elements. `silent` is threaded through to
     * `ui.removeStream` so a blanket sweep (e.g. the 'init' reconnect reset)
     * doesn't queue phantom stream-down sounds for peers who never streamed.
     * @param {string} peerId
     * @returns {void}
     */
    removePeer(peerId) {
        const pc = this.peers[peerId];
        if (pc) pc.close();
        delete this.peers[peerId];
        if (Object.keys(this.peers).length === 0) {
            this._stopStatsPolling();
            this._stopSpeakerPolling();
        }
        delete this.peerCamStreamIds[peerId];
        delete this.peerScreenStreamIds[peerId];
        delete this.senders[peerId];
        delete this._sendQueues[peerId];
        // silent: this is blanket cleanup on a full disconnect — the 'peer-left'
        // handler plays the single peerLeft sound, and the 'init' reconnect sweep
        // should make no noise at all. Without it, every leave queued two phantom
        // streamDown sounds (screen + cam) even for peers who never streamed.
        this.ui.removeStream(peerId, true);
        this.ui.removeStream(peerId + '-cam', true);
        this.ui.removeAudio(peerId + '-screen');
    }

    /**
     * Called when a REMOTE peer stops their screen share ('stop-sharing') — their
     * tracks end on our receivers on their own, so the only cleanup needed here is
     * the video tile. This must never touch pc.getSenders(): those are OUR outbound
     * tracks (mic/cam/screen) to that peer, and a removeTrack() on them silently
     * stops our audio/video toward the ex-sharer with no renegotiation and no error
     * (the next negotiation then locks the transceiver receive-only, killing the
     * mic to that peer permanently — the "they can't hear me anymore" bug).
     * @param {string} peerId
     * @returns {void}
     */
    removePeerStream(peerId) {
        this.ui.removeStream(peerId);
    }



    /**
     * Requests camera permission on first use, then stops it on subsequent
     * calls. Attaches the new stream to every existing connection and
     * renegotiates.
     * @returns {Promise<boolean>} the resulting `camEnabled` state.
     */
    async toggleCam() {
        if (this.camEnabled) {
            this.stopCam();
            return false;
        }
        if (!navigator.mediaDevices?.getUserMedia) {
            this.ui.showToast('Camera requires a secure connection (HTTPS)');
            return false;
        }

        try {
            this._camFacingMode = 'user';
            this.camStream = await navigator.mediaDevices.getUserMedia({
                video: { ...this._resolveQuality('cam'), facingMode: { ideal: this._camFacingMode } },
                audio: false,
            });
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
            this.ui.showToast(msg);
            return false;
        }
    }

    /** Stops the outgoing webcam stream and notifies peers. */
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

    /**
     * Flips between front/back camera without renegotiating — swaps the outbound
     * track via replaceTrack() on each existing sender, same mechanism the
     * watch/unwatch pause system and mic-gate use for track swaps without SDP churn.
     * @returns {Promise<void>}
     */
    async switchCamera() {
        if (!this.camStream) return;
        const nextFacingMode = this._camFacingMode === 'environment' ? 'user' : 'environment';

        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: { ...this._resolveQuality('cam'), facingMode: { ideal: nextFacingMode } },
                audio: false,
            });
            const newTrack = newStream.getVideoTracks()[0];

            this.camStream.getVideoTracks()[0].stop();
            this._camFacingMode = nextFacingMode;
            this.camStream = newStream;

            newTrack.onended = () => {
                this.stopCam();
                document.getElementById('cam-on-icon')?.classList.add('hidden');
                document.getElementById('cam-off-icon')?.classList.remove('hidden');
            };

            for (const [peerId, pc] of Object.entries(this.peers)) {
                const sender = this.senders[peerId]?.['cam-video'];
                if (sender) await sender.replaceTrack(newTrack);
            }

            this.ui.addStream('me-cam', this.camStream);
        } catch (err) {
            console.warn('Switch camera failed:', err);
            this.ui.showToast('Could not switch camera');
        }
    }

    /** Re-announces the current webcam stream's ID to peers (e.g. on a new peer joining). */
    broadcastCamStreamId() {
        if (this.camStream) {
            this.send('webcam-start', null, { streamId: this.camStream.id });
        }
    }

    /**
     * Broader tier — creator + anyone promoted. Can stop any peer's stream, including
     * the creator's own.
     * @returns {boolean}
     */
    isModeratorMe() {
        return !!this.peerId && this.moderatorPeerIds.has(this.peerId);
    }

    /**
     * Stricter tier — only the current token-holding creator. Can kick and promote/demote.
     * @returns {boolean}
     */
    isCreatorMe() {
        return !!this.peerId && this.creatorPeerId === this.peerId;
    }

    // All four actions are enforced server-side (WebSocketServer.js checks
    // SessionManager.isModerator/isCreator before acting) — these just send the request.

    /** Requests the server force-stop a peer's stream. Requires moderator status server-side. */
    requestStopStream(targetPeerId) {
        this.send('force-stop-stream', targetPeerId, {});
    }

    /** Requests the server kick a peer from the room. Requires creator status server-side. */
    kickPeer(targetPeerId) {
        this.send('kick', targetPeerId, {});
    }

    /** Requests the server promote a peer to moderator. Requires creator status server-side. */
    promotePeer(targetPeerId) {
        this.send('promote-moderator', targetPeerId, {});
    }

    /** Requests the server demote a peer from moderator. Requires creator status server-side. */
    demotePeer(targetPeerId) {
        this.send('demote-moderator', targetPeerId, {});
    }

    /**
     * Sends one signalling message over the WebSocket, if it's open.
     * @param {string} type
     * @param {string|null} to - target peerId for point-to-point messages, or null to broadcast.
     * @param {*} payload
     * @returns {void}
     */
    send(type, to, payload) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type, to, payload }));
        }
    }
}