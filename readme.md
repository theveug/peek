# Peek

**Peek** is a peer-to-peer video/screen-sharing and collaboration app built with vanilla JS, Node.js, and WebRTC. Create rooms, share screens or webcams, chat, send files, run polls, and react to messages — all without a database or accounts.

> "Peek" is a working placeholder name — expect a rebrand later.

## Why

Most video-call tools put a server between you and the person you're talking to, and that server ends up holding accounts, chat history, or a persisted room list. Peek deliberately doesn't:

- **No accounts.** Pick a nickname, join a room, done.
- **No persisted history.** Chat, reactions, and file transfers exist only for the lifetime of the room — a room's state disappears the moment the last peer leaves (`SessionManager.js`).
- **Media is peer-to-peer.** Video/audio/screen-share tracks and chat/files/polls all go directly between browsers over WebRTC (`RTCDataChannel` + media tracks) — the signalling server only ever relays connection setup messages, never content. If a direct connection isn't possible (symmetric NAT) and TURN is configured, that relay blind-forwards encrypted bytes — it can't read or store what's inside them.
- **Self-hostable, offline-first.** Every third-party dependency is self-hosted in `public/assets/vendor/` (no CDNs), there's no hardcoded STUN/TURN server, and the app works fully on a disconnected LAN — enforced by `tests/offline-selfhost.mjs`.

See `ARCHITECTURE.md`'s **Design principles** section for the full rationale, and how it shapes decisions about future features.

## Features

### Core
- Peer-to-peer screen sharing and webcam via WebRTC (mesh topology)
- Screen share audio capture and routing (separate from mic audio)
- Real-time chat with markdown rendering and syntax highlighting
- File sharing via `RTCDataChannel` (drag & drop, paste, or click to attach), with sender/receiver accept-or-decline consent and grouped caption+file messages
- Polls — create a question with up to 6 options, votes broadcast peer-to-peer in real time
- Adjustable stream quality (resolution + FPS) for both screen share and webcam independently
- Grid and focused view modes with zoom and pan
- Native browser picture-in-picture (OS-level floating window for the focused stream)

### Bandwidth management
- Click-to-watch grid tiles — streams beyond the first aren't decoded until clicked
- Real transceiver pausing via `sender.replaceTrack(null)` — unwatched streams stop transmitting entirely, no SDP renegotiation
- Watch slot cap (max 6 active streams, LRU eviction)
- Focus view automatically pauses all non-focused streams
- Adaptive quality tiers by participant count — resolution and FPS auto-cap as the room grows, restore when peers leave

### Rooms
- Lobby page for creating or joining rooms, with a client-side "Saved Rooms" bookmark list (`localStorage`, no server storage)
- Optional room names and passwords
- Room codes for easy sharing; direct links still work — password prompt shown if needed
- Creator-configurable participant cap (2–12, default 6)
- Room-full enforcement at both the lobby API and WebSocket join (defense-in-depth)
- **Moderation**: the room creator can promote/demote other peers to a second moderator tier, force-stop a peer's stream, or kick — identity is a server-issued token, not tied to any one connection, since every reconnect gets a brand-new peer ID

### Chat & privacy controls
- Message replies with inline quote preview, typing indicators, emoji reactions
- Code blocks with syntax highlighting (highlight.js) and copy button
- Notification sounds for new messages when tab/chat panel is unfocused
- Per-peer local block/mute (client-side only, invisible to the blocked peer) and per-peer volume, plus a master call volume

### Voice
- Microphone toggle with four modes: Toggle, Push-to-Talk, Push-to-Mute, Voice Activity (adaptive noise-floor detection, adjustable sensitivity)
- Customizable keybind for push-to-talk/push-to-mute
- Deafen toggle (mute all incoming audio)
- Discord-style speaking ring, driven by actual detected speech, not just mic-enabled state

### UI
- Connection quality indicator per participant (signal bars — RTT + packet loss from ICE stats)
- Dark/Light/System theme, plus accent-color and background-tint pickers
- Resizable, collapsible chat and members sidebar
- Status system: Online, Away, Do Not Disturb; auto-away when tab is hidden
- Self-view picture-in-picture overlay for your own screen share and webcam, drag-to-reposition

## Tech stack

- **Frontend:** Vanilla JS (ES modules), Tailwind CSS v4, marked.js, highlight.js, JSZip, DOMPurify — all self-hosted, no CDN dependencies
- **Backend:** Node.js, Express 5, `ws` (WebSocket)
- **Streaming:** WebRTC (video/audio tracks + `RTCDataChannel` for chat, files, polls)

