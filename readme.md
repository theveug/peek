# Peek - WebSocket Screensharing App

## 💡 Project Overview

Peek is a lightweight, real-time screensharing app built with WebRTC and WebSockets. It enables secure, multi-user screen sharing with a gallery-style layout. Each session is ephemeral and accessed via UUID-based URLs.

### Core Features

- Encrypted peer-to-peer screen sharing using WebRTC.
- WebSocket signaling server for managing sessions and connections.
- Auto-generated session URLs (`/` redirects to `/session/:uuid`).
- All users in a session can share screens simultaneously.
- Gallery view for all shared streams.
- Click on any stream to view fullscreen.
- Automatic stream cleanup when a user stops sharing.
- Written in an object-oriented, modular fashion for easy expansion.

---

## 💪 Tech Stack

- Node.js + Express (server)
- WebSocket (`ws`)
- WebRTC (peer-to-peer screen sharing)
- Vanilla JS modules (client-side)
- UUID (for session routing)
- HTML/CSS frontend (basic styling)
- Herd server for local developnment (peek.test)

---

## 📁 Project Structure

peek/
 ├── server.js
 ├── package.json
 ├── public/
 │ ├── assets/
 │ │ ├── style.css
 │ ├── client/
 │ │ ├── App.js
 │ │ ├── ScreenManager.js
 │ │ └── UIController.js
 │ └── index.html
 ├── src/
 │ └── server/
 │ ├── SessionManager.js
 │ └── SignalingHandler.js

---

## 🚀 Getting Started

### 1. Install Dependencies

```bash
npm install
npm run dev
```

Then open <http://localhost:3000> in your browser. It’ll redirect you to a session.

---

## 🔍 Known Issues / To-Do

- [ ] Automatically show new streams without needing refresh.
- [ ] Stream cleanup doesn't distinguish sender identity correctly.
- [ ] UI polish (stream labels, better fullscreen toggle).
- [ ] User presence indicator.
- [ ] Permissions / host control (optional).
- [ ] Stream quality selection. (FPS, Resolution (maybe?))
- [ ] Error handling for permission denial or dropped connections.

---

## 🧠 Contribution Notes (for ChatGPT)

This project is being iteratively developed with the help of ChatGPT. OOP structure, modular architecture, and clean expansion paths are a priority.

Focus areas for improvement:

- Signaling scalability.
- Connection reliability (especially on late joins).
- Clean stream/peer lifecycle management.
- UX niceties (mute indicators, stream owner tags).
