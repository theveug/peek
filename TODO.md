# Peek – Roadmap / Polishing Tasks

Living backlog for Peek. Check this at the start of a session for pending work; update it when items are completed or new ones come up.

See **Design principles** in `CLAUDE.md` before adding new items — weigh new features against "no info held on a server."

## Scaling ceiling (priority — full mesh, will eventually bite)

- [ ] **SFU migration path (longer-term, conflicts with "no info held on a server")** — the actual fix for large rooms is a Selective Forwarding Unit: clients send one upload to a media server, which fans it out, turning N×(N-1) mesh connections into N connections total. This is the real answer if room sizes need to grow past the mesh-practical limit, but it's a meaningful architecture shift and a media server is exactly the kind of "thing in the middle" the no-server-storage principle was written to avoid — needs a deliberate decision later, not a casual addition.
- [ ] **Note: TURN doesn't raise the mesh ceiling, it lowers it** — TURN relay doesn't reduce the number of times a stream must be uploaded (each peer connection still gets its own relay allocation), it just reroutes each copy through the relay server. That adds a second, shared bottleneck (the relay's own bandwidth/CPU, split across every active relayed room) on top of each client's own capacity, plus an extra network hop. Keep this in mind when picking participant caps — a TURN-heavy deployment should cap lower than a mostly-direct-P2P one, not higher.

## Bandwidth (priority — mesh topology means every viewer multiplies upload cost)

(none open right now — see Completed for the click-to-watch pause/resume pipeline, now covering both grid and focus view)

- [ ] **Verify adaptive quality tier downgrade end-to-end** — the participant-cap/adaptive-quality work (see Completed) was verified for the cap/rejection path, but the 7+ participant quality-downgrade tiers in `PeerManager._resolveQuality()` weren't exercised live. Needs 7+ simultaneous tabs each starting a real screen/cam stream, reading `track.getSettings()` (or `getStats()`) to confirm resolution/fps actually drops at the 7-8/9-10/11-12 thresholds and restores when participants leave. Heavier to drive headlessly (no real display to capture in CI), so do it as a deliberate one-off check rather than routine verification.

## Screen share audio

(done — see Completed)

## Desktop / Electron

- [ ] **Electron wrapper** — Browser tabs can't capture keyboard events when unfocused, so push-to-talk/push-to-mute only work while the tab is active. Wrap the existing web app in Electron to get `globalShortcut` for system-wide hotkeys, plus tray icon support. Minimal changes needed — same frontend, thin native shell.

## Collaboration

- [ ] **Screen annotation/drawing** — overlay a canvas on the shared screen so participants can circle/mark things, useful for code review.

## Polish

- [ ] **Connection quality indicator** — signal strength icon per participant, computed from ICE stats (latency / packet loss).
- [ ] **Keyboard shortcuts panel** — `?` or `F1` overlay listing available shortcuts.

## Moderation

- [ ] **Room creator = moderator** — the peer who hits "create room" via `/api/create-room` becomes that session's moderator. Needs a creator token returned from the create-room API and verified against the peer's identity when they join over WebSocket (today `SessionManager.js` has no concept of room ownership — `addPeer` treats every joiner the same). Worth deciding whether moderator status survives a disconnect/reconnect.
- [ ] **Kick/disconnect participants** — new signal type (e.g. `kick`) the server only accepts from the verified moderator; server force-closes that peer's WebSocket and broadcasts a `peer-left`-style event so other clients tear down the connection. Straightforward to add to the `WebSocketServer.js` switch.
- [ ] **Room rules: push-to-talk vs. open mic** — store a mode on the session (`SessionManager.js`), broadcast it to joining peers, client UI adapts (e.g. force push-to-talk binding, hide the open-mic toggle). Important caveat: because Peek is a P2P mesh with no media server in the middle, the server can't actually intercept or block audio packets — enforcement is "social"/UI-level (well-behaved clients respect the rule) rather than a hard security guarantee. A modified client could ignore it. Fine for a moderation feature aimed at well-intentioned rooms, just don't market it as airtight.

## Bigger features (post-Electron)

- [ ] **Recording** — record the session locally.
- [ ] **Multiple rooms/channels (Discord-style)** — note: basic multi-room already works today, `SessionManager.js` keys sessions by room code and anyone can create as many as they want. What's missing for a real "server" feel is a *persistent* list of named channels you can browse and return to — today everything's in-memory (`Map`s in `SessionManager.js`) and disappears on server restart. Would need an actual storage layer (even something lightweight like SQLite) before this is worth building out.

## Completed (recent)

- [x] **Native browser picture-in-picture** — `#pip-button` overlay (top-right of `#focused-view`, mirrors the grid tiles' "Stop watching" button styling) calls `focusedVideo.requestPictureInPicture()`/`document.exitPictureInPicture()` via `UIController.togglePictureInPicture()`. Feature-detected at startup (`document.pictureInPictureEnabled`) — button hides entirely on unsupported browsers. Distinct from the existing self-view PiP overlay tiles (own webcam/screen mini-view in the corner) — this is the OS-level floating window that survives tab-switching. Verified via Playwright: clicking toggles `document.pictureInPictureElement` to the focused video and back.
- [x] **Creator-configurable participant cap + adaptive quality** — room creator picks a max participant count (4/6/8/10/12, default 6) in the lobby, stored per-session in `SessionManager.js` (`maxPeers`, clamped 2-12). Enforced both at `/api/validate-room` (lobby join flow shows "Room is full.") and in `WebSocketServer.js`'s `join` handler (`manager.isFull()`, defense-in-depth for direct-URL joins/races) — client redirects to `/?full=1` on the WS-level rejection. Rooms above 6 participants get automatic quality downgrades: `PeerManager._resolveQuality()` caps the user's chosen resolution/fps tier-by-tier (7-8/9-10/11-12 participants) via the existing `track.applyConstraints()` path, recalculated live on every `peer-joined`/`peer-left` so quality restores automatically as people leave. Rooms left at the default 6 see no behavior change — tier is always uncapped below that threshold. Room ownership/moderator identity is still unbuilt (see Moderation section) — this only needed a per-session setting captured at creation, not creator authentication.
- [x] Webcam support (toggle, grid tiles, PiP, stream-id discrimination from screen share)
- [x] Local HTTPS via mkcert (conditional, falls back to HTTP if no certs present)
- [x] Split UIController.js → UIController.js + ChatUI.js for context budget
- [x] Fixed reply-preview CSS always-visible bug (`.hidden` losing cascade to `.reply-preview`)
- [x] Fixed nickname broadcast not defaulting to "Anonymous"
- [x] Click-to-grid from focused view when not zoomed in
- [x] Camera error toasts (permission denied, no device, insecure context)
- [x] Fixed emoji reaction picker unclickable on the first chat message (popped up above the message, clipped by chat-log scroll bounds when there's no room above)
- [x] Fixed shared images having no click/download link (only the non-image file-card had a download anchor)
- [x] Click-to-watch grid tiles (Phase 1) — grid tiles beyond the 1st (2+ remote streams) show an avatar/"Click to watch" placeholder instead of live video; clicking attaches the stream. Single-remote-stream rooms auto-watch (no extra click for the common 1:1 case). Saves decode/render CPU only — superseded by real transceiver pausing below for actual bandwidth savings.
- [x] Separate webcam quality controls — settings modal now has independent "Webcam Quality" resolution/FPS (default 480p/30fps, options down to 360p) alongside the existing screen-share quality controls, since webcam never needed screen-share's higher ceiling. `PeerManager.applyCamQualitySettings()` mirrors `applyQualitySettings()`; `toggleCam()` requests the saved resolution/fps via `getUserMedia` constraints instead of unconstrained `{video: true}`.
- [x] **Real transceiver pausing (Phase 2)** — grid tiles that aren't watched now genuinely stop transmitting: `PeerManager.setSenderPaused()` calls `sender.replaceTrack(null)` on the specific per-connection `RTCRtpSender` (no SDP renegotiation needed), driven by new `watch-stream`/`unwatch-stream` signals relayed point-to-point through `WebSocketServer.js`. Verified via real `getStats()` measurements in Playwright: unwatched tile = 0 bytes received over a 1.5s window; resumes to full bitrate within ~1.5s of clicking to watch.
- [x] **Watch-slot cap** — `UIController.maxWatchedTiles` (6) with LRU eviction (`_watchTile()`/`_watchOrder`) caps how many streams can be actively watched/decoded at once, independent of room size — addresses the case where someone clicks "watch" on every tile in a large room and defeats the point of Phase 1/2. Evicting shows a toast ("Paused X to save bandwidth (max 6 watching)"). Verified with 7 simultaneous senders: cap holds at 6, correct peer evicted (least-recently-watched), toast fires.
- [x] **Stop watching button** — watched grid tiles now show a "Stop watching" button (top-right) to manually pause a stream without switching to focus view; routes through the same `unwatch-stream` signal as eviction, and cleans up the LRU order entry so a manually-stopped tile doesn't skew future cap eviction.
- [x] **Focus-view pause/resume** — closes the gap above: `updateLayout()`'s focus-mode branch now unwatches every remote stream except the currently-focused one on every layout pass, so living in focus view also gets real bandwidth savings instead of only grid view. Verified with `getStats()`: non-focused peer's inbound video = 0 bytes while in focus view; round-tripping focus → grid → restores the correct watched/placeholder state for both peers.
- [x] **Screen share audio** — `getDisplayMedia` now requests `audio: true`. Receive side disambiguates screen audio from mic audio via a new `start-sharing` signal (broadcasts the screen stream's id, mirroring the existing `webcam-start` pattern) so `PeerManager.peerScreenStreamIds` lets `ontrack` route the screen's audio track to a `peerId-screen`-keyed `<audio>` element instead of colliding with the mic's `peerId`-keyed one. Also fixed a real pre-existing bug this surfaced: `UIController.removeStream()` was unconditionally calling `removeAudio(peerId)` (the bare mic key) any time a screen video tile was removed, so stopping a screen share used to silently kill that peer's mic audio too — removed; mic cleanup is already independently handled by `removePeer()` on full disconnect. `PeerManager.senders[peerId]` keys also changed from `'screen'`/`'cam'` to `'screen-video'`/`'screen-audio'`/`'cam-video'` to stop the screen-audio sender from overwriting the screen-video sender reference (which would have silently broken Phase 2 pause/resume for anyone with screen+audio). Verified end-to-end with a synthetic getDisplayMedia stream (canvas video + oscillator audio, since headless Chromium has no real desktop to capture): mic and screen-audio render as separate elements simultaneously, stopping screen share removes only the screen one and leaves mic intact, full peer disconnect cleans up both.
