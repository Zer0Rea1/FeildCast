# Completing Missing Pieces

## Mobile App — Root Layout & Router — `mobile/app/_layout.tsx`

```tsx
import { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { getUser } from '../lib/auth';
import { listenForNotificationTaps } from '../lib/notifications';

export default function RootLayout() {
  const router   = useRouter();
  const segments = useSegments();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    (async () => {
      const user = await getUser();
      if (!user) {
        router.replace('/(auth)/login');
      } else if (user.role === 'ADMIN') {
        router.replace('/(admin)/home');
      } else if (user.role === 'ANCHOR') {
        router.replace('/(anchor)/home');
      } else {
        router.replace('/(reporter)/home');
      }
      setChecked(true);
    })();

    // Handle notification taps — navigate to conference
    const unsub = listenForNotificationTaps((data) => {
      if (data?.conferenceId) {
        const user = getUser();
        user.then(u => {
          if (!u) return;
          if (u.role === 'REPORTER') router.push(`/(reporter)/conference?id=${data.conferenceId}`);
          else if (u.role === 'ANCHOR') router.push(`/(anchor)/conference?id=${data.conferenceId}`);
        });
      }
    });
    return unsub;
  }, []);

  if (!checked) return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)/login" />
      <Stack.Screen name="(reporter)/home" />
      <Stack.Screen name="(reporter)/conference" />
      <Stack.Screen name="(anchor)/home" />
      <Stack.Screen name="(anchor)/conference" />
      <Stack.Screen name="(admin)/home" />
      <Stack.Screen name="(admin)/create" />
    </Stack>
  );
}
```

---

## Mobile App — Anchor Home — `mobile/app/(anchor)/home.tsx`

```tsx
import { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { conferencesApi } from '../../lib/api';
import { clearAuth } from '../../lib/auth';
import { listenForNotifications } from '../../lib/notifications';

interface Conference {
  id: string;
  title: string;
  description?: string;
  status: 'PENDING' | 'LIVE' | 'ENDED';
  participants: any[];
}

export default function AnchorHome() {
  const [conferences, setConferences] = useState<Conference[]>([]);
  const [refreshing, setRefreshing]   = useState(false);
  const router = useRouter();

  async function load() {
    try {
      const { data } = await conferencesApi.list();
      setConferences(data);
    } catch {}
  }

  useEffect(() => {
    load();
    const unsub = listenForNotifications(() => load());
    return unsub;
  }, []);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function logout() {
    await clearAuth();
    router.replace('/(auth)/login');
  }

  function renderItem({ item }: { item: Conference }) {
    const reporters = item.participants.filter(p => p.role === 'REPORTER').length;
    const isLive    = item.status === 'LIVE';
    return (
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.title}>{item.title}</Text>
          <View style={[styles.badge, isLive && styles.badgeLive]}>
            <Text style={styles.badgeText}>{isLive ? '● LIVE' : item.status}</Text>
          </View>
        </View>
        <Text style={styles.meta}>{reporters} reporter{reporters !== 1 ? 's' : ''}</Text>
        <TouchableOpacity
          style={styles.joinBtn}
          onPress={() => router.push(`/(anchor)/conference?id=${item.id}`)}
        >
          <Text style={styles.joinText}>Join as Anchor</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.heading}>Anchor</Text>
        <TouchableOpacity onPress={logout}>
          <Text style={styles.logout}>Logout</Text>
        </TouchableOpacity>
      </View>
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
  header:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
               marginBottom: 20, marginTop: 8 },
  heading:   { color: '#fff', fontSize: 20, fontWeight: '700' },
  logout:    { color: '#666', fontSize: 13 },
  card:      { backgroundColor: '#1a1a1a', borderRadius: 12, padding: 16, marginBottom: 12,
               borderWidth: 1, borderColor: '#2a2a2a' },
  row:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  title:     { color: '#fff', fontSize: 16, fontWeight: '600', flex: 1 },
  badge:     { backgroundColor: '#333', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeLive: { backgroundColor: '#E24B4A' },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  meta:      { color: '#666', fontSize: 12, marginBottom: 12 },
  joinBtn:   { backgroundColor: '#1D9E75', borderRadius: 8, padding: 12, alignItems: 'center' },
  joinText:  { color: '#fff', fontSize: 14, fontWeight: '600' },
  empty:     { color: '#555', textAlign: 'center', marginTop: 60, fontSize: 14 },
});
```

