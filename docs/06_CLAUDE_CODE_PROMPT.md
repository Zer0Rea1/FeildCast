# Claude Code Prompt — Build FieldCast

Use this file with Claude Code to scaffold and build the entire FieldCast system.

---

## Master Prompt

```
You are building a mobile-first live news conference and broadcast platform called "FieldCast"
for a Pakistani news channel (96 News HD).

Read ALL documentation files in the /docs folder before writing any code:
- 00_PROJECT_OVERVIEW.md  — architecture, tech stack, folder structure, design decisions
- 01_BACKEND_API.md       — Prisma schema, Express routes (auth, users, conferences, participants)
- 02_BACKEND_LIBS.md      — LiveKit lib, push notifications, tokenService, WebSocket SRT bridge
- 03_MOBILE_APP.md        — React Native (Expo) app: login, reporter home, reporter conference screen
- 04_DASHBOARD_AND_ANCHOR.md — React admin dashboard with HLS player, anchor LiveKit screen
- 05_INFRASTRUCTURE.md    — LiveKit setup, Docker Compose, Nginx, Dockerfile, deployment

Build in this exact order:

PHASE 1 — SCAFFOLD
1. Create folder structure exactly as in 00_PROJECT_OVERVIEW.md
2. Initialize backend/package.json with all dependencies from 01_BACKEND_API.md
3. Initialize mobile/ with: npx create-expo-app . --template blank-typescript
   Then install all packages listed in 03_MOBILE_APP.md
4. Initialize dashboard/ with: npm create vite@latest . -- --template react-ts
   Then install packages from 04_DASHBOARD_AND_ANCHOR.md
5. Create all .env.example files
6. Create backend/tsconfig.json

PHASE 2 — DATABASE
7. Create backend/src/prisma/schema.prisma EXACTLY as in 01_BACKEND_API.md
   — binaryTargets must include native, linux-musl, debian-openssl-3.0.x
8. Run: cd backend && CI=true NO_COLOR=1 npx prisma generate --schema=src/prisma/schema.prisma
9. Confirm no errors before continuing

PHASE 3 — BACKEND
Build in this exact file order:
10. backend/src/index.ts
11. backend/src/middleware/auth.ts
12. backend/src/routes/auth.ts
13. backend/src/routes/users.ts
14. backend/src/routes/conferences.ts
15. backend/src/routes/participants.ts
16. backend/src/lib/livekit.ts
17. backend/src/lib/pushNotifications.ts
18. backend/src/lib/tokenService.ts
19. backend/src/ws/srtBridge.ts
20. Run: cd backend && npx tsc --noEmit
21. Fix ALL TypeScript errors. Zero errors required before continuing.

PHASE 4 — MOBILE APP
Build in this exact file order:
22. mobile/lib/api.ts
23. mobile/lib/auth.ts
24. mobile/lib/wsStream.ts
25. mobile/lib/notifications.ts
26. mobile/app/(auth)/login.tsx
27. mobile/app/(reporter)/home.tsx
28. mobile/app/(reporter)/conference.tsx
29. mobile/app/(anchor)/conference.tsx
30. mobile/app.json — include all plugins and permissions from 03_MOBILE_APP.md

PHASE 5 — ADMIN DASHBOARD
31. dashboard/vite.config.ts
32. dashboard/src/api/client.ts
33. dashboard/src/components/HLSPlayer.tsx
34. dashboard/src/pages/Dashboard.tsx
35. dashboard/src/pages/CreateConference.tsx
36. dashboard/src/App.tsx — with React Router, login guard, routes to all pages
37. Run: cd dashboard && npm run build — fix all errors

PHASE 6 — INFRASTRUCTURE
38. infra/livekit.yaml
39. infra/docker-compose.yml
40. infra/nginx.conf
41. backend/Dockerfile — must use node:20-bookworm-slim and install FFmpeg

PHASE 7 — FINAL CHECKS
42. Verify ALL API routes in dashboard/src/api/client.ts match routes in backend/src/routes/
43. Verify conference WebSocket URL in mobile/lib/wsStream.ts is configurable (not hardcoded)
44. Verify LiveKit URL in mobile app is read from EXPO_PUBLIC_LIVEKIT_URL env var
45. Verify SRT bridge in srtBridge.ts uses SRT_SERVER_HOST + SRT_SERVER_PORT from env — never hardcoded
46. Verify push notification is sent in participants.ts when a user is added to a conference
47. Verify Prisma binaryTargets includes debian-openssl-3.0.x
48. Create root README.md with:
    - One paragraph describing the system
    - Prerequisites list
    - Quick start (docker compose up -d --build)
    - How to create the first admin user
    - Mobile app build command (npx expo build:android)

CRITICAL RULES:
- Follow every code sample in the docs EXACTLY
- SRT_SERVER_HOST and SRT_SERVER_PORT always come from environment variables — never hardcoded
- Prisma must use npx (not bunx) with CI=true NO_COLOR=1 prefix to avoid spinner hanging
- The WebSocket bridge validates the user's JWT and their conference membership before starting FFmpeg
- Push notification is sent automatically when admin adds a participant — not manually
- Each reporter gets their own unique streamId and their own FFmpeg process
- HLS output path is /hls/{streamId}/index.m3u8 served by Express static middleware
- LiveKit token is generated server-side — never expose LIVEKIT_API_SECRET to the client
- After each phase, list every file created before moving to the next phase
```

