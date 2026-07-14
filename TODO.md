# Peek – Roadmap / Backlog (open items only)

Living backlog for Peek. Check this at the start of a session for pending work; update it as items are completed or new ones come up.

- **Completed work** now lives in `CHANGELOG.md` (moved out to keep this file light in context) — when you finish something here, delete it and add a one-line entry there.
- **Design rationale + the visual-redesign history** live in `ARCHITECTURE.md`.
- Weigh new features against the **Design principles** in `CLAUDE.md` ("no info held on a server") before adding them.

## Scaling ceiling (full mesh, will eventually bite — parked 2026-07-10: owner explicitly not willing to go SFU anytime soon)

- [ ] **SFU migration path (longer-term, conflicts with "no info held on a server")** — the actual fix for large rooms is a Selective Forwarding Unit: clients send one upload to a media server, which fans it out, turning N×(N-1) mesh connections into N connections total. This is the real answer if room sizes need to grow past the mesh-practical limit, but it's a meaningful architecture shift and a media server is exactly the kind of "thing in the middle" the no-server-storage principle was written to avoid — needs a deliberate decision later, not a casual addition.
- [ ] **Note: TURN doesn't raise the mesh ceiling, it lowers it** — TURN relay doesn't reduce the number of times a stream must be uploaded (each peer connection still gets its own relay allocation), it just reroutes each copy through the relay server. That adds a second, shared bottleneck (the relay's own bandwidth/CPU, split across every active relayed room) on top of each client's own capacity, plus an extra network hop. Keep this in mind when picking participant caps — a TURN-heavy deployment should cap lower than a mostly-direct-P2P one, not higher.

## Security (open items only — patched items are in CHANGELOG.md, most recently the 2026-07-13 sweep #4)

- [ ] **Accepted risk, documented not fixed — saved-code squatting** — the lazy room-recreation path means anyone who ever learned a room code can recreate that room with *their own* password after it empties (and, since the 2026-07-11 lazy-owner fix, becomes its owner — deliberately the same trust level), and `/api/validate-room` returns `valid:true` for unknown codes. A griefer could squat a group's saved code. Acceptable under the current threat model (codes are shared secrets, same as the manual-join flow), but it's a conscious acceptance now, not an oversight. Revisit only if room codes ever become long-lived/advertised.

## Desktop / Electron

- [ ] **Electron wrapper (own repo)** — Browser tabs can't capture keyboard events when unfocused, so push-to-talk/push-to-mute only work while the tab is active. A generic desktop shell (not tied to one hosted Peek instance) would get `globalShortcut` for system-wide hotkeys, tray icon, and would eliminate Chrome's bulky in-tab "sharing" banner via `desktopCapturer` instead of `getDisplayMedia`. Since Peek is self-hostable per-domain (TURN config is per-deployment via `.env`), the shell just navigates to whatever room URL it's given — same as a browser tab; it never bundles or duplicates any frontend code, so it needs its own repo (separate build/release/codesigning pipeline) with zero risk of drifting out of sync. LAN/offline-from-internet use falls out for free from self-hosting + WebRTC ICE finding local candidates without STUN/TURN.

## Collaboration

- [ ] **Rejected: local contacts / friends list** — considered a client-side contacts system (local keypair + `localStorage` label per contact, added via out-of-band invite link, no server directory/discovery). Dropped because without accounts there's no cross-room presence, so "friending" someone only pays off if you can PM them outside a room — and *that* needs presence tracking, a bigger step against no-server-storage than a contacts list justifies. **Saved rooms** (see `CHANGELOG.md`) covers the actual need. Revisit only if async P2P messaging becomes a real goal — see Direct messaging below.
- [ ] **Direct messaging (P2P data channel)** — deprioritized 2026-07-10: owner considers this moot without a friends/contacts list (rejected above), since in-room-only DMs don't cover the real use case. Keeping the technical sketch in case that changes: private 1-to-1 chat between any two participants via `RTCDataChannel` on the existing peer connection, so messages never touch the signaling server. Click a participant's avatar/name to open a scoped DM panel alongside group chat. Implementation lives in `PeerManager.js` (open a named data channel per peer on connect, handle `ondatachannel` on the receiving side). Works identically in the hosted web version and the future Electron build since data channels are P2P after ICE.
- [ ] **Screen annotation/drawing** — overlay a canvas on the shared screen so participants can circle/mark things, useful for code review.

## New feature ideas (brainstorm — 2026-07-04)

Not yet scoped/estimated — captured here so they don't get lost; move into a proper section once someone picks one up.

- [ ] **Rejected: live captions** — considered a Web Speech API overlay, but Chrome's implementation actually relays audio to Google's cloud speech service (not on-device), which conflicts with the offline/no-third-party-request standing rule; a real on-device alternative (bundled Whisper via WASM) is a much better accent-accuracy fit for NZ English but adds 40-150MB of model weight and real CPU cost on top of an already-live call. Dropped for now — more bloat than the tool wants to carry at its current size, not worth it just to add captions. Revisit only if a lightweight on-device option becomes practical.
- [ ] **Collaborative whiteboard** — freestanding draw canvas (not just an overlay on a shared screen) synced via the existing data-channel broadcast pattern used for chat/reactions.
- [ ] **Discord-parity gap review (2026-07-11)** — from a feature-gap comparison against Discord. Message edit/delete, ban, in-chat search, custom avatars, and custom status text have all shipped (see `CHANGELOG.md`) — every session-scoped/client-side candidate from this review is now done. **Rejected: voice messages** — Peek rooms are live voice calls, so async voice clips have no real use case here (owner confirmed; heavy Discord user who never uses them). (Pinned messages and the emoji picker shipped via their own section — see Meeting-recap workflow, now removed as fully complete.)
- [ ] **Members sidebar unused space — partially addressed (2026-07-15)** — the raised-hands queue (see `CHANGELOG.md`) now occupies the space below the participant list while relevant, but it hides when nobody's hand is up, so the bottom half still sits empty in the common case. Call-status/bandwidth stats remains floated-and-set-aside (more a power-user/debug stat than permanent-sidebar material, see `DebugPanel.js`). Keeping as a low-priority flag.

## Accessibility

- [ ] **Broader ARIA/keyboard-nav pass (2026-07-14)** — the two "totally unreachable via keyboard" gaps (`#controls`, per-peer `.participant-actions`) and the Settings/lightbox focus traps are fixed (see `CHANGELOG.md`), but the audit that found them also found near-zero `role`/ARIA usage elsewhere in app code. Remaining, lower-urgency (things are reachable, just not well-described/navigable): custom popovers/menus (moderator kebab, quick-settings, invite, topbar identity, emoji picker, pinned/search panels) have no `role="menu"`/`aria-expanded`/arrow-key navigation — Escape-to-close already works consistently across all of them, this would just make them read/operate more like native menus for screen-reader and keyboard users. Drag-to-reposition self-view PiPs have no keyboard equivalent (mouse/touch only via Pointer Events). No concrete plan yet — flagging scope, not estimating.

## Bigger features (post-Electron)

- [ ] **Recording** — record the session locally.
- [ ] **Multiple rooms/channels (Discord-style)** — basic multi-room already works (`SessionManager.js` keys sessions by room code, anyone can create any number). What's missing for a real "server" feel is a *persistent* list of named channels you can browse and return to — today everything's in-memory and disappears on server restart. Would need an actual storage layer (even lightweight like SQLite) before this is worth building.