---

## Mobile App — Admin Home — `mobile/app/(admin)/home.tsx`

```tsx
import { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { conferencesApi } from '../../lib/api';
import { clearAuth } from '../../lib/auth';

interface Conference {
  id: string;
  title: string;
  status: 'PENDING' | 'LIVE' | 'ENDED';
  participants: any[];
}

export default function AdminHome() {
  const [conferences, setConferences] = useState<Conference[]>([]);
  const [refreshing, setRefreshing]   = useState(false);
  const router = useRouter();

  async function load() {
    try {
      const { data } = await conferencesApi.list();
      setConferences(data);
    } catch {}
  }

  useEffect(() => { load(); }, []);

  async function endConference(id: string) {
    Alert.alert('End Conference', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End', style: 'destructive',
        onPress: async () => {
          await conferencesApi.end(id);
          load();
        },
      },
    ]);
  }

  async function logout() {
    await clearAuth();
    router.replace('/(auth)/login');
  }

  function renderItem({ item }: { item: Conference }) {
    const isLive = item.status === 'LIVE';
    return (
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.title}>{item.title}</Text>
          <View style={[styles.badge, isLive && styles.badgeLive]}>
            <Text style={styles.badgeText}>{isLive ? '● LIVE' : item.status}</Text>
          </View>
        </View>
        <Text style={styles.meta}>{item.participants.length} participants</Text>
        <View style={styles.actions}>
          {isLive && (
            <TouchableOpacity style={styles.endBtn} onPress={() => endConference(item.id)}>
              <Text style={styles.endText}>End</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.heading}>Admin</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.createBtn}
            onPress={() => router.push('/(admin)/create')}
          >
            <Text style={styles.createText}>+ New</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={logout} style={{ marginLeft: 12 }}>
            <Text style={styles.logout}>Logout</Text>
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={conferences}
        keyExtractor={i => i.id}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load().finally(() => setRefreshing(false)); }} />}
        ListEmptyComponent={<Text style={styles.empty}>No conferences yet. Create one.</Text>}
        contentContainerStyle={{ paddingBottom: 40 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container:     { flex: 1, backgroundColor: '#0a0a0a', padding: 16 },
  header:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                   marginBottom: 20, marginTop: 8 },
  heading:       { color: '#fff', fontSize: 20, fontWeight: '700' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  createBtn:     { backgroundColor: '#E24B4A', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  createText:    { color: '#fff', fontSize: 13, fontWeight: '600' },
  logout:        { color: '#666', fontSize: 13 },
  card:          { backgroundColor: '#1a1a1a', borderRadius: 12, padding: 16, marginBottom: 12,
                   borderWidth: 1, borderColor: '#2a2a2a' },
  row:           { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  title:         { color: '#fff', fontSize: 15, fontWeight: '600', flex: 1 },
  badge:         { backgroundColor: '#333', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeLive:     { backgroundColor: '#E24B4A' },
  badgeText:     { color: '#fff', fontSize: 10, fontWeight: '700' },
  meta:          { color: '#666', fontSize: 12, marginBottom: 10 },
  actions:       { flexDirection: 'row', gap: 8 },
  endBtn:        { borderWidth: 1, borderColor: '#E24B4A', borderRadius: 6,
                   paddingHorizontal: 14, paddingVertical: 6 },
  endText:       { color: '#E24B4A', fontSize: 12, fontWeight: '600' },
  empty:         { color: '#555', textAlign: 'center', marginTop: 60, fontSize: 14 },
});
```

---

## Mobile App — Admin Create Conference — `mobile/app/(admin)/create.tsx`

