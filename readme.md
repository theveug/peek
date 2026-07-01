# Peek

**Peek** is a peer-to-peer screen sharing and collaboration app built with vanilla JS, Node.js, and WebRTC. Create rooms, share screens, chat, send files, run polls, and react to messages — all without a database or accounts.

## Features

### Core
- Peer-to-peer screen sharing and webcam via WebRTC (mesh topology)
- Screen share audio capture and routing (separate from mic audio)
- Real-time chat with markdown rendering and syntax highlighting
- File sharing via RTCDataChannel (drag & drop, paste, or click to attach)
- Polls — create a question with up to 6 options, votes broadcast peer-to-peer in real time
- Adjustable stream quality (resolution + FPS) for both screen share and webcam independently
- Grid and focused view modes with zoom and pan
- Native browser picture-in-picture (OS-level floating window for the focused stream)

### Bandwidth management
- Click-to-watch grid tiles — streams beyond the first aren't decoded until clicked
- Real transceiver pausing via `sender.replaceTrack(null)` — unwatched streams stop transmitting entirely, no SDP renegotiation
- Watch slot cap (max 6 active streams, LRU eviction with toast notification)
- Focus view automatically pauses all non-focused streams
- Stop watching button per tile for manual bandwidth control
- Adaptive quality tiers by participant count — resolution and FPS auto-cap as the room grows, restore when peers leave

### Rooms
- Lobby page for creating or joining rooms
- Optional room names and passwords
- Room codes for easy sharing; direct links still work — password prompt shown if needed
- Creator-configurable participant cap (2–12, default 6)
- Room-full enforcement at both the lobby API and WebSocket join (defense-in-depth)

### Chat
- Message replies with inline quote preview
- Typing indicators
- Message reactions (emoji, toggle on/off)
- Code blocks with syntax highlighting (highlight.js) and copy button
- Notification sounds for new messages when tab is unfocused
- Configurable max message history (DOM trimming)

### Files tab
- Dedicated Files tab in the chat panel listing every file shared during the session
- Files stored as Blobs in memory — available even after chat message limit trims the chat entry
- Per-file download button
- Download all as ZIP (client-side, via JSZip — no server involvement)

### Voice
- Microphone toggle with three modes: Toggle, Push-to-Talk, Push-to-Mute
- Customizable keybinds for mic modes
- Deafen toggle (mute all incoming audio)
- Status broadcast to peers (mic, deafen state)
- Audio continues when tab is backgrounded — only video pauses

### UI
- Connection quality indicator per participant (signal bars — RTT + packet loss from ICE stats, polled every 3 seconds)
- Dark and light mode with system detection and manual toggle
- Animated gradient background with frosted glass panels
- Resizable chat and members sidebar (widths persist to localStorage)
- Collapsible sidebars
- Discord-style members list with avatars, status dots, mic indicators, and signal strength
- Status system: Online, Away, Do Not Disturb
- Auto-away when tab is hidden
- Notification toasts for join/leave/sharing events
- Self-view picture-in-picture overlay for own screen share and webcam

### Settings
- Nickname (persistent, shown to peers)
- Screen share quality (720p/1080p/1440p/Source, 10–60 FPS)
- Webcam quality (360p/480p, 10–30 FPS)
- Sound volume and mute toggle
- Max chat messages
- Status picker (Online/Away/DND)
- Mic mode and keybind configuration

## Tech Stack

- **Frontend:** Vanilla JS (ES modules), Tailwind CSS v4, marked.js, highlight.js, JSZip
- **Backend:** Node.js, Express 5, ws (WebSocket)
- **Streaming:** WebRTC (video/audio tracks + RTCDataChannel for chat, files, polls)
- **CSS:** Tailwind CLI with custom properties theme system

## Getting Started

### Prerequisites

- Node.js v18+
- A modern browser (Chrome, Edge, Firefox, Brave)

### Install

```bash
npm install
```

### Run (development)

```bash
npm run dev
```

Starts both the Node server (with nodemon) and Tailwind CSS in watch mode.

### Run (production)

```bash
npm run build:css
npm start
```

### Visit

```
http://localhost:3000
```

Opens the lobby where you can create or join a room.

## HTTPS (local)

WebRTC features (screen share, webcam, mic) require a secure context. For local development, generate a self-signed cert with [mkcert](https://github.com/FiloSottile/mkcert):

```bash
mkcert -install
mkcert localhost
mkdir certs
mv localhost.pem certs/localhost.pem
mv localhost-key.pem certs/localhost-key.pem
```

The server detects the cert files and switches to HTTPS automatically.

## Environment Variables

Copy `.env.example` to `.env` and configure as needed.

| Variable | Required | Description |
| --- | --- | --- |
| `APP_NAME` | No | Application name shown in server logs (default: `Peek`) |
| `APP_VERSION` | No | Version string shown in server logs (default: `0.0.0`) |
| `PORT` | No | Server port (default: `3000`) |
| `TURN_URL` | No | TURN server URL e.g. `turn:turn.example.com:3478` |
| `TURN_SECRET` | No | TURN shared secret for HMAC credential generation |

TURN is recommended for production to support peers behind symmetric NATs. Without it, only STUN (Google's public server) is used — which handles the majority of home/office connections without port forwarding.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Server + Tailwind watch (development) |
| `npm run serve` | Node server only (with nodemon) |
| `npm start` | Node server (production) |
| `npm run build:css` | One-time Tailwind CSS build |
| `npm run tailwind` | Tailwind CSS watch mode only |

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `F2` | Toggle debug panel |
| Custom keybind | Push-to-talk or push-to-mute (set in Settings) |

## Privacy & Security

- No database — all sessions are ephemeral and in-memory, disappear when the last peer leaves
- Screen shares, webcam, audio, files, polls, chat messages, reactions, and typing indicators all transfer peer-to-peer via RTCDataChannel or WebRTC media tracks — the signalling server never sees any user content
- Room passwords are held in memory only, cleared when the room empties
- No analytics, no tracking, no accounts
- Only external services used: Google STUN for ICE negotiation, and optionally a self-hosted TURN relay

## License

MIT