## Getting started

### Prerequisites

- Node.js v18+
- A modern browser (Chrome, Edge, Firefox, Brave)

### Install & run

```bash
npm install
npm run dev
```

This starts the server (`nodemon server.js`) and a Tailwind CSS watcher together, on `http://localhost:3000` by default. For production: `npm run build:css && npm start`.

### HTTPS locally

WebRTC features (screen share, webcam, mic) require a secure context. `localhost` is treated as secure by most browsers without HTTPS, but if you need real HTTPS locally (e.g. testing from another device on your LAN), generate a cert with [mkcert](https://github.com/FiloSottile/mkcert):

```bash
mkcert -install
mkdir certs
mkcert -key-file certs/localhost-key.pem -cert-file certs/localhost.pem localhost 127.0.0.1 ::1
```

`server.js` detects `certs/localhost-key.pem` + `certs/localhost.pem` and switches to HTTPS automatically; otherwise it serves plain HTTP.

### Environment variables

Copy `.env.example` to `.env` — every variable is optional, and the app runs with sensible privacy-preserving defaults (no STUN/TURN configured means direct/LAN candidates only):

| Variable | Description |
| --- | --- |
| `APP_NAME` | Application name shown in server logs (default: `Peek`) |
| `APP_VERSION` | Version string, combined with a per-restart timestamp into a build ID clients use to detect a stale build after a deploy |
| `PORT` | Server port (default: `3000`) |
| `TURN_URL` / `TURN_SECRET` | TURN relay for internet deployments where direct P2P fails (symmetric NAT). The relay blind-forwards encrypted bytes — see "Why" above. |
| `STUN_URL` | Optional public STUN server. **No built-in default** (this used to be Google's public STUN — removed deliberately, since a third-party STUN server sees every participant's IP on every call). Not needed on a LAN or when TURN is set. |
| `TRUST_PROXY` | Set only when deployed behind a reverse proxy (nginx/caddy/cloudflared), so per-IP rate limiting sees real client IPs instead of the proxy's. Never set this without a proxy in front — it lets clients spoof their IP. |
| `DEBUG` | Enables server-side debug logging (room codes/names to stdout). Off by default so a deployment's captured logs never accumulate call metadata. |

### Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Server + Tailwind watch (development) |
| `npm run serve` | Node server only (with nodemon) |
| `npm start` | Node server (production) |
| `npm run build:css` | One-time Tailwind CSS build (run after editing `tailwind.css`) |
| `npm run tailwind` | Tailwind CSS watch mode only |

### Tests

All browser-driven tests use Playwright (`npx playwright install chromium` once per machine); a few are pure logic tests with no browser needed.

```bash
npm run test:ui                          # Playwright smoke test
npm run test:offline                     # disconnected-LAN / no-external-deps regression guard
npm run test:file-consent                # file transfer accept/decline flow
npm run test:file-transfer-concurrency   # concurrent multi-file transfers to one peer
npm run test:peer-block                  # local block/mute
npm run test:password-leak               # room password isolation across rooms
npm run test:quality-tiers               # adaptive quality vs. room size
npm run test:active-speaker              # active-speaker logic (pure, no browser)
npm run test:mic-gate                    # voice-activity mic gate logic (pure, no browser)
npm run test:audio-senders               # outbound-audio sender lifecycle
npm run test:caption-file-group          # grouped caption+files chat messages
npm run test:version-banner              # update-available banner
```

## Privacy & security

- No database — all sessions are ephemeral and in-memory, disappear when the last peer leaves
- Screen shares, webcam, audio, files, polls, chat, reactions, and typing indicators all transfer peer-to-peer — the signalling server never sees any user content, only WebRTC connection-setup messages
- Room passwords are held in memory only, cleared when the room empties
- No analytics, no tracking, no accounts
- No external services by default — STUN/TURN are opt-in via `.env`, and every third-party frontend dependency is self-hosted (no CDN calls ever), enforced by `npm run test:offline`

## Documentation

- **`ARCHITECTURE.md`** — design principles, the visual redesign's full history, and design rationale for notable features
- **`CHANGELOG.md`** — completed work, most recent first
- **`TODO.md`** — open backlog and known architectural limits (e.g. the mesh's scaling ceiling)
- **`CLAUDE.md`** — contributor/agent operating rules: file map, coding conventions, and gotchas already hit once

## License

ISC