```tsx
import { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet,
         ScrollView, Alert, Switch } from 'react-native';
import { useRouter } from 'expo-router';
import { conferencesApi, participantsApi, usersApi } from '../../lib/api';

const PRESETS = [
  { label: 'Studio HD',     resolution: '1920x1080', bitrate: 6000, fps: 30 },
  { label: 'Field 720p',    resolution: '1280x720',  bitrate: 2500, fps: 25 },
  { label: 'Remote 480p',   resolution: '854x480',   bitrate: 800,  fps: 20 },
  { label: 'Emergency 360p',resolution: '640x360',   bitrate: 400,  fps: 15 },
];

interface SelectedUser {
  userId: string;
  name: string;
  role: 'REPORTER' | 'ANCHOR';
  preset: number;
}

export default function AdminCreate() {
  const router = useRouter();
  const [title, setTitle]           = useState('');
  const [description, setDesc]      = useState('');
  const [users, setUsers]           = useState<any[]>([]);
  const [selected, setSelected]     = useState<SelectedUser[]>([]);
  const [loading, setLoading]       = useState(false);

  useEffect(() => {
    usersApi.list().then(r => setUsers(r.data)).catch(() => {});
  }, []);

  function toggleUser(user: any) {
    setSelected(prev => {
      const exists = prev.find(s => s.userId === user.id);
      if (exists) return prev.filter(s => s.userId !== user.id);
      return [...prev, { userId: user.id, name: user.name, role: 'REPORTER', preset: 1 }];
    });
  }

  function setRole(userId: string, role: 'REPORTER' | 'ANCHOR') {
    setSelected(prev => prev.map(s => s.userId === userId ? { ...s, role } : s));
  }

  function setPreset(userId: string, preset: number) {
    setSelected(prev => prev.map(s => s.userId === userId ? { ...s, preset } : s));
  }

  async function handleCreate() {
    if (!title.trim()) return Alert.alert('Error', 'Conference title is required');
    if (selected.length === 0) return Alert.alert('Error', 'Add at least one participant');
    setLoading(true);
    try {
      const { data: conf } = await conferencesApi.create(title, description);
      for (const s of selected) {
        const p = PRESETS[s.preset];
        await participantsApi.add(
          conf.id, s.userId, s.role,
          s.role === 'REPORTER' ? p : undefined
        );
      }
      Alert.alert('Created', `${selected.length} participants notified`, [
        { text: 'OK', onPress: () => router.back() }
      ]);
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.error || 'Failed to create');
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 60 }}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.back}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.heading}>New Conference</Text>
      </View>

      <Text style={styles.label}>Title</Text>
      <TextInput
        style={styles.input} value={title} onChangeText={setTitle}
        placeholder="e.g. Budget 2025 Live Coverage"
        placeholderTextColor="#555"
      />

      <Text style={styles.label}>Description (optional)</Text>
      <TextInput
        style={styles.input} value={description} onChangeText={setDesc}
        placeholder="Brief description" placeholderTextColor="#555"
      />

      <Text style={styles.label}>Select Participants</Text>
      <Text style={styles.sublabel}>Each person gets a push notification immediately</Text>

      {users.map(user => {
        const sel = selected.find(s => s.userId === user.id);
        return (
          <View key={user.id} style={[styles.userCard, !!sel && styles.userCardSelected]}>
            <View style={styles.userRow}>
              <Switch
                value={!!sel}
                onValueChange={() => toggleUser(user)}
                trackColor={{ true: '#1D9E75' }}
                thumbColor="#fff"
              />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={styles.userName}>{user.name}</Text>
                <Text style={styles.userEmail}>{user.email}</Text>
              </View>
            </View>

            {sel && (
              <View style={styles.userSettings}>
                {/* Role toggle */}
                <View style={styles.roleRow}>
                  {(['REPORTER', 'ANCHOR'] as const).map(r => (
                    <TouchableOpacity
                      key={r}
                      style={[styles.roleBtn, sel.role === r && styles.roleBtnActive]}
                      onPress={() => setRole(user.id, r)}
                    >
                      <Text style={[styles.roleBtnText, sel.role === r && styles.roleBtnTextActive]}>
                        {r === 'REPORTER' ? '📹 Reporter' : '🎤 Anchor'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Quality preset — reporters only */}
                {sel.role === 'REPORTER' && (
                  <View style={styles.presetRow}>
                    {PRESETS.map((p, i) => (
                      <TouchableOpacity
                        key={i}
                        style={[styles.presetBtn, sel.preset === i && styles.presetBtnActive]}
                        onPress={() => setPreset(user.id, i)}
                      >
                        <Text style={[styles.presetText, sel.preset === i && styles.presetTextActive]}>
                          {p.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            )}
          </View>
        );
      })}

      <TouchableOpacity
        style={[styles.createBtn, (loading || !title || selected.length === 0) && styles.createBtnDisabled]}
        onPress={handleCreate}
        disabled={loading || !title || selected.length === 0}
      >
        <Text style={styles.createText}>
          {loading ? 'Creating...' : `Create & Notify ${selected.length} Participant${selected.length !== 1 ? 's' : ''}`}
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container:          { flex: 1, backgroundColor: '#0a0a0a', padding: 16 },
  header:             { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 24, marginTop: 8 },
  back:               { color: '#888', fontSize: 14 },
  heading:            { color: '#fff', fontSize: 18, fontWeight: '700' },
  label:              { color: '#888', fontSize: 11, textTransform: 'uppercase',
                        letterSpacing: 0.8, marginBottom: 6, marginTop: 16 },
  sublabel:           { color: '#555', fontSize: 12, marginBottom: 10 },
  input:              { backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#333',
                        borderRadius: 10, padding: 12, color: '#fff', fontSize: 14 },
  userCard:           { backgroundColor: '#1a1a1a', borderRadius: 12, padding: 14,
                        marginBottom: 8, borderWidth: 1, borderColor: '#2a2a2a' },
  userCardSelected:   { borderColor: '#1D9E75' },
  userRow:            { flexDirection: 'row', alignItems: 'center' },
  userName:           { color: '#fff', fontSize: 14, fontWeight: '500' },
  userEmail:          { color: '#666', fontSize: 12 },
  userSettings:       { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#2a2a2a' },
  roleRow:            { flexDirection: 'row', gap: 8, marginBottom: 10 },
  roleBtn:            { flex: 1, borderWidth: 1, borderColor: '#333', borderRadius: 8,
                        padding: 8, alignItems: 'center' },
  roleBtnActive:      { backgroundColor: '#1D9E7520', borderColor: '#1D9E75' },
  roleBtnText:        { color: '#666', fontSize: 12 },
  roleBtnTextActive:  { color: '#1D9E75', fontWeight: '600' },
  presetRow:          { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  presetBtn:          { borderWidth: 1, borderColor: '#333', borderRadius: 6,
                        paddingHorizontal: 10, paddingVertical: 5 },
  presetBtnActive:    { backgroundColor: '#E24B4A20', borderColor: '#E24B4A' },
  presetText:         { color: '#666', fontSize: 11 },
  presetTextActive:   { color: '#E24B4A', fontWeight: '600' },
  createBtn:          { backgroundColor: '#E24B4A', borderRadius: 12, padding: 16,
                        alignItems: 'center', marginTop: 24 },
  createBtnDisabled:  { opacity: 0.5 },
  createText:         { color: '#fff', fontSize: 15, fontWeight: '700' },
});
```

