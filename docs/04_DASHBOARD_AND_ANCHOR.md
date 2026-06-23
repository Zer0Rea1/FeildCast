# Admin Dashboard (Web) + Anchor Screen (Mobile)

## Admin Dashboard Setup

```bash
cd dashboard
npm create vite@latest . -- --template react-ts
npm install axios react-router-dom @tanstack/react-query hls.js date-fns
```

### `vite.config.ts`
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000', '/hls': 'http://localhost:3000' },
  },
});
```

---

## API Client — `src/api/client.ts`

```typescript
import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use(config => {
  const token = localStorage.getItem('admin_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(r => r, err => {
  if (err.response?.status === 401) {
    localStorage.removeItem('admin_token');
    window.location.href = '/login';
  }
  return Promise.reject(err);
});

export default api;

export const authApi = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
};

export const conferencesApi = {
  list: () => api.get('/conferences'),
  get: (id: string) => api.get(`/conferences/${id}`),
  create: (title: string, description?: string) =>
    api.post('/conferences', { title, description }),
  end: (id: string) => api.patch(`/conferences/${id}/end`),
};

export const participantsApi = {
  add: (conferenceId: string, userId: string, role: string, settings?: object) =>
    api.post(`/conferences/${conferenceId}/participants`, { userId, role, ...settings }),
  remove: (conferenceId: string, userId: string) =>
    api.delete(`/conferences/${conferenceId}/participants/${userId}`),
};

export const usersApi = {
  list: () => api.get('/users'),
};
```

---

## HLS Player Component — `src/components/HLSPlayer.tsx`

```tsx
import { useEffect, useRef } from 'react';
import Hls from 'hls.js';

interface Props {
  src: string;           // e.g. /hls/fc-abc123-ahmed-a1b2c3/index.m3u8
  reporterName: string;
  bitrate?: number;
}

export default function HLSPlayer({ src, reporterName, bitrate }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: true,
        backBufferLength: 10,
      });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          // Retry after 3 seconds if stream not ready yet
          setTimeout(() => hls.loadSource(src), 3000);
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = src;
      video.play().catch(() => {});
    }

    return () => {
      hlsRef.current?.destroy();
    };
  }, [src]);

  return (
    <div style={{ position: 'relative', background: '#111', borderRadius: 10, overflow: 'hidden' }}>
      <video
        ref={videoRef}
        muted
        style={{ width: '100%', aspectRatio: '16/9', display: 'block' }}
      />
      {/* Overlay with reporter info */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        background: 'linear-gradient(transparent, rgba(0,0,0,0.8))',
        padding: '20px 12px 10px', display: 'flex', justifyContent: 'space-between',
        alignItems: 'flex-end',
      }}>
        <span style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>{reporterName}</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={{
            background: '#E24B4A', color: '#fff', fontSize: 10, fontWeight: 700,
            padding: '2px 8px', borderRadius: 4,
          }}>● LIVE</div>
          {bitrate && (
            <span style={{ color: '#aaa', fontSize: 10 }}>{bitrate} kbps</span>
          )}
        </div>
      </div>
    </div>
  );
}
```

---

## Dashboard Page — `src/pages/Dashboard.tsx`

```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { conferencesApi, participantsApi } from '../api/client';
import HLSPlayer from '../components/HLSPlayer';

interface Participant {
  id: string;
  role: string;
  status: string;
  streamId: string | null;
  bitrate: number | null;
  user: { id: string; name: string };
}

interface Conference {
  id: string;
  title: string;
  status: 'PENDING' | 'LIVE' | 'ENDED';
  participants: Participant[];
}

