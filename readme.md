# Peek

**Peek** is a lightweight WebRTC-based screen sharing app built with vanilla JS, Node.js, and Tailwind CSS. It lets users share their screen in real-time over a unique session link, with optional stream quality controls.

## 🚀 Features

- 🔗 One-click session creation (`/session/:uuid`)
- 📺 Peer-to-peer screen sharing via WebRTC
- 🎛️ Adjustable stream quality (FPS + resolution)
- 📦 No database — fully in-memory sessions
- 📡 WebSocket-based signaling
- 🧪 "Still streaming..." mode when tab is unfocused
- 💬 In-session ephemeral chat (no storage)

## 📦 Tech Stack

- **Frontend:** Vanilla JS + Tailwind CSS
- **Backend:** Node.js (Express + WS)
- **Streaming:** WebRTC (mesh topology)
- **CSS Processing:** Tailwind CLI

## 🛠️ Getting Started

### Prerequisites

- Node.js (v18+ recommended)
- A modern browser (Chrome, Brave, Firefox)

### Install dependencies

```bash
npm install
```

### Start the app

```bash
npm run dev
```

This runs:

- nodemon server.js (backend)
- tailwindcss in watch mode (frontend CSS)

### Visit the app

```bash
http://localhost:3000
```

It will redirect to a unique session like `/session/4d8e1fae-...`

## ⚙️ Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start server + Tailwind watch |
| `npm run serve` | Just run the Node server |
| `npm run tailwind` | Watch and compile Tailwind CSS |

## 🛡️ Security & Privacy

Peek does not store or log any data — all sessions are ephemeral and exist only in memory. Screen shares are peer-to-peer via WebRTC.

> Note: There is no authentication or access control. Anyone with a session URL can join. Intended for small teams or internal use.

## 📘 License

MIT