---

## Dashboard — App Entry & Auth — `dashboard/src/App.tsx`

```tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import CreateConference from './pages/CreateConference';
import ConferenceDetail from './pages/ConferenceDetail';
import Layout from './components/Layout';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

function RequireAuth({ children }: { children: JSX.Element }) {
  return localStorage.getItem('admin_token') ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<Dashboard />} />
            <Route path="create" element={<CreateConference />} />
            <Route path="conference/:id" element={<ConferenceDetail />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
```

---

## Dashboard — Login Page — `dashboard/src/pages/Login.tsx`

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api/client';

export default function Login() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const navigate = useNavigate();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const { data } = await authApi.login(email, password);
      if (data.user.role !== 'ADMIN') {
        setError('This dashboard is for admin accounts only');
        return;
      }
      localStorage.setItem('admin_token', data.token);
      navigate('/');
    } catch (e: any) {
      setError(e.response?.data?.error || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', background: '#0a0a0a' }}>
      <form onSubmit={handleLogin} style={{ background: '#141414', padding: 40,
        borderRadius: 16, width: 360, border: '1px solid #222' }}>
        <div style={{ color: '#E24B4A', fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
          ● FieldCast
        </div>
        <p style={{ color: '#666', fontSize: 13, marginBottom: 28 }}>Admin Dashboard</p>

        <label style={lbl}>Email</label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)}
          placeholder="admin@yournewschannel.com" required style={inp} />

        <label style={lbl}>Password</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)}
          placeholder="••••••••" required style={inp} />

        {error && <p style={{ color: '#E24B4A', fontSize: 12, marginBottom: 12 }}>{error}</p>}

        <button type="submit" disabled={loading} style={{ width: '100%', padding: 12,
          background: '#E24B4A', color: '#fff', border: 'none', borderRadius: 10,
          fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: loading ? 0.7 : 1 }}>
          {loading ? 'Logging in...' : 'Login'}
        </button>
      </form>
    </div>
  );
}

