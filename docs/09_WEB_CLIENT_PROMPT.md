# FieldCast Web Client — Claude Code Agent Prompt

## Context

FieldCast is a live news conference and broadcast platform.
The backend is already fully built and running at `http://localhost:3000`.
We are replacing the React Native mobile app with a **web app** that will be
served from the same server and loaded inside an Android WebView.

Read the existing backend docs before starting:
- `docs/00_PROJECT_OVERVIEW.md` — architecture overview
- `docs/01_BACKEND_API.md` — all API routes and auth
- `docs/02_BACKEND_LIBS.md` — WebSocket SRT bridge details

---

## What to Build

A single Vite + React web app (`web-client/`) that covers three user roles:
- **Reporter** — sees conference list, joins, streams live camera via WebSocket → backend → SRT
- **Anchor** — sees conference list, joins, watches reporter feeds via LiveKit JS SDK
- **Admin** — redirect to dashboard (already built separately)

This web app runs in the browser AND inside an Android WebView.
No React Native. No Expo. No native modules.

---

## Folder Structure to Create

```
fieldcast/
└── web-client/
    ├── index.html
    ├── vite.config.ts
    ├── package.json
    ├── tsconfig.json
    ├── .env.example
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── api/
        │   └── client.ts
        ├── lib/
        │   ├── auth.ts           # token storage (localStorage)
        │   ├── wsStream.ts       # WebSocket video streaming
        │   └── notifications.ts  # push notification registration
        ├── pages/
        │   ├── Login.tsx
        │   ├── Conferences.tsx   # list — reporter and anchor both use this
        │   ├── ReporterConference.tsx
        │   └── AnchorConference.tsx
        └── components/
            ├── ProtectedRoute.tsx
            ├── ConferenceCard.tsx
            └── StreamHUD.tsx
```

---

## Phase 1 — Setup

```bash
cd fieldcast
npm create vite@latest web-client -- --template react-ts
cd web-client
npm install axios react-router-dom livekit-client @livekit/components-react
npm install -D @types/node
```

### `vite.config.ts`

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3001,
    host: '0.0.0.0',  // required — Android WebView needs LAN IP not localhost
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/hls': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/stream': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
```

### `.env.example`

```bash
# In development — proxied by Vite, no need to set
VITE_API_URL=

# LiveKit public URL
# Dev: ws://localhost:7880 or wss://your-livekit-cloud-url
VITE_LIVEKIT_URL=ws://localhost:7880

# WebSocket stream URL
# Dev: leave empty — proxied by Vite at /stream
# Prod: wss://fieldcast.yourdomain.com/stream
VITE_WS_URL=
```

---

## Phase 2 — API Client & Auth

### `src/api/client.ts`

```typescript
import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
});

// Attach JWT to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('fc_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auto logout on 401
api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('fc_token');
      localStorage.removeItem('fc_user');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;

export const authApi = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  savePushToken: (token: string) =>
    api.patch('/auth/push-token', { expoPushToken: token }),
};

export const conferencesApi = {
  list: () => api.get('/conferences'),
  get: (id: string) => api.get(`/conferences/${id}`),
  join: (id: string) => api.patch(`/conferences/${id}/participants/join`),
  getLiveKitToken: (id: string) => api.post(`/conferences/${id}/livekit-token`),
};
```

### `src/lib/auth.ts`

```typescript
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'REPORTER' | 'ANCHOR';
}

export function saveAuth(token: string, user: AuthUser) {
  localStorage.setItem('fc_token', token);
  localStorage.setItem('fc_user', JSON.stringify(user));
}

export function getToken(): string | null {
  return localStorage.getItem('fc_token');
}

export function getUser(): AuthUser | null {
  const raw = localStorage.getItem('fc_user');
  return raw ? JSON.parse(raw) : null;
}

export function clearAuth() {
  localStorage.removeItem('fc_token');
  localStorage.removeItem('fc_user');
}

export function isLoggedIn(): boolean {
  return !!getToken();
}
```

### `src/lib/wsStream.ts`

```typescript
// WebSocket video streaming — same protocol as the backend srtBridge.ts expects
// Reporter captures camera via getUserMedia() → MediaRecorder → WebSocket → FFmpeg → SRT