export default function Dashboard() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: conferences = [] } = useQuery<Conference[]>({
    queryKey: ['conferences'],
    queryFn: () => conferencesApi.list().then(r => r.data),
    refetchInterval: 5000, // poll every 5 seconds
  });

  const endConference = useMutation({
    mutationFn: (id: string) => conferencesApi.end(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conferences'] }),
  });

  const liveConferences = conferences.filter(c => c.status === 'LIVE');
  const pendingConferences = conferences.filter(c => c.status === 'PENDING');

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Live Dashboard</h1>
        <button
          onClick={() => navigate('/create')}
          style={{ background: '#E24B4A', color: '#fff', border: 'none', borderRadius: 8,
            padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          New Conference
        </button>
      </div>

      {/* Live conferences — show HLS tiles */}
      {liveConferences.length > 0 && (
        <section style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 13, color: '#888', textTransform: 'uppercase',
            letterSpacing: '0.08em', marginBottom: 14 }}>Live Now</h2>
          {liveConferences.map(conf => (
            <div key={conf.id} style={{ background: '#1a1a1a', borderRadius: 12,
              border: '1px solid #2a2a2a', padding: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', marginBottom: 14 }}>
                <div>
                  <span style={{ color: '#E24B4A', fontWeight: 700, marginRight: 8 }}>● LIVE</span>
                  <span style={{ fontWeight: 600 }}>{conf.title}</span>
                </div>
                <button
                  onClick={() => endConference.mutate(conf.id)}
                  style={{ background: 'transparent', border: '1px solid #E24B4A',
                    color: '#E24B4A', borderRadius: 6, padding: '5px 12px',
                    fontSize: 12, cursor: 'pointer' }}
                >
                  End Conference
                </button>
              </div>

              {/* Reporter HLS video tiles */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                {conf.participants
                  .filter(p => p.role === 'REPORTER' && p.streamId && p.status === 'JOINED')
                  .map(p => (
                    <HLSPlayer
                      key={p.id}
                      src={`/hls/${p.streamId}/index.m3u8`}
                      reporterName={p.user.name}
                      bitrate={p.bitrate || undefined}
                    />
                  ))}
                {conf.participants.filter(p => p.role === 'REPORTER' && p.status === 'JOINED').length === 0 && (
                  <p style={{ color: '#555', fontSize: 13 }}>Waiting for reporters to join...</p>
                )}
              </div>

              {/* Participant list */}
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                {conf.participants.map(p => (
                  <div key={p.id} style={{
                    background: p.status === 'JOINED' ? '#1D9E7520' : '#33333340',
                    border: `1px solid ${p.status === 'JOINED' ? '#1D9E75' : '#444'}`,
                    borderRadius: 6, padding: '4px 10px', fontSize: 11,
                  }}>
                    <span style={{ color: p.status === 'JOINED' ? '#1D9E75' : '#666' }}>
                      {p.role === 'ANCHOR' ? '🎤' : '📹'} {p.user.name}
                      {p.status === 'JOINED' ? ' ●' : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Pending conferences */}
      {pendingConferences.length > 0 && (
        <section>
          <h2 style={{ fontSize: 13, color: '#888', textTransform: 'uppercase',
            letterSpacing: '0.08em', marginBottom: 14 }}>Scheduled</h2>
          {pendingConferences.map(conf => (
            <div key={conf.id} style={{ background: '#1a1a1a', borderRadius: 12,
              border: '1px solid #2a2a2a', padding: 16, marginBottom: 10,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{conf.title}</div>
                <div style={{ fontSize: 12, color: '#666' }}>
                  {conf.participants.length} participant{conf.participants.length !== 1 ? 's' : ''} assigned
                </div>
              </div>
              <button
                onClick={() => navigate(`/conference/${conf.id}`)}
                style={{ background: 'transparent', border: '1px solid #444',
                  color: '#aaa', borderRadius: 6, padding: '6px 12px',
                  fontSize: 12, cursor: 'pointer' }}
              >
                Manage
              </button>
            </div>
          ))}
        </section>
      )}

      {conferences.length === 0 && (
        <div style={{ textAlign: 'center', color: '#555', marginTop: 80 }}>
          No conferences yet. Create one to get started.
        </div>
      )}
    </div>
  );
}
```

---

## Create Conference Page — `src/pages/CreateConference.tsx`

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { conferencesApi, participantsApi, usersApi } from '../api/client';

const QUALITY_PRESETS = [
  { label: 'Studio HD', resolution: '1920x1080', bitrate: 6000, fps: 30 },
  { label: 'Field 720p', resolution: '1280x720',  bitrate: 2500, fps: 25 },
  { label: 'Remote 480p', resolution: '854x480',  bitrate: 800,  fps: 20 },
  { label: 'Emergency 360p', resolution: '640x360', bitrate: 400, fps: 15 },
];

export default function CreateConference() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<{ userId: string; role: string; preset: number }[]>([]);

  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list().then(r => r.data),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      // 1. Create conference
      const { data: conf } = await conferencesApi.create(title, description);
      // 2. Add each selected participant — server sends push notification automatically
      for (const s of selected) {
        const preset = QUALITY_PRESETS[s.preset];
        await participantsApi.add(conf.id, s.userId, s.role,
          s.role === 'REPORTER' ? preset : undefined);
      }
      return conf;
    },
    onSuccess: (conf) => {
      qc.invalidateQueries({ queryKey: ['conferences'] });
      navigate(`/conference/${conf.id}`);
    },
  });

  function toggleUser(userId: string, role: string) {
    setSelected(prev => {
      const exists = prev.find(s => s.userId === userId);
      if (exists) return prev.filter(s => s.userId !== userId);
      return [...prev, { userId, role, preset: 1 }]; // default Field 720p
    });
  }

  function setPreset(userId: string, preset: number) {
    setSelected(prev => prev.map(s => s.userId === userId ? { ...s, preset } : s));
  }

  return (
    <div style={{ maxWidth: 640, padding: 24 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>New Conference</h1>

      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Conference Title</label>
        <input value={title} onChange={e => setTitle(e.target.value)}
          placeholder="e.g. Live from Islamabad — Budget 2025"
          style={inputStyle} />
      </div>
      <div style={{ marginBottom: 24 }}>
        <label style={labelStyle}>Description (optional)</label>
        <input value={description} onChange={e => setDescription(e.target.value)}
          placeholder="Brief description"
          style={inputStyle} />
      </div>

      <label style={labelStyle}>Select Participants</label>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
        Each selected user will receive a push notification immediately.
      </p>

      <div style={{ marginBottom: 24 }}>
        {users.map((user: any) => {
          const sel = selected.find(s => s.userId === user.id);
          return (
            <div key={user.id} style={{ background: sel ? '#1D9E7515' : '#1a1a1a',
              border: `1px solid ${sel ? '#1D9E75' : '#2a2a2a'}`, borderRadius: 10,
              padding: 14, marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="checkbox" checked={!!sel}
                  onChange={() => toggleUser(user.id, user.role)}
                  style={{ width: 16, height: 16, accentColor: '#1D9E75' }} />
                <div>
                  <div style={{ fontWeight: 500 }}>{user.name}</div>
                  <div style={{ fontSize: 11, color: '#666' }}>{user.email} · {user.role}</div>
                </div>
                {sel && (
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                    {/* Role selector */}
                    <select value={sel.role}
                      onChange={e => setSelected(prev => prev.map(s =>
                        s.userId === user.id ? { ...s, role: e.target.value } : s))}
                      style={{ ...inputStyle, padding: '4px 8px', fontSize: 11 }}>
                      <option value="REPORTER">Reporter</option>
                      <option value="ANCHOR">Anchor</option>
                    </select>
                    {/* Quality preset — only for reporters */}
                    {sel.role === 'REPORTER' && (
                      <select value={sel.preset}
                        onChange={e => setPreset(user.id, parseInt(e.target.value))}
                        style={{ ...inputStyle, padding: '4px 8px', fontSize: 11 }}>
                        {QUALITY_PRESETS.map((p, i) => (
                          <option key={i} value={i}>{p.label}</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <button
        onClick={() => createMutation.mutate()}
        disabled={!title || selected.length === 0 || createMutation.isPending}
        style={{ background: '#E24B4A', color: '#fff', border: 'none', borderRadius: 10,
          padding: '12px 24px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
          opacity: (!title || selected.length === 0) ? 0.5 : 1 }}
      >
        {createMutation.isPending ? 'Creating...' : `Create & Notify ${selected.length} Participant${selected.length !== 1 ? 's' : ''}`}
      </button>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 11, color: '#888', marginBottom: 6,
  textTransform: 'uppercase', letterSpacing: '0.06em',
};

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1a1a1a', border: '1px solid #333',
  borderRadius: 8, padding: '10px 12px', color: '#fff', fontSize: 13,
};
```

---

## Anchor Conference Screen — `app/(anchor)/conference.tsx`

```tsx
import { useEffect, useState } from 'react';
import { View, StyleSheet, Text, TouchableOpacity, Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRoom, RoomProvider, VideoTrack, AudioTrack } from '@livekit/react-native';
import { conferencesApi } from '../../lib/api';

// Anchor screen — joins LiveKit room and sees all reporter video tiles
// Anchor can talk to all reporters via WebRTC audio
export default function AnchorConference() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [liveKitToken, setLiveKitToken] = useState('');
  const [liveKitUrl, setLiveKitUrl] = useState('');
  const [conference, setConference] = useState<any>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      const { data: conf } = await conferencesApi.get(id);
      setConference(conf);

      // Join the conference (marks anchor as joined in DB)
      await conferencesApi.join(id);

      // Get LiveKit token for WebRTC room
      const { data: tkData } = await conferencesApi.getLiveKitToken(id);
      setLiveKitToken(tkData.token);
      setLiveKitUrl(process.env.EXPO_PUBLIC_LIVEKIT_URL || 'wss://yourdomain.com');
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.error || 'Could not join conference');
      router.back();
    }
  }

  if (!liveKitToken) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>Connecting to conference...</Text>
      </View>
    );
  }

  return (
    <RoomProvider url={liveKitUrl} token={liveKitToken} connect>
      <AnchorView conference={conference} onLeave={() => router.back()} />
    </RoomProvider>
  );
}

function AnchorView({ conference, onLeave }: { conference: any; onLeave: () => void }) {
  const room = useRoom();
  const participants = Array.from(room.remoteParticipants.values());

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{conference?.title}</Text>
        <TouchableOpacity onPress={onLeave} style={styles.leaveBtn}>
          <Text style={styles.leaveBtnText}>Leave</Text>
        </TouchableOpacity>
      </View>

      {/* Reporter video grid */}
      <View style={styles.grid}>
        {participants.length === 0 ? (
          <Text style={styles.waiting}>Waiting for reporters to join...</Text>
        ) : (
          participants.map(participant => {
            const videoTrack = Array.from(participant.videoTrackPublications.values())[0]?.track;
            const audioTrack = Array.from(participant.audioTrackPublications.values())[0]?.track;
            return (
              <View key={participant.identity} style={styles.tile}>
                {videoTrack && <VideoTrack trackPublication={Array.from(participant.videoTrackPublications.values())[0]} style={styles.video} />}
                {audioTrack && <AudioTrack trackPublication={Array.from(participant.audioTrackPublications.values())[0]} />}
                <View style={styles.tileLabel}>
                  <Text style={styles.tileLabelText}>{participant.name}</Text>
                </View>
              </View>
            );
          })
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0a0a0a' },
  loadingText: { color: '#888', fontSize: 14 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 16, paddingTop: 48 },
  title: { color: '#fff', fontSize: 16, fontWeight: '600', flex: 1 },
  leaveBtn: { backgroundColor: '#333', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  leaveBtnText: { color: '#fff', fontSize: 13 },
  grid: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', padding: 8 },
  tile: { width: '50%', aspectRatio: 16/9, padding: 4, position: 'relative' },
  video: { width: '100%', height: '100%', borderRadius: 8, backgroundColor: '#1a1a1a' },
  tileLabel: { position: 'absolute', bottom: 8, left: 8, backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
  tileLabelText: { color: '#fff', fontSize: 10, fontWeight: '600' },
  waiting: { color: '#555', fontSize: 14, textAlign: 'center', marginTop: 60, width: '100%' },
});
```
