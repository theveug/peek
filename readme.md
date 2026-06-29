# Peek

**Peek** is a peer-to-peer screen sharing and collaboration app built with vanilla JS, Node.js, and WebRTC. Create rooms, share screens, chat with markdown support, send files, and react to messages — all without a database.

## Features

### Core
- Peer-to-peer screen sharing via WebRTC (mesh topology)
- Real-time chat with markdown rendering and syntax highlighting
- File sharing via RTCDataChannel (drag & drop, paste, or click to attach)
- Adjustable stream quality (resolution + FPS)
- Grid and focused view modes with zoom and pan

### Rooms
- Lobby page for creating or joining rooms
- Optional room names and passwords
- 5-character room codes for easy sharing
- Direct links still work — password prompt shown if needed

### Chat
- Typing indicators ("X is typing...")
- Message reactions (6 preset emoji, toggle on/off)
- Link previews with inline image rendering
- Code blocks with syntax highlighting and copy button
- Notification sounds for new messages when tab is unfocused

### Voice
- Microphone toggle with three modes: Toggle, Push-to-Talk, Push-to-Mute
- Customizable keybinds for mic modes
- Deafen toggle (mute all incoming audio)
- Status broadcast to peers (mic, deafen state)

### UI
- Dark and light mode with system detection and manual toggle
- Animated gradient background with frosted glass panels
- Resizable chat panel and members sidebar (widths persist)
- Collapsible sidebars with toggle buttons
- Discord-style members list with avatars, status dots, and mic indicators
- Status system: Online, Away, Do Not Disturb
- Auto-away when tab is hidden (pauses incoming video to save bandwidth)
- Notification toasts for join/leave/sharing events
- Picture-in-picture self-view

### Settings
- Nickname (persistent, shown to peers)
- Stream quality (720p/1080p/1440p/Source, 10-60 FPS)
- Sound volume and mute toggle
- Max chat messages
- Status picker (Online/Away/DND)
- Mic mode and keybind configuration

## Tech Stack

- **Frontend:** Vanilla JS, Tailwind CSS v4, marked.js, highlight.js
- **Backend:** Node.js, Express 5, ws (WebSocket)
- **Streaming:** WebRTC (video/audio tracks + data channels)
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

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | Server port (default: 3000) |
| `TURN_URL` | No | TURN server URL (e.g. `turn:turn.example.com:3478`) |
| `TURN_SECRET` | No | TURN shared secret for HMAC credential generation |

TURN is recommended for production to support peers behind symmetric NATs. Without it, only STUN is used (Google's public server).

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Server + Tailwind watch (development) |
| `npm run serve` | Node server only (with nodemon) |
| `npm start` | Node server (production) |
| `npm run build:css` | One-time Tailwind CSS build |
| `npm run tailwind` | Tailwind CSS watch mode |

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `F2` | Toggle debug panel |
| Custom keybind | Push-to-talk or push-to-mute (set in settings) |

## Privacy & Security

- No database — all sessions are ephemeral and in-memory
- Screen shares and files transfer peer-to-peer via WebRTC
- Chat messages are relayed through the server but never stored
- Room passwords are held in memory only, cleared when the room empties
- No analytics, no tracking, no third-party services (except STUN/TURN)

## License

MIT
