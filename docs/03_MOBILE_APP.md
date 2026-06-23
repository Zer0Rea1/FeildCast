# Mobile App — React Native (Expo)

## Setup

```bash
cd mobile
npx create-expo-app . --template blank-typescript
npx expo install expo-camera expo-av expo-secure-store expo-notifications \
    expo-device expo-constants @react-native-async-storage/async-storage
npm install @livekit/react-native @livekit/react-native-webrtc \
    axios react-native-safe-area-context react-native-screens \
    @react-navigation/native @react-navigation/native-stack
npx expo install react-native-safe-area-context react-native-screens
```

### `app.json` — critical config
```json
{
  "expo": {
    "name": "FieldCast",
    "slug": "fieldcast",
    "version": "1.0.0",
    "platforms": ["android", "ios"],
    "android": {
      "package": "com.yournewschannel.fieldcast",
      "permissions": [
        "CAMERA",
        "RECORD_AUDIO",
        "INTERNET",
        "RECEIVE_BOOT_COMPLETED",
        "VIBRATE"
      ]
    },
    "plugins": [
      "expo-camera",
      "expo-notifications",
      [
        "@livekit/react-native",
        {
          "microphonePermission": "Allow FieldCast to access your microphone"
        }
      ]
    ]
  }
}
```

---

## API Client — `lib/api.ts`

```typescript
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

const BASE_URL = 'https://yourdomain.com/api'; // update for production

export const api = axios.create({ baseURL: BASE_URL });

// Attach JWT to every request
api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('auth_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auto logout on 401
api.interceptors.response.use(
  r => r,
  async err => {
    if (err.response?.status === 401) {
      await SecureStore.deleteItemAsync('auth_token');
    }
    return Promise.reject(err);
  }
);

// API methods
export const authApi = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  register: (name: string, email: string, password: string, role: string) =>
    api.post('/auth/register', { name, email, password, role }),
  savePushToken: (expoPushToken: string) =>
    api.patch('/auth/push-token', { expoPushToken }),
};

export const conferencesApi = {
  list: () => api.get('/conferences'),
  get: (id: string) => api.get(`/conferences/${id}`),
  create: (title: string, description?: string) =>
    api.post('/conferences', { title, description }),
  end: (id: string) => api.patch(`/conferences/${id}/end`),
  getLiveKitToken: (id: string) => api.post(`/conferences/${id}/livekit-token`),
  join: (id: string) => api.patch(`/conferences/${id}/participants/join`),
};

export const participantsApi = {
  add: (conferenceId: string, userId: string, role: string, settings?: any) =>
    api.post(`/conferences/${conferenceId}/participants`, { userId, role, ...settings }),
  remove: (conferenceId: string, userId: string) =>
    api.delete(`/conferences/${conferenceId}/participants/${userId}`),
};

export const usersApi = {
  list: () => api.get('/users'),
};
```

---

## Auth Storage — `lib/auth.ts`

```typescript
import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'REPORTER' | 'ANCHOR';
}

export async function saveAuth(token: string, user: AuthUser) {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
}

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function getUser(): Promise<AuthUser | null> {
  const raw = await SecureStore.getItemAsync(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function clearAuth() {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(USER_KEY);
}
```

---

## WebSocket Streaming — `lib/wsStream.ts`

```typescript
// Handles WebSocket connection + MediaRecorder for reporter SRT streaming
// This is the same pattern as LiveDesk, adapted for React Native

const WS_URL = 'wss://yourdomain.com/stream'; // update for production

export class SrtStreamer {
  private ws: WebSocket | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private bytesSent = 0;
  private onReady?: (streamId: string) => void;
  private onError?: (msg: string) => void;
  private onStats?: (bytes: number) => void;

  constructor(callbacks: {
    onReady?: (streamId: string) => void;
    onError?: (msg: string) => void;
    onStats?: (bytes: number) => void;
  }) {
    this.onReady = callbacks.onReady;
    this.onError = callbacks.onError;
    this.onStats = callbacks.onStats;
  }

  async start(token: string, conferenceId: string, stream: MediaStream, bitrate: number) {
    const wsUrl = `${WS_URL}?token=${encodeURIComponent(token)}&conferenceId=${conferenceId}`;
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'ready') {
          this.startRecording(stream, bitrate);
          this.onReady?.(msg.streamId);
        } else if (msg.type === 'error') {
          this.onError?.(msg.message);
          this.stop();
        }
      } catch {}
    };

    this.ws.onerror = () => {
      this.onError?.('Connection failed');
    };

    this.ws.onclose = () => {
      this.stopRecording();
    };
  }

  private startRecording(stream: MediaStream, bitrate: number) {
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm;codecs=vp8,opus';

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

    this.mediaRecorder.start(100); // 100ms chunks
  }

  private stopRecording() {
    if (this.mediaRecorder?.state !== 'inactive') {
      this.mediaRecorder?.stop();
    }
  }

  stop() {
    this.stopRecording();
    this.ws?.close();
    this.ws = null;
  }

  get isStreaming() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
```

