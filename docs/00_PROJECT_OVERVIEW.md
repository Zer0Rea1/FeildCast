# FieldCast — Project Overview

## What This System Does

A mobile-first live news conference platform for 96 News HD.

- **Admin** creates a conference, selects reporters and an anchor from registered users
- **Reporters** receive a push notification, open the app, tap Join, and stream live video from their phone camera to the backend via WebSocket
- **Backend (Node.js + FFmpeg)** receives each reporter's video stream and pushes it to the existing SRT broadcast server
- **Anchor** joins the conference via the app, watches all reporter feeds live via WebRTC, and communicates with reporters in real time
- **Admin dashboard (web)** shows live HLS preview of every active reporter stream, conference management, and session monitoring

## Architecture

```
[Reporter Phone — React Native]
        |
        | Camera → MediaRecorder → WebSocket chunks
        v
[Backend — Node.js + FFmpeg]
        |
        | FFmpeg transcodes → SRT push per reporter
        v
[Existing SRT Server]
        |
        ├── HLS conversion → Admin dashboard preview
        └── OBS / Playout → On air

[Anchor Phone — React Native]
        |
        | WebRTC (via LiveKit)
        ↕
[All Reporters — WebRTC]
        (two-way audio/video communication during conference)
```

## Key Design Decisions

1. **Same SRT bridge as LiveDesk** — Reporter phone sends WebSocket video chunks to Node.js. FFmpeg transcodes to H.264/AAC MPEG-TS and pushes SRT. Each reporter gets a unique `streamid`.
2. **No invite links** — Reporters are added to a conference by the admin. They receive a push notification (Expo Push Notifications) and see a Join button in the app. Auth is their existing JWT session.
3. **WebRTC via LiveKit** — Anchor and reporters communicate via LiveKit SFU. LiveKit has a solid React Native SDK and a self-hostable server. Anchor sees all reporter video tiles. Reporters see the anchor.
4. **HLS preview in dashboard** — Same system as LiveDesk. Backend FFmpeg outputs a second HLS stream alongside the SRT push. Admin dashboard shows all active feeds as video tiles.
5. **Anchor does NOT push SRT** — Only reporters push SRT for broadcast. Anchor is communication-only via WebRTC.
6. **Single backend server** — REST API, WebSocket SRT bridge, HLS static serving, and LiveKit room management all run on one Node.js/Express server.

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Mobile app | React Native (Expo SDK 52) | Reporter + anchor app, single codebase Android/iOS |
| Admin dashboard | React + Vite | Web dashboard for admin |
| Backend API | Node.js + Express + TypeScript | Auth, conferences, WebSocket bridge |
| WebRTC | LiveKit (self-hosted) | Anchor ↔ reporter real-time communication |
| Media bridge | FFmpeg | WebSocket → H.264 → SRT + HLS |
| Database | PostgreSQL via Prisma | Users, conferences, participants, sessions |
| Auth | JWT (jsonwebtoken) | App login, session management |
| Push notifications | Expo Push Notifications | Conference invite alerts |
| SRT server | Your existing server | Receives broadcast streams |
| Hosting | Linux VPS (Ubuntu 22.04) | Backend + LiveKit |

## Port Map

| Port | Service |
|---|---|
| 3000 | Express API + WebSocket bridge |
| 7880 | LiveKit server (HTTP/WebSocket) |
| 7881 | LiveKit server (RTC TCP) |
| 50000–60000/UDP | LiveKit WebRTC media |
| 80/443 | Nginx (production) |

## Repository Structure

```
fieldcast/
├── backend/
│   ├── src/
│   │   ├── index.ts                  # Express + WS server entry
│   │   ├── routes/
│   │   │   ├── auth.ts               # Register, login
│   │   │   ├── users.ts              # User list (admin)
│   │   │   ├── conferences.ts        # Conference CRUD
│   │   │   └── participants.ts       # Add/remove participants
│   │   ├── ws/
│   │   │   └── srtBridge.ts          # WebSocket → FFmpeg → SRT + HLS
│   │   ├── middleware/
│   │   │   ├── auth.ts               # JWT guard
│   │   │   └── adminOnly.ts          # Admin role guard
│   │   ├── lib/
│   │   │   ├── livekit.ts            # LiveKit room management
│   │   │   ├── pushNotifications.ts  # Expo push sender
│   │   │   ├── tokenService.ts       # Stream ID generation
│   │   │   └── ffmpegSpawner.ts      # FFmpeg process manager
│   │   └── prisma/
│   │       └── schema.prisma
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── .env.example
├── mobile/
│   ├── app/
│   │   ├── (auth)/
│   │   │   ├── login.tsx
│   │   │   └── register.tsx
│   │   ├── (reporter)/
│   │   │   ├── home.tsx              # Conference list + join button
│   │   │   └── conference.tsx        # Live streaming screen
│   │   ├── (anchor)/
│   │   │   ├── home.tsx              # Conference list
│   │   │   └── conference.tsx        # Reporter grid + WebRTC
│   │   └── (admin)/
│   │       ├── home.tsx              # Conference list
│   │       └── create.tsx            # Create conference form
│   ├── components/
│   │   ├── VideoTile.tsx             # Single reporter video tile
│   │   ├── ConferenceCard.tsx        # Conference list item
│   │   └── StreamControls.tsx        # Mic/cam toggle buttons
│   ├── hooks/
│   │   ├── useAuth.ts
│   │   ├── useConference.ts
│   │   └── useLiveKit.ts
│   ├── lib/
│   │   ├── api.ts                    # Axios API client
│   │   ├── auth.ts                   # Token storage (SecureStore)
│   │   └── wsStream.ts               # WebSocket video streaming
│   ├── app.json
│   └── package.json
├── dashboard/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── Login.tsx
│   │   │   ├── Dashboard.tsx         # Active conferences + HLS previews
│   │   │   ├── CreateConference.tsx
│   │   │   └── ConferenceDetail.tsx  # Per-conference stream tiles
│   │   ├── components/
│   │   │   ├── HLSPlayer.tsx         # hls.js video player component
│   │   │   ├── ConferenceCard.tsx
│   │   │   └── ParticipantBadge.tsx
│   │   └── api/
│   │       └── client.ts
│   ├── package.json
│   └── vite.config.ts
├── infra/
│   ├── docker-compose.yml
│   ├── livekit.yaml                  # LiveKit server config
│   └── nginx.conf
└── docs/
    └── (these markdown files)
```
