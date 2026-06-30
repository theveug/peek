# Peek – Roadmap / Polishing Tasks

Living backlog for Peek. Check this at the start of a session for pending work; update it when items are completed or new ones come up.

See **Design principles** in `CLAUDE.md` before adding new items — weigh new features against "no info held on a server."

## Scaling ceiling (priority — full mesh, will eventually bite)

- [ ] **Participant cap per room** — Peek's full-mesh topology means N people in a room requires N×(N-1) simultaneous `RTCPeerConnection`s total, split across everyone's browsers. A 20-person room means each client juggles 19 connections, encoding/decoding video for all of them — that's a client CPU/bandwidth wall, not a server memory issue (server-side state stays tiny regardless of room size, see Design principles). Needs a sane hard cap (e.g. 6-8 participants) enforced at join time in `WebSocketServer.js`/`SessionManager.js`, with a clear "room is full" message rather than letting people pile in and degrade for everyone.
- [ ] **SFU migration path (longer-term, conflicts with "no info held on a server")** — the actual fix for large rooms is a Selective Forwarding Unit: clients send one upload to a media server, which fans it out, turning N×(N-1) mesh connections into N connections total. This is the real answer if room sizes need to grow past the mesh-practical limit, but it's a meaningful architecture shift and a media server is exactly the kind of "thing in the middle" the no-server-storage principle was written to avoid — needs a deliberate decision later, not a casual addition.
- [ ] **Adaptive quality by participant count** — auto-downgrade resolution/frame rate as more people join a room, restore as they leave. `applyQualitySettings()` (PeerManager.js) already does `track.applyConstraints({ width, height, frameRate })` for user-chosen quality with no renegotiation required — extend it to factor in current participant count rather than just the user's manual setting. Cheap relative to the cap/SFU work and buys headroom before the hard participant cap kicks in.
- [ ] **Note: TURN doesn't raise the mesh ceiling, it lowers it** — TURN relay doesn't reduce the number of times a stream must be uploaded (each peer connection still gets its own relay allocation), it just reroutes each copy through the relay server. That adds a second, shared bottleneck (the relay's own bandwidth/CPU, split across every active relayed room) on top of each client's own capacity, plus an extra network hop. Keep this in mind when picking the participant cap number — a TURN-heavy deployment should cap lower than a mostly-direct-P2P one, not higher.

## Bandwidth (priority — mesh topology means every viewer multiplies upload cost)

- [ ] **Click-to-watch grid tiles** — Phase 1: show a placeholder/avatar instead of live video by default; clicking attaches the stream to render it. Cheap, saves decode/render CPU (mainly helps mobile).
- [ ] **Real transceiver pausing** — Phase 2: when a tile isn't being watched, set that peer connection's transceiver direction to `inactive` and renegotiate, so the sender actually stops transmitting on that connection. This is the real bandwidth fix — Phase 1 alone does not reduce network usage, since the sender keeps transmitting regardless of whether the receiver renders it. Matters for both mobile data users and TURN relay billing.

## Screen share audio

- [ ] **Capture tab/system audio** — `getDisplayMedia` is currently called with `audio: false` (PeerManager.js). Enable `audio: true` so screen shares with sound (video playback, games) are audible to others.
- [ ] **Fix audio element collision** — `addAudio()` in UIController.js maps one `<audio>` element per peer ID, used today for mic. Adding screen-share audio for the same peer would overwrite that element's `srcObject` instead of mixing mic + screen audio. Needs a stream-id-based split, same pattern as the existing webcam `-cam` key convention.

## Desktop / Electron

- [ ] **Electron wrapper** — Browser tabs can't capture keyboard events when unfocused, so push-to-talk/push-to-mute only work while the tab is active. Wrap the existing web app in Electron to get `globalShortcut` for system-wide hotkeys, plus tray icon support. Minimal changes needed — same frontend, thin native shell.

## Collaboration

- [ ] **Screen annotation/drawing** — overlay a canvas on the shared screen so participants can circle/mark things, useful for code review.

## Polish

- [ ] **Connection quality indicator** — signal strength icon per participant, computed from ICE stats (latency / packet loss).
- [ ] **Picture-in-picture** — native browser PiP mode for the focused stream so it floats over other windows.
- [ ] **Keyboard shortcuts panel** — `?` or `F1` overlay listing available shortcuts.

## Moderation

- [ ] **Room creator = moderator** — the peer who hits "create room" via `/api/create-room` becomes that session's moderator. Needs a creator token returned from the create-room API and verified against the peer's identity when they join over WebSocket (today `SessionManager.js` has no concept of room ownership — `addPeer` treats every joiner the same). Worth deciding whether moderator status survives a disconnect/reconnect.
- [ ] **Kick/disconnect participants** — new signal type (e.g. `kick`) the server only accepts from the verified moderator; server force-closes that peer's WebSocket and broadcasts a `peer-left`-style event so other clients tear down the connection. Straightforward to add to the `WebSocketServer.js` switch.
- [ ] **Room rules: push-to-talk vs. open mic** — store a mode on the session (`SessionManager.js`), broadcast it to joining peers, client UI adapts (e.g. force push-to-talk binding, hide the open-mic toggle). Important caveat: because Peek is a P2P mesh with no media server in the middle, the server can't actually intercept or block audio packets — enforcement is "social"/UI-level (well-behaved clients respect the rule) rather than a hard security guarantee. A modified client could ignore it. Fine for a moderation feature aimed at well-intentioned rooms, just don't market it as airtight.

## Bigger features (post-Electron)

- [ ] **Recording** — record the session locally.
- [ ] **Multiple rooms/channels (Discord-style)** — note: basic multi-room already works today, `SessionManager.js` keys sessions by room code and anyone can create as many as they want. What's missing for a real "server" feel is a *persistent* list of named channels you can browse and return to — today everything's in-memory (`Map`s in `SessionManager.js`) and disappears on server restart. Would need an actual storage layer (even something lightweight like SQLite) before this is worth building out.

## Completed (recent)

- [x] Webcam support (toggle, grid tiles, PiP, stream-id discrimination from screen share)
- [x] Local HTTPS via mkcert (conditional, falls back to HTTP if no certs present)
- [x] Split UIController.js → UIController.js + ChatUI.js for context budget
- [x] Fixed reply-preview CSS always-visible bug (`.hidden` losing cascade to `.reply-preview`)
- [x] Fixed nickname broadcast not defaulting to "Anonymous"
- [x] Click-to-grid from focused view when not zoomed in
- [x] Camera error toasts (permission denied, no device, insecure context)