---

## Phase-by-Phase Prompts

Use these if you prefer to build one phase at a time.

### Phase 1 — Scaffold only
```
Create the complete folder structure for FieldCast as defined in 00_PROJECT_OVERVIEW.md.
Initialize package.json files for backend, mobile, and dashboard with correct dependencies.
Create all .env.example files. Do not write any application logic yet.
```

### Phase 2 — Database only
```
Create backend/src/prisma/schema.prisma exactly as defined in 01_BACKEND_API.md.
The schema has these models: User, Conference, Participant, StreamSession.
binaryTargets must be ["native", "linux-musl", "debian-openssl-3.0.x"].
Run: CI=true NO_COLOR=1 npx prisma generate --schema=src/prisma/schema.prisma
Show the output. Fix any errors.
```

### Phase 3 — Backend only
```
Build the complete Node.js backend from 01_BACKEND_API.md and 02_BACKEND_LIBS.md.
Key requirements:
- Participants route sends push notification when user is added to conference
- Conference route generates LiveKit token server-side using LIVEKIT_API_KEY + LIVEKIT_API_SECRET
- srtBridge.ts validates JWT + conference membership before spawning FFmpeg
- FFmpeg has dual output: SRT push + HLS segments
- SRT target always uses process.env.SRT_SERVER_HOST and SRT_SERVER_PORT

After all files: npx tsc --noEmit — zero errors required.
```

### Phase 4 — Mobile app only
```
Build the React Native Expo mobile app from 03_MOBILE_APP.md.
Key requirements:
- Login screen routes to different home screens based on user role (ADMIN/REPORTER/ANCHOR)
- After login, app saves Expo push token to backend via PATCH /api/auth/push-token
- Reporter home screen polls for conferences and shows Join button per conference
- Reporter conference screen streams camera via WebSocket to /stream endpoint
- Anchor conference screen joins LiveKit room and shows reporter video tiles
- All API base URLs and WebSocket URLs must be configurable via environment variables
```

### Phase 5 — Dashboard only
```
Build the React admin dashboard from 04_DASHBOARD_AND_ANCHOR.md.
Key requirements:
- Dashboard page polls every 5 seconds for active conferences
- For each LIVE conference, show HLS video tiles for reporters who have a streamId
- HLSPlayer component retries if stream is not ready yet (3 second retry on error)
- CreateConference page lets admin select users, assign roles, and set quality presets
- When conference is created, participants are added immediately and receive push notifications
Run: npm run build — must succeed with no errors.
```

### Phase 6 — Infrastructure only
```
Create all infrastructure files from 05_INFRASTRUCTURE.md:
- infra/livekit.yaml with port_range_start: 50000, port_range_end: 60000
- infra/docker-compose.yml — includes db, backend, dashboard, livekit, nginx services
- infra/nginx.conf — includes WebSocket upgrade on /stream, HLS proxy, LiveKit proxy
- backend/Dockerfile — node:20-bookworm-slim base, installs FFmpeg via apt, verifies SRT support
```

---

## Updated Master Prompt (includes new architecture + all screens)

```
Read these additional docs alongside the original 6:
- 07_NEW_ARCHITECTURE.md  — LiveKit Ingress setup, updated srtBridge.ts with 3 FFmpeg outputs,
                            updated livekit.ts with IngressClient, reporter audio-only LiveKit join
- 08_MISSING_SCREENS.md   — All remaining screens: app _layout.tsx, anchor home, admin home,
                            admin create (mobile), dashboard Login, Layout, ConferenceDetail

Key rules for new architecture:
- Reporter phone sends video via WebSocket ONLY — never via LiveKit directly
- Reporter joins LiveKit in audio-only mode (canPublish: false for video)
- FFmpeg uses tee muxer for 3 simultaneous outputs: SRT + RTMP (LiveKit Ingress) + HLS
- createReporterIngress() is called BEFORE spawning FFmpeg in srtBridge.ts
- deleteReporterIngress() is called on WebSocket close
- If Ingress creation fails, continue with SRT + HLS only (non-fatal fallback)
- Anchor app is unchanged — it sees reporter video via LiveKit Ingress, hears reporter audio directly
- Add livekit-ingress service to docker-compose.yml
- Open port 1935 (RTMP) and 8080 (Ingress API) in firewall
```
