import { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl, SafeAreaView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { conferencesApi } from '../../lib/api';
import { listenForNotifications } from '../../lib/notifications';
import { clearAuth, getUser, AuthUser } from '../../lib/auth';

interface Conference {
  id: string;
  title: string;
  description?: string;
  status: 'PENDING' | 'LIVE' | 'ENDED';
}

export default function ReporterHome() {
  const [conferences, setConferences] = useState<Conference[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const router = useRouter();

  async function load() {
    try {
      const [confRes, userObj] = await Promise.all([
        conferencesApi.list(),
        getUser()
      ]);
      setConferences(confRes.data);
      setUser(userObj);
    } catch (e) {
      console.warn('Failed to load reporter home context:', e);
    } finally {
      setLoading(false);
    }
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

  async function handleLogout() {
    await clearAuth();
    router.replace('/(auth)/login');
  }

  function renderItem({ item }: { item: Conference }) {
    const isLive = item.status === 'LIVE';
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{item.title}</Text>
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

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#ef4444" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.header}>
          <View>
            <Text style={styles.welcome}>Welcome back,</Text>
            <Text style={styles.userName}>{user?.name || 'Reporter'}</Text>
          </View>
          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
            <Text style={styles.logoutText}>Sign Out</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.heading}>Assigned Conferences</Text>

        <FlatList
          data={conferences}
          keyExtractor={i => i.id}
          renderItem={renderItem}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor="#ef4444"
              colors={['#ef4444']}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyIcon}>📡</Text>
              <Text style={styles.empty}>No conferences assigned yet</Text>
              <Text style={styles.emptySub}>Pull down to refresh and check again</Text>
            </View>
          }
          contentContainerStyle={{ paddingBottom: 40 }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0a0a0c' },
  container: { flex: 1, paddingHorizontal: 20, paddingTop: 12 },
  loadingContainer: { flex: 1, backgroundColor: '#0a0a0c', justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 28,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderColor: '#1c1c21',
  },
  welcome: { color: '#8e8e93', fontSize: 13, fontWeight: '500' },
  userName: { color: '#ffffff', fontSize: 18, fontWeight: '700', marginTop: 2 },
  logoutBtn: {
    backgroundColor: '#1c1c21',
    borderWidth: 1,
    borderColor: '#2d2d34',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  logoutText: { color: '#ef4444', fontSize: 13, fontWeight: '600' },
  heading: { color: '#ffffff', fontSize: 18, fontWeight: '700', marginBottom: 16 },
  card: {
    backgroundColor: '#131316',
    borderRadius: 16,
    padding: 18,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#222227',
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, gap: 12 },
  cardTitle: { color: '#ffffff', fontSize: 16, fontWeight: '600', flex: 1 },
  badge: { backgroundColor: '#222227', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  badgeLive: { backgroundColor: '#301314', borderWidth: 1, borderColor: '#5c1f20' },
  badgeText: { color: '#ef4444', fontSize: 10, fontWeight: '700' },
  desc: { color: '#8e8e93', fontSize: 13, marginBottom: 16, lineHeight: 18 },
  joinBtn: {
    backgroundColor: '#ef4444',
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
    shadowColor: '#ef4444',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 2,
  },
  joinText: { color: '#ffffff', fontSize: 14, fontWeight: '700' },
  emptyContainer: { alignItems: 'center', justifyContent: 'center', marginTop: 80, paddingHorizontal: 30 },
  emptyIcon: { fontSize: 40, marginBottom: 16 },
  empty: { color: '#ffffff', textAlign: 'center', fontSize: 15, fontWeight: '600', marginBottom: 4 },
  emptySub: { color: '#8e8e93', textAlign: 'center', fontSize: 13 },
});
