# Peek – Roadmap / Backlog (open items only)

Living backlog for Peek. Check this at the start of a session for pending work; update it as items are completed or new ones come up.

- **Completed work** now lives in `CHANGELOG.md` (moved out to keep this file light in context) — when you finish something here, delete it and add a one-line entry there.
- **Design rationale + the visual-redesign history** live in `ARCHITECTURE.md`.
- Weigh new features against the **Design principles** in `CLAUDE.md` ("no info held on a server") before adding them.

## Scaling ceiling (priority — full mesh, will eventually bite)

- [ ] **SFU migration path (longer-term, conflicts with "no info held on a server")** — the actual fix for large rooms is a Selective Forwarding Unit: clients send one upload to a media server, which fans it out, turning N×(N-1) mesh connections into N connections total. This is the real answer if room sizes need to grow past the mesh-practical limit, but it's a meaningful architecture shift and a media server is exactly the kind of "thing in the middle" the no-server-storage principle was written to avoid — needs a deliberate decision later, not a casual addition.
- [ ] **Note: TURN doesn't raise the mesh ceiling, it lowers it** — TURN relay doesn't reduce the number of times a stream must be uploaded (each peer connection still gets its own relay allocation), it just reroutes each copy through the relay server. That adds a second, shared bottleneck (the relay's own bandwidth/CPU, split across every active relayed room) on top of each client's own capacity, plus an extra network hop. Keep this in mind when picking participant caps — a TURN-heavy deployment should cap lower than a mostly-direct-P2P one, not higher.

## Security (open items only — patched items are in CHANGELOG.md, most recently the 2026-07-07 offline/self-host pass)

- [ ] **Accepted risk, documented not fixed — saved-code squatting** — the lazy room-recreation path means anyone who ever learned a room code can recreate that room with *their own* password after it empties, and `/api/validate-room` returns `valid:true` for unknown codes. A griefer could squat a group's saved code. Acceptable under the current threat model (codes are shared secrets, same as the manual-join flow), but it's a conscious acceptance now, not an oversight. Revisit only if room codes ever become long-lived/advertised.

## Documentation / open-source prep

- [ ] **JSDoc the public API surface** — docblocks on class-level + public methods of `PeerManager`, `SessionManager`, `UIController`, `ChatUI`, and the genuinely non-obvious internals (not every function). Highest-value onboarding aid for incoming open-source contributors facing the large client files, and helps targeted reads. **If done, update the line counts in `CLAUDE.md`'s "Never read large files in full" list in the same pass** — docblocks inflate those files and the budget rules are keyed to size. A generated docs site (typedoc/jsdoc HTML) is deliberately *not* planned yet — a strong `README.md` + `ARCHITECTURE.md` is more valuable at this size and rots less.
- [ ] **README.md for the repo root** — table stakes for open-sourcing: what Peek is, the no-server-storage pitch, how to run (`npm run dev`, the mkcert HTTPS note), and pointers to `ARCHITECTURE.md`/`CHANGELOG.md`/`CLAUDE.md`.

## Desktop / Electron

- [ ] **Electron wrapper (own repo)** — Browser tabs can't capture keyboard events when unfocused, so push-to-talk/push-to-mute only work while the tab is active. A generic desktop shell (not tied to one hosted Peek instance) would get `globalShortcut` for system-wide hotkeys, tray icon, and would eliminate Chrome's bulky in-tab "sharing" banner via `desktopCapturer` instead of `getDisplayMedia`. Since Peek is self-hostable per-domain (TURN config is per-deployment via `.env`), the shell just navigates to whatever room URL it's given — same as a browser tab; it never bundles or duplicates any frontend code, so it needs its own repo (separate build/release/codesigning pipeline) with zero risk of drifting out of sync. LAN/offline-from-internet use falls out for free from self-hosting + WebRTC ICE finding local candidates without STUN/TURN.

## Collaboration

- [ ] **Rejected: local contacts / friends list** — considered a client-side contacts system (local keypair + `localStorage` label per contact, added via out-of-band invite link, no server directory/discovery). Dropped because without accounts there's no cross-room presence, so "friending" someone only pays off if you can PM them outside a room — and *that* needs presence tracking, a bigger step against no-server-storage than a contacts list justifies. **Saved rooms** (see `CHANGELOG.md`) covers the actual need. Revisit only if async P2P messaging becomes a real goal — see Direct messaging below.
- [ ] **Direct messaging (P2P data channel)** — private 1-to-1 chat between any two participants via `RTCDataChannel` on the existing peer connection, so messages never touch the signaling server. Click a participant's avatar/name to open a scoped DM panel alongside group chat. Implementation lives in `PeerManager.js` (open a named data channel per peer on connect, handle `ondatachannel` on the receiving side). Works identically in the hosted web version and the future Electron build since data channels are P2P after ICE.
- [ ] **Screen annotation/drawing** — overlay a canvas on the shared screen so participants can circle/mark things, useful for code review.

## Polish

- [ ] **Keyboard shortcuts panel** — `?` or `F1` overlay listing available shortcuts.

## New feature ideas (brainstorm — 2026-07-04)

Not yet scoped/estimated — captured here so they don't get lost; move into a proper section once someone picks one up.

- [ ] **Virtual background / blur** — canvas or WASM-based segmentation applied to your own webcam track client-side before it's ever sent; no coordination with peers needed, fits the no-server-storage model cleanly.
- [ ] **Mic noise suppression, RNNoise-based (opt-in)** — scoped 2026-07-08, not started. Not actual Krisp: that's a proprietary SDK/cloud service, wrong fit for this project's offline-first/no-third-party-server model (see the standing rule in `CLAUDE.md`'s Key conventions). RNNoise is the open-source equivalent (same family of ML denoiser behind Discord/Mumble's noise suppression), self-hosted like every other vendor dep, running entirely client-side on your own mic track before it's ever sent — no coordination with peers, no server involvement.
  - Self-host a pinned RNNoise WASM build in `public/assets/vendor/`, same pattern as `marked`/`dompurify`/`jszip`/`highlight.js`.
  - New `AudioWorkletProcessor` file running the WASM denoiser per audio frame.
  - Rewire the mic pipeline in `PeerManager.js`: `micStream` → `AudioContext` → `AudioWorkletNode` (RNNoise) → `MediaStreamDestination`, then swap the cleaned track into whatever `RTCRtpSender`s currently carry the raw mic track — reuse the existing `_addTrackedStream`/`replaceTrack` machinery the voice-activity mic gate already uses (`senders[peerId]['mic-audio']`), so the gating logic doesn't need to change, just which track is live underneath it.
  - New Settings toggle (Audio & Mic section) — opt-in, not default, since it's a constant CPU cost even while not speaking.
  - Note: `getUserMedia({ audio: true })` at `PeerManager.js:631` has no explicit constraints today, so the browser's own (much weaker, non-ML) built-in noise suppression is likely already active by default — RNNoise would be a real upgrade over that, not a duplicate.
  - Main open risk is real-world CPU cost of continuous WASM audio processing on modest hardware, not the wiring itself — measure before ever considering it as a default-on.
- [ ] **Raise hand** — a lightweight broadcast signal (mirrors the existing typing/reaction broadcast pattern) + an icon on the participant card. Cheap once room-rules/push-to-talk moderation exists, but useful standalone too.
- [ ] **@mentions in chat** — detect `@nickname` in outgoing chat text, highlight it for the mentioned peer, and give it a distinct notification (separate from the general unread dot) so it's not lost in a busy room.
- [ ] **Live captions (Web Speech API)** — client-side speech-to-text overlay on your own mic only; never leaves the browser, so it sidesteps the no-server-storage tension entirely. Real accessibility win.
- [ ] **QR code for room join** — generate client-side from the room URL (no server involvement) for quickly getting a phone into a room.
- [ ] **Idle/away auto-detection** — auto-flip status to "away" after N minutes of no mouse/keyboard input; manual online/away/DND picker already exists, this just automates the away case.
- [ ] **Collaborative whiteboard** — freestanding draw canvas (not just an overlay on a shared screen) synced via the existing data-channel broadcast pattern used for chat/reactions.
- [ ] **Session recap export** — before a session ends, bundle the in-memory chat log + shared files into a single local download (zip), entirely client-side. Doesn't violate no-persistence since nothing is stored server-side or between sessions — just don't let the ephemeral data vanish without an explicit export option.
- [ ] **Members sidebar has unused space at realistic room sizes (2026-07-09)** — the panel is sized for the max participant cap (12), but most rooms run far smaller, so the bottom half sits empty. No concrete feature picked yet (call-status/bandwidth stats was floated and set aside — felt more like a power-user/debug stat than something worth permanent sidebar space, see `DebugPanel.js`) — flagging the space itself as a future opportunity, not a specific design.

## Moderation

- [ ] **Room rules: push-to-talk vs. open mic** — store a mode on the session (`SessionManager.js`), broadcast it to joining peers, client UI adapts (e.g. force push-to-talk binding, hide the open-mic toggle). Important caveat: because Peek is a P2P mesh with no media server in the middle, the server can't intercept or block audio packets — enforcement is "social"/UI-level (well-behaved clients respect the rule), not a hard security guarantee. A modified client could ignore it. Fine for well-intentioned rooms, just don't market it as airtight.

## Bigger features (post-Electron)

- [ ] **Recording** — record the session locally.
- [ ] **Multiple rooms/channels (Discord-style)** — basic multi-room already works (`SessionManager.js` keys sessions by room code, anyone can create any number). What's missing for a real "server" feel is a *persistent* list of named channels you can browse and return to — today everything's in-memory and disappears on server restart. Would need an actual storage layer (even lightweight like SQLite) before this is worth building.