const WS_URL = import.meta.env.VITE_WS_URL || '/stream';

export class SrtStreamer {
  private ws: WebSocket | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private bytesSent = 0;

  private onReady?: (streamId: string) => void;
  private onError?: (msg: string) => void;
  private onStats?: (bytes: number) => void;
  private onDisconnect?: () => void;

  constructor(callbacks: {
    onReady?: (streamId: string) => void;
    onError?: (msg: string) => void;
    onStats?: (bytes: number) => void;
    onDisconnect?: () => void;
  }) {
    Object.assign(this, callbacks);
  }

  async start(token: string, conferenceId: string, stream: MediaStream, bitrate: number) {
    // Build WebSocket URL with auth token and conferenceId
    const wsUrl = `${WS_URL}?token=${encodeURIComponent(token)}&conferenceId=${conferenceId}`;
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('[WSStream] Connected to bridge');
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'ready') {
          // Backend is ready — start sending video
          this.startRecording(stream, bitrate);
          this.onReady?.(msg.streamId);
        } else if (msg.type === 'error') {
          this.onError?.(msg.message);
          this.stop();
        }
      } catch {}
    };

    this.ws.onerror = () => this.onError?.('WebSocket connection failed');
    this.ws.onclose = () => {
      this.stopRecording();
      this.onDisconnect?.();
    };
  }

  private startRecording(stream: MediaStream, bitrate: number) {
    // Pick best supported codec
    const mimeType = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ].find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';

    this.mediaRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: bitrate * 1000,
      audioBitsPerSecond: 128000,
    });

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0 && this.ws?.readyState === WebSocket.OPEN) {
        e.data.arrayBuffer().then(buf => {
          this.ws!.send(buf);
          this.bytesSent += buf.byteLength;
          this.onStats?.(this.bytesSent);
        });
      }
    };

    // 100ms chunks — same as LiveDesk
    this.mediaRecorder.start(100);
  }

  private stopRecording() {
    if (this.mediaRecorder?.state !== 'inactive') {
      this.mediaRecorder?.stop();
    }
    this.mediaRecorder = null;
  }

  stop() {
    this.stopRecording();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }

  get isStreaming(): boolean {
    return this.ws?.readyState === WebSocket.OPEN &&
           this.mediaRecorder?.state === 'recording';
  }

  get totalBytesSent(): number {
    return this.bytesSent;
  }
}

// Get camera + microphone stream with quality settings
export async function getCameraStream(resolution: string, fps: number): Promise<MediaStream> {
  const [width, height] = resolution.split('x').map(Number);
  return navigator.mediaDevices.getUserMedia({
    video: {
      width:     { ideal: width },
      height:    { ideal: height },
      frameRate: { ideal: fps },
      facingMode: 'user',
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: 44100,
    },
  });
}
```

---

## Phase 3 — Pages

### `src/pages/Login.tsx`

```tsx
import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api/client';
import { saveAuth } from '../lib/auth';

