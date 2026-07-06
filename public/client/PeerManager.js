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
        this.camStream = null;
        this.camEnabled = false;
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
            this.ui.addSystemMessage(`Lowered stream quality (room has ${Object.keys(this.peers).length + 1} participants)`, 'stream');
        } else if (hadCap) {
            this.ui.addSystemMessage('Stream quality restored', 'stream');
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
        const rttSamples = [];
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
                if (rtt !== null) rttSamples.push(rtt * 1000);
            } catch (_) {}
        }
        const avgMs = rttSamples.length ? rttSamples.reduce((a, b) => a + b, 0) / rttSamples.length : null;
        this.ui.updateMeshLatency?.(avgMs);
    }

    _startStatsPolling() {
        if (this._statsInterval) return;
        this._statsInterval = setInterval(() => this._pollConnectionStats(), 3000);
    }

    _stopStatsPolling() {
        clearInterval(this._statsInterval);
        this._statsInterval = null;
    }

    // Public entry point for the Settings panel's live mic-level meter (see
    // SettingsPanel._startMicMeter) — lets someone test/tune their sensitivity
    // threshold before anyone else has joined. _pollActiveSpeaker's regular
    // 200ms loop only runs once there's at least one peer connection
    // (createPeerConnection's `Object.keys(this.peers).length === 0` check), so
    // testing solo needs its own call into the same real detection function
    // rather than just reading stale/never-populated `_speakingState`. Reuses
    // the exact production algorithm (not a reimplementation) so the meter
    // matches what would actually happen once someone's in the room — if a
    // call *is* already in progress, this runs alongside the regular poll
    // harmlessly (same deterministic math over the same signal, just sampled
    // at a different cadence while Settings happens to be open).
    pollSelfMicActivity() {
        if (!this.peerId) return { level: 0, speaking: false };
        const level = this._localMicLevel();
        const speaking = this._updateSpeakingStates({ [this.peerId]: level }, Date.now())[this.peerId];
        return { level, speaking };
    }

    // RMS level (roughly 0-1) of the local mic, via a Web Audio analyser on micStream.
    // Recreated whenever micStream itself changes (e.g. mic toggled off then on again).
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

    // Picks the active speaker from current audio levels, excluding the local user
    // (you already know when you're talking). `speaking` is the same adaptive-floor
    // signal driving the speaking-ring (see _updateSpeakingStates) — not a raw level
    // — so a mic with a high self-noise floor can't win purely by being loud at rest.
    // Requires a candidate to be the (only) one speaking for a sustained hold time
    // before switching to them, and enforces a minimum gap between switches —
    // otherwise normal back-and-forth conversation makes the focused view flicker.
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
    // Returns { peerId: boolean } — who's currently counted as speaking, after the
    // adaptive floor + release-window debounce. This is the single source of truth
    // both the speaking-ring and _pickActiveSpeaker consume.
    _updateSpeakingStates(levels, now) {
        // User-adjustable via Settings' "Mic sensitivity" slider (voice-activity
        // mode only, but this one constant drives speech detection for every
        // peer as computed locally, so it also subtly tunes how sensitive
        // everyone else's speaking-ring looks on this client — a harmless,
        // local-only side effect).
        const MARGIN = parseFloat(typeof localStorage !== 'undefined' ? localStorage.getItem('micThreshold') : null) || 0.03;
        const RELEASE_MS = 400;
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

    // Voice-activity mode gates actual transmission on the speaking signal
    // above, rather than only driving the cosmetic speaking-ring — so the mic
    // isn't "locked open" the moment it's toggled on. Uses replaceTrack(null)
    // on each connection's mic sender (the same pause primitive
    // setSenderPaused uses for video) rather than track.enabled, since the
    // track is shared with _localMicLevel()'s analyser — disabling the track
    // itself would silence that too and the gate could never reopen.
    // Outside voice-activity mode (or while muted via the mic toggle), always
    // reconciles back to the live track, so switching mic modes can't leave a
    // sender stuck gated closed from a prior voice-activity session.
    _reconcileMicGate(speakingLocally) {
        const micMode = (typeof localStorage !== 'undefined' && localStorage.getItem('micMode')) || 'toggle';
        const shouldTransmit = micMode !== 'voice-activity' || !this.micEnabled || speakingLocally;

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

    _startSpeakerPolling() {
        if (this._speakerInterval) return;
        this._speakerInterval = setInterval(() => this._pollActiveSpeaker(), 200);
    }

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
        this.ui.updateIdentityStatus?.(status);
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
        this.ui.updateStageQuality?.(null);

        // Notify peers that streaming stopped
        this.send('stop-sharing', null, {});
    }

    // Formats the effective (room-size-capped) outgoing screen-share quality for
    // the stage header's "Auto · 1280x720 · 30fps" readout — reuses the same
    // resolved constraints _resolveQuality() already computes for getUserMedia.
    getScreenQualityLabel() {
        const { width, height, frameRate } = this._resolveQuality('screen');
        const res = width && height ? `${width.max}x${height.max}` : 'source';
        return `Auto · ${res} · ${frameRate}fps`;
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

        if (Object.keys(this.peers).length === 0) {
            this._startStatsPolling();
            this._startSpeakerPolling();
        }
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
            if (msg.type === 'file-offer') {
                const fileSize = Number(msg.fileSize);
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
                };

                if (this._autoAcceptFiles()) {
                    this._respondToOffer(peerId, msg.fileId, true);
                } else {
                    const nickname = this.ui._peerNickname(peerId);
                    this.ui.showFileOffer(nickname, msg.fileId, msg.fileName, fileSize,
                        () => this._respondToOffer(peerId, msg.fileId, true),
                        () => this._respondToOffer(peerId, msg.fileId, false));
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
                };
                this.ui.updateFileProgress(msg.fileId, 0, 'download', offer.fileName);
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
                // Use the connection's real peerId, not the sender-supplied voterId —
                // trusting msg.voterId lets any peer cast/overwrite votes as someone else.
                this.ui.updatePollVote(msg.pollId, msg.optionIndex, peerId);
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
                this.ui.addSystemMessage(`Blocked incoming file: ${t.fileName} (exceeded declared size)`, 'leave');
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

    // Receiver decides per-file whether to accept (unless they've turned on
    // "auto-accept files" for a room they trust) — see `settings-auto-accept-files`.
    _autoAcceptFiles() {
        return localStorage.getItem('autoAcceptFiles') === '1';
    }

    _respondToOffer(peerId, fileId, accepted) {
        if (!accepted) delete this._offeredFiles[fileId];
        const dc = this.dataChannels[peerId];
        if (!dc || dc.readyState !== 'open') return;
        dc.send(JSON.stringify({ type: accepted ? 'file-accept' : 'file-decline', fileId }));
    }

    // Waits (with a timeout, so a peer who never answers — or leaves — doesn't
    // hang the transfer forever) for each peer's file-accept/file-decline before
    // sending a single byte, so a declined file never wastes bandwidth.
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

    async sendFileToAll(file) {
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

        const offer = { type: 'file-offer', fileId, fileName: file.name, fileSize: file.size, fileType: file.type };
        const responses = await Promise.all(peerIds.map(pid => {
            const awaited = this._awaitOfferResponse(pid, fileId);
            this.dataChannels[pid].send(JSON.stringify(offer));
            return awaited;
        }));
        const acceptedPeerIds = peerIds.filter((_, i) => responses[i]);

        // Local echo happens regardless of whether anyone accepted.
        const safeType = this._safeMimeType(file.name);
        const blob = new Blob([file], { type: safeType });
        const url = URL.createObjectURL(blob);
        this.ui.addFileMessage('Me', fileId, file.name, file.size, safeType, url, blob);

        if (acceptedPeerIds.length === 0) return;

        const CHUNK_SIZE = 16384;
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

        for (const pid of acceptedPeerIds) {
            this.dataChannels[pid]?.send(JSON.stringify({ type: 'file-start', fileId, totalChunks }));
        }

        this.ui.updateFileProgress(fileId, 0, 'upload', file.name);

        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const buffer = await file.slice(start, start + CHUNK_SIZE).arrayBuffer();

            for (const pid of acceptedPeerIds) {
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

        for (const pid of acceptedPeerIds) {
            this.dataChannels[pid]?.send(JSON.stringify({ type: 'file-end', fileId }));
        }

        this.ui.removeFileProgress(fileId);
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
                this._addTrackedStream(pc, from, this.micStream, 'mic');
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
        if (Object.keys(this.peers).length === 0) {
            this._stopStatsPolling();
            this._stopSpeakerPolling();
        }
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
            this.ui.showToast('Camera requires a secure connection (HTTPS)');
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
            this.ui.showToast(msg);
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

    // Broader tier — creator + anyone promoted. Can stop any peer's stream, including
    // the creator's own.
    isModeratorMe() {
        return !!this.peerId && this.moderatorPeerIds.has(this.peerId);
    }

    // Stricter tier — only the current token-holding creator. Can kick and promote/demote.
    isCreatorMe() {
        return !!this.peerId && this.creatorPeerId === this.peerId;
    }

    // All four actions are enforced server-side (WebSocketServer.js checks
    // SessionManager.isModerator/isCreator before acting) — these just send the request.
    requestStopStream(targetPeerId) {
        this.send('force-stop-stream', targetPeerId, {});
    }

    kickPeer(targetPeerId) {
        this.send('kick', targetPeerId, {});
    }

    promotePeer(targetPeerId) {
        this.send('promote-moderator', targetPeerId, {});
    }

    demotePeer(targetPeerId) {
        this.send('demote-moderator', targetPeerId, {});
    }

    send(type, to, payload) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type, to, payload }));
        }
    }
}