const lbl: React.CSSProperties = {
  display: 'block', fontSize: 11, color: '#888', marginBottom: 5,
  textTransform: 'uppercase', letterSpacing: '0.06em',
};
const inp: React.CSSProperties = {
  width: '100%', padding: '10px 12px', background: '#1a1a1a', border: '1px solid #333',
  borderRadius: 8, color: '#fff', fontSize: 14, marginBottom: 14,
};
```

---

## Dashboard — Layout — `dashboard/src/components/Layout.tsx`

```tsx
import { Outlet, NavLink, useNavigate } from 'react-router-dom';

export default function Layout() {
  const navigate = useNavigate();

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#0a0a0a', color: '#fff' }}>
      {/* Sidebar */}
      <nav style={{ width: 210, background: '#111', borderRight: '1px solid #1e1e1e',
                    padding: '20px 12px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ color: '#E24B4A', fontWeight: 700, fontSize: 16,
                      marginBottom: 28, paddingLeft: 8 }}>
          ● FieldCast
        </div>
        <NavLink to="/"       end style={nav}>Dashboard</NavLink>
        <NavLink to="/create"     style={nav}>New Conference</NavLink>
        <div style={{ flex: 1 }} />
        <button onClick={() => { localStorage.removeItem('admin_token'); navigate('/login'); }}
          style={{ background: 'transparent', border: '1px solid #333', color: '#666',
                   borderRadius: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}>
          Logout
        </button>
      </nav>

      {/* Content */}
      <main style={{ flex: 1, overflowY: 'auto' }}>
        <Outlet />
      </main>
    </div>
  );
}

function nav({ isActive }: { isActive: boolean }): React.CSSProperties {
  return {
    display: 'block', padding: '9px 12px', marginBottom: 4, borderRadius: 8,
    color: isActive ? '#E24B4A' : '#888',
    background: isActive ? 'rgba(226,75,74,0.08)' : 'transparent',
    textDecoration: 'none', fontSize: 14,
  };
}
```

---

## Dashboard — Conference Detail — `dashboard/src/pages/ConferenceDetail.tsx`

```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { conferencesApi, participantsApi, usersApi } from '../api/client';
import HLSPlayer from '../components/HLSPlayer';
import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';

const PRESETS = [
  { label: 'Studio HD',      resolution: '1920x1080', bitrate: 6000, fps: 30 },
  { label: 'Field 720p',     resolution: '1280x720',  bitrate: 2500, fps: 25 },
  { label: 'Remote 480p',    resolution: '854x480',   bitrate: 800,  fps: 20 },
  { label: 'Emergency 360p', resolution: '640x360',   bitrate: 400,  fps: 15 },
];