---

## Login Screen — `app/(auth)/login.tsx`

```tsx
import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { authApi } from '../../lib/api';
import { saveAuth } from '../../lib/auth';
import { registerForPushNotifications } from '../../lib/notifications';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleLogin() {
    if (!email || !password) return Alert.alert('Error', 'Enter email and password');
    setLoading(true);
    try {
      const { data } = await authApi.login(email, password);
      await saveAuth(data.token, data.user);

      // Register device for push notifications after login
      const pushToken = await registerForPushNotifications();
      if (pushToken) await authApi.savePushToken(pushToken);

      // Route based on role
      if (data.user.role === 'ADMIN') router.replace('/(admin)/home');
      else if (data.user.role === 'ANCHOR') router.replace('/(anchor)/home');
      else router.replace('/(reporter)/home');
    } catch (e: any) {
      Alert.alert('Login failed', e.response?.data?.error || 'Check your credentials');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.logo}>● FieldCast</Text>
      <Text style={styles.sub}>News Channel Live Platform</Text>
      <TextInput style={styles.input} placeholder="Email" value={email}
        onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
      <TextInput style={styles.input} placeholder="Password" value={password}
        onChangeText={setPassword} secureTextEntry />
      <TouchableOpacity style={styles.btn} onPress={handleLogin} disabled={loading}>
        <Text style={styles.btnText}>{loading ? 'Logging in...' : 'Login'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#0a0a0a' },
  logo: { color: '#E24B4A', fontSize: 28, fontWeight: '700', marginBottom: 6 },
  sub: { color: '#666', fontSize: 14, marginBottom: 40 },
  input: { backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#333', borderRadius: 10,
    padding: 14, color: '#fff', fontSize: 15, marginBottom: 14 },
  btn: { backgroundColor: '#E24B4A', borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 8 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
```

---

## Push Notifications Helper — `lib/notifications.ts`

```typescript
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function registerForPushNotifications(): Promise<string | null> {
  if (!Device.isDevice) {
    console.log('[Push] Must use physical device for push notifications');
    return null;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.log('[Push] Permission not granted');
    return null;
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  console.log('[Push] Expo push token:', token);
  return token;
}

// Listen for incoming notifications when app is open (foreground)
// Returns unsubscribe function — call on unmount
export function listenForNotifications(
  onNotification: (data: any) => void
): () => void {
  const sub = Notifications.addNotificationReceivedListener(notification => {
    onNotification(notification.request.content.data);
  });
  return () => sub.remove();
}

// Listen for notification taps (app in background/closed)
export function listenForNotificationTaps(
  onTap: (data: any) => void
): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener(response => {
    onTap(response.notification.request.content.data);
  });
  return () => sub.remove();
}
```

---

## Reporter Home Screen — `app/(reporter)/home.tsx`

```tsx
import { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { conferencesApi } from '../../lib/api';
import { listenForNotifications } from '../../lib/notifications';

interface Conference {
  id: string;
  title: string;
  description?: string;
  status: 'PENDING' | 'LIVE' | 'ENDED';
}

export default function ReporterHome() {
  const [conferences, setConferences] = useState<Conference[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();

  async function load() {
    try {
      const { data } = await conferencesApi.list();
      setConferences(data);
    } catch {}
  }

  useEffect(() => {
    load();
    // Reload when push notification arrives (new conference added)
    const unsub = listenForNotifications(() => load());
    return unsub;
  }, []);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function renderItem({ item }: { item: Conference }) {
    const isLive = item.status === 'LIVE';
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.title}>{item.title}</Text>
          <View style={[styles.badge, isLive && styles.badgeLive]}>
            <Text style={styles.badgeText}>{isLive ? '● LIVE' : item.status}</Text>
          </View>
        </View>
        {item.description ? <Text style={styles.desc}>{item.description}</Text> : null}
        <TouchableOpacity
          style={styles.joinBtn}
          onPress={() => router.push(`/(reporter)/conference?id=${item.id}`)}
        >
          <Text style={styles.joinText}>Join Conference</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Your Conferences</Text>
      <FlatList
        data={conferences}
        keyExtractor={i => i.id}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        ListEmptyComponent={<Text style={styles.empty}>No conferences assigned yet</Text>}
        contentContainerStyle={{ paddingBottom: 40 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', padding: 16 },
  heading: { color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 16, marginTop: 8 },
  card: { backgroundColor: '#1a1a1a', borderRadius: 12, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: '#2a2a2a' },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  title: { color: '#fff', fontSize: 16, fontWeight: '600', flex: 1 },
  badge: { backgroundColor: '#333', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeLive: { backgroundColor: '#E24B4A' },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  desc: { color: '#888', fontSize: 13, marginBottom: 12 },
  joinBtn: { backgroundColor: '#E24B4A', borderRadius: 8, padding: 12, alignItems: 'center', marginTop: 8 },
  joinText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  empty: { color: '#555', textAlign: 'center', marginTop: 60, fontSize: 14 },
});
```