export default function Login() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const { data } = await authApi.login(email, password);
      saveAuth(data.token, data.user);

      // Route based on role
      if (data.user.role === 'ADMIN')    navigate('/conferences');
      else if (data.user.role === 'ANCHOR')   navigate('/conferences');
      else                                    navigate('/conferences');
    } catch (e: any) {
      setError(e.response?.data?.error || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      <form onSubmit={handleSubmit} style={styles.form}>
        <div style={styles.logo}>● FieldCast</div>
        <p style={styles.sub}>Sign in to continue</p>

        <label style={styles.label}>Email</label>
        <input
          type="email" value={email} onChange={e => setEmail(e.target.value)}
          placeholder="your@email.com" required style={styles.input}
        />

        <label style={styles.label}>Password</label>
        <input
          type="password" value={password} onChange={e => setPassword(e.target.value)}
          placeholder="••••••••" required style={styles.input}
        />

        {error && <p style={styles.error}>{error}</p>}

        <button type="submit" disabled={loading} style={styles.btn}>
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page:  { minHeight: '100vh', display: 'flex', alignItems: 'center',
           justifyContent: 'center', background: '#0a0a0a' },
  form:  { background: '#141414', padding: 40, borderRadius: 16,
           width: '100%', maxWidth: 360, border: '1px solid #222' },
  logo:  { color: '#E24B4A', fontSize: 24, fontWeight: 700, marginBottom: 4 },
  sub:   { color: '#666', fontSize: 13, marginBottom: 28 },
  label: { display: 'block', fontSize: 11, color: '#888', marginBottom: 5,
           textTransform: 'uppercase', letterSpacing: '0.06em' },
  input: { width: '100%', padding: '10px 12px', background: '#1a1a1a',
           border: '1px solid #333', borderRadius: 8, color: '#fff',
           fontSize: 14, marginBottom: 14, outline: 'none' },
  error: { color: '#E24B4A', fontSize: 12, marginBottom: 12 },
  btn:   { width: '100%', padding: 12, background: '#E24B4A', color: '#fff',
           border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600,
           cursor: 'pointer' },
};
```

### `src/pages/Conferences.tsx`

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { conferencesApi } from '../api/client';
import { getUser, clearAuth } from '../lib/auth';

interface Conference {
  id: string;
  title: string;
  description?: string;
  status: 'PENDING' | 'LIVE' | 'ENDED';
  participants: any[];
}

export default function Conferences() {
  const [conferences, setConferences] = useState<Conference[]>([]);
  const [loading, setLoading]         = useState(true);
  const navigate = useNavigate();
  const user = getUser();

  async function load() {
    try {
      const { data } = await conferencesApi.list();
      setConferences(data);
    } catch {}
    finally { setLoading(false); }
  }

  useEffect(() => {
    load();
    // Poll every 10 seconds for new conferences
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  function handleJoin(conf: Conference) {
    if (user?.role === 'REPORTER') navigate(`/reporter/${conf.id}`);
    else if (user?.role === 'ANCHOR') navigate(`/anchor/${conf.id}`);
  }

  function logout() {
    clearAuth();
    navigate('/login');
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <span style={styles.logo}>● FieldCast</span>
        <div style={styles.headerRight}>
          <span style={styles.userName}>{user?.name} · {user?.role}</span>
          <button onClick={logout} style={styles.logoutBtn}>Logout</button>
        </div>
      </div>

      <div style={styles.content}>
        <h1 style={styles.heading}>Your Conferences</h1>

        {loading && <p style={styles.empty}>Loading...</p>}

        {!loading && conferences.length === 0 && (
          <p style={styles.empty}>No conferences assigned yet.</p>
        )}

        {conferences.map(conf => (
          <div key={conf.id} style={styles.card}>
            <div style={styles.cardTop}>
              <span style={styles.title}>{conf.title}</span>
              <span style={{
                ...styles.badge,
                background: conf.status === 'LIVE' ? '#E24B4A' : '#333'
              }}>
                {conf.status === 'LIVE' ? '● LIVE' : conf.status}
              </span>
            </div>
            {conf.description && (
              <p style={styles.desc}>{conf.description}</p>
            )}
            <div style={styles.meta}>
              {conf.participants.length} participant{conf.participants.length !== 1 ? 's' : ''}
            </div>
            {conf.status !== 'ENDED' && (
              <button
                onClick={() => handleJoin(conf)}
                style={styles.joinBtn}
              >
                {user?.role === 'ANCHOR' ? 'Join as Anchor' : 'Go Live'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page:        { minHeight: '100vh', background: '#0a0a0a', color: '#fff' },
  header:      { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                 padding: '16px 20px', borderBottom: '1px solid #1a1a1a' },
  logo:        { color: '#E24B4A', fontWeight: 700, fontSize: 18 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 12 },
  userName:    { color: '#666', fontSize: 13 },
  logoutBtn:   { background: 'transparent', border: '1px solid #333', color: '#888',
                 borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12 },
  content:     { maxWidth: 600, margin: '0 auto', padding: '24px 20px' },
  heading:     { fontSize: 20, fontWeight: 600, marginBottom: 20 },
  card:        { background: '#141414', border: '1px solid #222', borderRadius: 12,
                 padding: 16, marginBottom: 12 },
  cardTop:     { display: 'flex', justifyContent: 'space-between',
                 alignItems: 'center', marginBottom: 6 },
  title:       { fontWeight: 600, fontSize: 15, flex: 1 },
  badge:       { color: '#fff', fontSize: 10, fontWeight: 700,
                 padding: '3px 8px', borderRadius: 5 },
  desc:        { color: '#666', fontSize: 13, marginBottom: 8 },
  meta:        { color: '#555', fontSize: 12, marginBottom: 12 },
  joinBtn:     { background: '#E24B4A', color: '#fff', border: 'none',
                 borderRadius: 8, padding: '10px 20px', fontSize: 13,
                 fontWeight: 600, cursor: 'pointer', width: '100%' },
  empty:       { color: '#555', textAlign: 'center', marginTop: 60 },
};
```

### `src/pages/ReporterConference.tsx`

```tsx
import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { conferencesApi } from '../api/client';
import { getToken } from '../lib/auth';
import { SrtStreamer, getCameraStream } from '../lib/wsStream';

export default function ReporterConference() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [conference, setConference]       = useState<any>(null);
  const [streaming, setStreaming]         = useState(false);
  const [streamId, setStreamId]           = useState('');
  const [bytesSent, setBytesSent]         = useState(0);
  const [duration, setDuration]           = useState(0);
  const [error, setError]                 = useState('');
  const [streamSettings, setStreamSettings] = useState({
    resolution: '1280x720', bitrate: 2500, fps: 25
  });

  const videoRef    = useRef<HTMLVideoElement>(null);
  const streamerRef = useRef<SrtStreamer | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const timerRef    = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    load();
    return () => {
      clearInterval(timerRef.current);
      streamerRef.current?.stop();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [id]);

  async function load() {
    try {
      const { data: conf }     = await conferencesApi.get(id!);
      const { data: joinData } = await conferencesApi.join(id!);
      setConference(conf);
      if (joinData.streamSettings) setStreamSettings(joinData.streamSettings);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Could not join conference');
    }
  }

  async function startStream() {
    setError('');
    try {
      // 1. Get camera + mic
      const stream = await getCameraStream(
        streamSettings.resolution,
        streamSettings.fps
      );
      streamRef.current = stream;

      // 2. Show preview in video element
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }

      // 3. Start WebSocket → FFmpeg → SRT
      const token = getToken()!;
      const streamer = new SrtStreamer({
        onReady: (sid) => {
          setStreamId(sid);
          setStreaming(true);
          let elapsed = 0;
          timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
        },
        onError: (msg) => {
          setError(msg);
          setStreaming(false);
          clearInterval(timerRef.current);
        },
        onStats: (bytes) => setBytesSent(bytes),
        onDisconnect: () => {
          setStreaming(false);
          clearInterval(timerRef.current);
        },
      });

      streamerRef.current = streamer;
      await streamer.start(token, id!, stream, streamSettings.bitrate);

    } catch (e: any) {
      if (e.name === 'NotAllowedError') {
        setError('Camera/microphone permission denied. Please allow access and try again.');
      } else {
        setError(e.message || 'Failed to start stream');
      }
    }
  }

  function stopStream() {
    streamerRef.current?.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    clearInterval(timerRef.current);
    setStreaming(false);
    setDuration(0);
    setBytesSent(0);
  }

  function leave() {
    stopStream();
    navigate('/conferences');
  }

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div style={styles.page}>
      {/* Camera preview */}
      <div style={styles.videoWrap}>
        <video ref={videoRef} muted playsInline style={styles.video} />

        {/* Live badge */}
        {streaming && (
          <div style={styles.liveBadge}>● LIVE</div>
        )}

        {/* HUD */}
        {streaming && (
          <div style={styles.hud}>
            <span>{fmt(duration)}</span>
            <span>{(bytesSent / 1e6).toFixed(1)} MB</span>
            <span>{streamSettings.bitrate} kbps</span>
            <span>{streamSettings.resolution}</span>
          </div>
        )}

        {/* Placeholder when not streaming */}
        {!streaming && (
          <div style={styles.placeholder}>
            <span style={{ fontSize: 48 }}>📹</span>
            <p style={{ color: '#666', marginTop: 8 }}>Camera preview will appear here</p>
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={styles.controls}>
        <div style={styles.confInfo}>
          <span style={styles.confTitle}>{conference?.title || 'Loading...'}</span>
          <span style={styles.confMeta}>
            {streamSettings.resolution} · {streamSettings.bitrate} kbps · {streamSettings.fps} fps
          </span>
        </div>

        {error && <div style={styles.errorBox}>{error}</div>}

        {!streaming ? (
          <button onClick={startStream} style={styles.liveBtn}>
            🔴 Go Live
          </button>
        ) : (
          <button onClick={stopStream} style={styles.stopBtn}>
            ⏹ Stop Streaming
          </button>
        )}

        <button onClick={leave} style={styles.leaveBtn}>
          Leave Conference
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page:        { minHeight: '100vh', background: '#000', display: 'flex',
                 flexDirection: 'column', color: '#fff' },
  videoWrap:   { position: 'relative', flex: 1, background: '#111',
                 display: 'flex', alignItems: 'center', justifyContent: 'center',
                 minHeight: '60vh' },
  video:       { width: '100%', height: '100%', objectFit: 'cover',
                 position: 'absolute', top: 0, left: 0 },
  liveBadge:   { position: 'absolute', top: 16, left: 16, background: '#E24B4A',
                 color: '#fff', padding: '4px 10px', borderRadius: 6,
                 fontSize: 12, fontWeight: 700, zIndex: 10 },
  hud:         { position: 'absolute', top: 16, right: 16, background: 'rgba(0,0,0,0.7)',
                 padding: '8px 12px', borderRadius: 8, zIndex: 10,
                 display: 'flex', flexDirection: 'column', gap: 4,
                 fontSize: 11, fontFamily: 'monospace' },
  placeholder: { display: 'flex', flexDirection: 'column', alignItems: 'center',
                 justifyContent: 'center', position: 'absolute' },
  controls:    { padding: 20, background: '#0a0a0a', borderTop: '1px solid #1a1a1a' },
  confInfo:    { marginBottom: 16 },
  confTitle:   { display: 'block', fontWeight: 600, fontSize: 16, marginBottom: 4 },
  confMeta:    { display: 'block', color: '#666', fontSize: 12 },
  errorBox:    { background: '#2a0000', border: '1px solid #E24B4A', borderRadius: 8,
                 padding: '10px 14px', color: '#E24B4A', fontSize: 13, marginBottom: 12 },
  liveBtn:     { width: '100%', padding: 14, background: '#E24B4A', color: '#fff',
                 border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 700,
                 cursor: 'pointer', marginBottom: 10 },
  stopBtn:     { width: '100%', padding: 14, background: '#333', color: '#fff',
                 border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 600,
                 cursor: 'pointer', marginBottom: 10 },
  leaveBtn:    { width: '100%', padding: 10, background: 'transparent', color: '#666',
                 border: '1px solid #333', borderRadius: 10, fontSize: 13, cursor: 'pointer' },
};
```

### `src/pages/AnchorConference.tsx`

```tsx
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  LiveKitRoom,
  VideoTile,
  useParticipants,
  useTracks,
  RoomAudioRenderer,
} from '@livekit/components-react';
import '@livekit/components-styles';
import { Track } from 'livekit-client';
import { conferencesApi } from '../api/client';

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || 'ws://localhost:7880';

export default function AnchorConference() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [token, setToken]           = useState('');
  const [conference, setConference] = useState<any>(null);
  const [error, setError]           = useState('');

  useEffect(() => {
    load();
  }, [id]);

  async function load() {
    try {
      const { data: conf }   = await conferencesApi.get(id!);
      await conferencesApi.join(id!);
      const { data: tkData } = await conferencesApi.getLiveKitToken(id!);
      setConference(conf);
      setToken(tkData.token);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Could not join conference');
    }
  }

  if (error) {
    return (
      <div style={styles.center}>
        <p style={{ color: '#E24B4A' }}>{error}</p>
        <button onClick={() => navigate('/conferences')} style={styles.backBtn}>
          Go Back
        </button>
      </div>
    );
  }

  if (!token) {
    return <div style={styles.center}><p style={{ color: '#888' }}>Connecting...</p></div>;
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <span style={styles.title}>{conference?.title}</span>
        <button onClick={() => navigate('/conferences')} style={styles.leaveBtn}>
          Leave
        </button>
      </div>

      {/* LiveKit room — anchor subscribes to all reporter tracks */}
      {/* Reporter video comes in via LiveKit Ingress (FFmpeg RTMP push) */}
      {/* Anchor publishes audio only — reporters hear anchor */}
      <LiveKitRoom
        serverUrl={LIVEKIT_URL}
        token={token}
        connect
        audio      // anchor publishes microphone
        video={false}  // anchor does not publish video
        style={{ flex: 1, background: '#0a0a0a' }}
      >
        <RoomAudioRenderer />
        <ReporterGrid />
      </LiveKitRoom>
    </div>
  );
}

// Shows all remote participant video tracks (reporter feeds via Ingress)
function ReporterGrid() {
  const tracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false }
  );

  if (tracks.length === 0) {
    return (
      <div style={styles.waiting}>
        <p>Waiting for reporters to go live...</p>
        <p style={{ color: '#555', fontSize: 12, marginTop: 8 }}>
          Reporter feeds will appear here when they start streaming
        </p>
      </div>
    );
  }

  return (
    <div style={{
      ...styles.grid,
      gridTemplateColumns: tracks.length === 1
        ? '1fr'
        : tracks.length <= 4
        ? 'repeat(2, 1fr)'
        : 'repeat(3, 1fr)',
    }}>
      {tracks.map(track => (
        <div key={track.participant.identity} style={styles.tile}>
          <VideoTile trackRef={track} style={{ width: '100%', height: '100%' }} />
          <div style={styles.tileLabel}>
            {track.participant.name || track.participant.identity}
          </div>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page:     { height: '100vh', display: 'flex', flexDirection: 'column',
              background: '#0a0a0a', color: '#fff' },
  header:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '12px 20px', borderBottom: '1px solid #1a1a1a', flexShrink: 0 },
  title:    { fontWeight: 600, fontSize: 16 },
  leaveBtn: { background: 'transparent', border: '1px solid #333', color: '#888',
              borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13 },
  grid:     { flex: 1, display: 'grid', gap: 4, padding: 8, overflow: 'hidden' },
  tile:     { position: 'relative', background: '#111', borderRadius: 8, overflow: 'hidden' },
  tileLabel:{ position: 'absolute', bottom: 8, left: 10, background: 'rgba(0,0,0,0.6)',
              padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 },
  center:   { height: '100vh', display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              background: '#0a0a0a', color: '#fff', gap: 16 },
  waiting:  { flex: 1, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', color: '#888' },
  backBtn:  { background: '#333', color: '#fff', border: 'none',
              borderRadius: 8, padding: '8px 16px', cursor: 'pointer' },
};
```

---

## Phase 4 — App Router

### `src/App.tsx`

```tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { isLoggedIn, getUser } from './lib/auth';
import Login from './pages/Login';
import Conferences from './pages/Conferences';
import ReporterConference from './pages/ReporterConference';
import AnchorConference from './pages/AnchorConference';

function RequireAuth({ children }: { children: JSX.Element }) {
  return isLoggedIn() ? children : <Navigate to="/login" replace />;
}

function RoleGuard({ role, children }: { role: string; children: JSX.Element }) {
  const user = getUser();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role && user.role !== 'ADMIN') {
    return <Navigate to="/conferences" replace />;
  }
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route path="/conferences" element={
          <RequireAuth><Conferences /></RequireAuth>
        } />

        <Route path="/reporter/:id" element={
          <RequireAuth>
            <RoleGuard role="REPORTER">
              <ReporterConference />
            </RoleGuard>
          </RequireAuth>
        } />

        <Route path="/anchor/:id" element={
          <RequireAuth>
            <RoleGuard role="ANCHOR">
              <AnchorConference />
            </RoleGuard>
          </RequireAuth>
        } />

        {/* Default redirect */}
        <Route path="/" element={
          isLoggedIn()
            ? <Navigate to="/conferences" replace />
            : <Navigate to="/login" replace />
        } />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
```

### `src/main.tsx`

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Global styles
const style = document.createElement('style');
style.textContent = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: #0a0a0a; color: #fff; }
  input, button, select { font-family: inherit; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: #111; }
  ::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
`;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

---

## Phase 5 — Android WebView App

Create a minimal Android app that loads the web client.

### `android-wrapper/app/src/main/AndroidManifest.xml`

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />

    <application
        android:allowBackup="true"
        android:label="FieldCast"
        android:theme="@style/Theme.AppCompat.NoActionBar"
        android:usesCleartextTraffic="true">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:configChanges="orientation|screenSize|keyboardHidden">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

    </application>
</manifest>
```

### `android-wrapper/app/src/main/java/com/fieldcast/MainActivity.kt`

```kotlin
package com.fieldcast

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.webkit.*
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val PERMISSION_REQUEST = 100

    // Update this URL for production
    private val APP_URL = "https://app.yourdomain.com"
    // For local dev testing:
    // private val APP_URL = "http://192.168.x.x:3001"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        // Request camera and mic permissions
        requestPermissions()

        setupWebView()
        webView.loadUrl(APP_URL)
    }

    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled          = true
            domStorageEnabled          = true   // localStorage for auth tokens
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess            = true
            allowContentAccess         = true
            useWideViewPort            = true
            loadWithOverviewMode       = true
            setSupportZoom(false)
        }

        // Allow camera and mic access from web app
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                request.grant(request.resources)
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: WebResourceError
            ) {
                // Show offline page if server unreachable
                if (request.isForMainFrame) {
                    view.loadData(
                        "<html><body style='background:#000;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif'>" +
                        "<div style='text-align:center'><h2 style='color:#E24B4A'>● FieldCast</h2>" +
                        "<p style='color:#666;margin-top:8px'>Could not connect to server.<br>Check your internet connection.</p></div></body></html>",
                        "text/html", "UTF-8"
                    )
                }
            }
        }
    }

    private fun requestPermissions() {
        val permissions = arrayOf(
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO,
        )
        val needed = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (needed.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), PERMISSION_REQUEST)
        }
    }

    // Handle back button — navigate back in WebView instead of closing app
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }
}
```

---

## Phase 6 — Add to Backend (serve web-client in production)

Add this to `backend/src/index.ts` so the backend serves the built web-client:

```typescript
import path from 'path';

// Serve built web-client
const webClientPath = path.join(__dirname, '../../web-client/dist');
app.use(express.static(webClientPath));

// SPA fallback — all non-API routes return index.html
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/hls')) {
    res.sendFile(path.join(webClientPath, 'index.html'));
  }
});
```

And add build step to `infra/docker-compose.yml` backend service.

---

## Phase 7 — Add to Nginx

```nginx
# Web client app — reporters and anchors use this
server {
    listen 443 ssl http2;
    server_name app.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/app.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://fieldcast_api;
        proxy_set_header Host $host;
    }

    location /stream {
        proxy_pass http://fieldcast_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
    }
}
```

---

## Critical Rules for Claude Code Agent

- `getUserMedia()` only works on HTTPS or localhost — never plain HTTP on a real domain
- WebSocket must use `wss://` in production (not `ws://`) when behind HTTPS
- Android WebView needs `android:usesCleartextTraffic="true"` only for local dev — remove for production
- `onPermissionRequest` in WebChromeClient must call `request.grant()` — without this camera never works in WebView
- LiveKit JS SDK (`livekit-client`) works perfectly in browser — no native modules needed
- `@livekit/components-react` provides ready-made `LiveKitRoom`, `VideoTile`, `useTracks` — use these instead of building from scratch
- The WebSocket URL must be proxied by Vite in dev — do not hardcode `localhost:3000` in the client code
- `localStorage` works fine for auth tokens in WebView — same as a normal browser
- Back button handling in `MainActivity.kt` is important — without it the back button closes the app instead of navigating

---

## Start Command After Building

```bash
# Dev
cd web-client && npm run dev
# Opens at http://localhost:3001

# Production build
cd web-client && npm run build
# Output in web-client/dist/ — served by backend Express static middleware
```