export default function ConferenceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [addUserId, setAddUserId]   = useState('');
  const [addRole, setAddRole]       = useState('REPORTER');
  const [addPreset, setAddPreset]   = useState(1);

  const { data: conf } = useQuery({
    queryKey: ['conference', id],
    queryFn: () => conferencesApi.get(id!).then(r => r.data),
    refetchInterval: 5000,
  });

  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list().then(r => r.data),
  });

  const addParticipant = useMutation({
    mutationFn: () => {
      const preset = PRESETS[addPreset];
      return participantsApi.add(id!, addUserId, addRole,
        addRole === 'REPORTER' ? preset : undefined);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conference', id] });
      setAddUserId('');
    },
  });

  const removeParticipant = useMutation({
    mutationFn: (userId: string) => participantsApi.remove(id!, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conference', id] }),
  });

  const endConf = useMutation({
    mutationFn: () => conferencesApi.end(id!),
    onSuccess: () => navigate('/'),
  });

  if (!conf) return <div style={{ padding: 24, color: '#888' }}>Loading...</div>;

  const liveReporters = conf.participants.filter(
    (p: any) => p.role === 'REPORTER' && p.streamId && p.status === 'JOINED'
  );

  return (
    <div style={{ padding: 24 }}>
      <button onClick={() => navigate('/')} style={backBtn}>← Back</button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>{conf.title}</h1>
          <span style={{ ...statusBadge, background: conf.status === 'LIVE' ? '#E24B4A' : '#333' }}>
            {conf.status === 'LIVE' ? '● LIVE' : conf.status}
          </span>
          <span style={{ color: '#555', fontSize: 12, marginLeft: 10 }}>
            Created {formatDistanceToNow(new Date(conf.createdAt), { addSuffix: true })}
          </span>
        </div>
        {conf.status !== 'ENDED' && (
          <button onClick={() => endConf.mutate()} style={dangerBtn}>End Conference</button>
        )}
      </div>

      {/* Live stream tiles */}
      {liveReporters.length > 0 && (
        <section style={{ marginBottom: 32 }}>
          <h2 style={sectionTitle}>Live Streams</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {liveReporters.map((p: any) => (
              <HLSPlayer key={p.id} src={`/hls/${p.streamId}/index.m3u8`}
                reporterName={p.user.name} bitrate={p.bitrate} />
            ))}
          </div>
        </section>
      )}

      {/* Participants */}
      <section style={{ marginBottom: 28 }}>
        <h2 style={sectionTitle}>Participants</h2>
        {conf.participants.map((p: any) => (
          <div key={p.id} style={participantRow}>
            <div>
              <span style={{ fontWeight: 500 }}>{p.user.name}</span>
              <span style={{ color: '#666', fontSize: 12, marginLeft: 8 }}>
                {p.role} · {p.status}
              </span>
              {p.streamId && (
                <span style={{ color: '#1D9E75', fontSize: 11, marginLeft: 8 }}>● streaming</span>
              )}
            </div>
            {conf.status !== 'ENDED' && (
              <button onClick={() => removeParticipant.mutate(p.user.id)} style={removeBtn}>
                Remove
              </button>
            )}
          </div>
        ))}
      </section>

      {/* Add participant */}
      {conf.status !== 'ENDED' && (
        <section>
          <h2 style={sectionTitle}>Add Participant</h2>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <select value={addUserId} onChange={e => setAddUserId(e.target.value)} style={sel}>
              <option value="">Select user...</option>
              {users
                .filter((u: any) => !conf.participants.find((p: any) => p.user.id === u.id))
                .map((u: any) => (
                  <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                ))}
            </select>
            <select value={addRole} onChange={e => setAddRole(e.target.value)} style={sel}>
              <option value="REPORTER">Reporter</option>
              <option value="ANCHOR">Anchor</option>
            </select>
            {addRole === 'REPORTER' && (
              <select value={addPreset} onChange={e => setAddPreset(parseInt(e.target.value))} style={sel}>
                {PRESETS.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
              </select>
            )}
            <button
              onClick={() => addParticipant.mutate()}
              disabled={!addUserId || addParticipant.isPending}
              style={addBtn}
            >
              {addParticipant.isPending ? 'Adding...' : 'Add & Notify'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11, color: '#666', textTransform: 'uppercase',
  letterSpacing: '0.08em', marginBottom: 12,
};
const participantRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '10px 14px', background: '#141414', borderRadius: 8,
  border: '1px solid #1e1e1e', marginBottom: 6,
};
const backBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#666',
  fontSize: 14, cursor: 'pointer', marginBottom: 16, padding: 0,
};
const statusBadge: React.CSSProperties = {
  display: 'inline-block', color: '#fff', fontSize: 10, fontWeight: 700,
  padding: '3px 8px', borderRadius: 5,
};
const dangerBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #E24B4A', color: '#E24B4A',
  borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: 'pointer',
};
const removeBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #333', color: '#666',
  borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
};
const sel: React.CSSProperties = {
  background: '#1a1a1a', border: '1px solid #333', borderRadius: 8,
  color: '#fff', padding: '9px 12px', fontSize: 13,
};
const addBtn: React.CSSProperties = {
  background: '#1D9E75', border: 'none', color: '#fff',
  borderRadius: 8, padding: '9px 18px', fontSize: 13,
  fontWeight: 600, cursor: 'pointer',
};
```