---

## Reporter Conference Screen — `app/(reporter)/conference.tsx`

```tsx
import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Camera, CameraType } from 'expo-camera';
import { conferencesApi } from '../../lib/api';
import { getToken } from '../../lib/auth';
import { SrtStreamer } from '../../lib/wsStream';

export default function ReporterConference() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [hasPermission, setHasPermission] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamId, setStreamId] = useState('');
  const [bytesSent, setBytesSent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [conference, setConference] = useState<any>(null);
  const [streamSettings, setStreamSettings] = useState({ resolution: '1280x720', bitrate: 2500, fps: 25 });
  const cameraRef = useRef<Camera>(null);
  const streamerRef = useRef<SrtStreamer | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      await Camera.requestMicrophonePermissionsAsync();
      setHasPermission(status === 'granted');
      await loadConference();
    })();
    return () => {
      clearInterval(timerRef.current);
      streamerRef.current?.stop();
    };
  }, []);

  async function loadConference() {
    try {
      const { data: conf } = await conferencesApi.get(id);
      setConference(conf);
      // Join conference — gets stream settings
      const { data: joinData } = await conferencesApi.join(id);
      if (joinData.streamSettings) setStreamSettings(joinData.streamSettings);
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.error || 'Could not load conference');
      router.back();
    }
  }

  async function startStream() {
    const token = await getToken();
    if (!token || !cameraRef.current) return;

    // Get camera MediaStream
    const stream = await (cameraRef.current as any).getAvailableCameraTypesAsync?.();

    const streamer = new SrtStreamer({
      onReady: (sid) => {
        setStreamId(sid);
        setStreaming(true);
        let elapsed = 0;
        timerRef.current = setInterval(() => setDuration(++elapsed), 1000);
      },
      onError: (msg) => {
        Alert.alert('Stream error', msg);
        setStreaming(false);
      },
      onStats: (bytes) => setBytesSent(bytes),
    });

    streamerRef.current = streamer;

    // Note: In React Native, use react-native-webrtc's getUserMedia
    // import { mediaDevices } from 'react-native-webrtc';
    // const stream = await mediaDevices.getUserMedia({ video: true, audio: true });
    // await streamer.start(token, id, stream, streamSettings.bitrate);
  }

  function stopStream() {
    streamerRef.current?.stop();
    clearInterval(timerRef.current);
    setStreaming(false);
    setDuration(0);
  }

  const fmt = (s: number) => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;

  return (
    <View style={styles.container}>
      <Camera style={styles.camera} type={CameraType.back} ref={cameraRef}>
        {streaming && (
          <>
            <View style={styles.liveBadge}><Text style={styles.liveText}>● LIVE</Text></View>
            <View style={styles.hud}>
              <Text style={styles.hudText}>{fmt(duration)}</Text>
              <Text style={styles.hudText}>{(bytesSent/1e6).toFixed(1)} MB</Text>
              <Text style={styles.hudText}>{streamSettings.bitrate} kbps</Text>
            </View>
          </>
        )}
      </Camera>
      <View style={styles.controls}>
        <Text style={styles.confTitle}>{conference?.title}</Text>
        <TouchableOpacity
          style={[styles.streamBtn, streaming && styles.stopBtn]}
          onPress={streaming ? stopStream : startStream}
        >
          <Text style={styles.streamBtnText}>{streaming ? 'Stop Streaming' : 'Go Live'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.backBtn} onPress={() => { stopStream(); router.back(); }}>
          <Text style={styles.backText}>Leave Conference</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  liveBadge: { position: 'absolute', top: 16, left: 16, backgroundColor: '#E24B4A',
    borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  liveText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  hud: { position: 'absolute', top: 16, right: 16, backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 6, padding: 8, gap: 2 },
  hudText: { color: '#fff', fontSize: 10, fontFamily: 'monospace' },
  controls: { backgroundColor: '#0a0a0a', padding: 20 },
  confTitle: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 16 },
  streamBtn: { backgroundColor: '#E24B4A', borderRadius: 10, padding: 14, alignItems: 'center', marginBottom: 10 },
  stopBtn: { backgroundColor: '#333' },
  streamBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  backBtn: { alignItems: 'center', padding: 10 },
  backText: { color: '#666', fontSize: 13 },
});
```
