import { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { getToken, getUser } from '../lib/auth';

export default function Index() {
  const router = useRouter();

  useEffect(() => {
    async function checkAuth() {
      // Small artificial delay to show off the premium loader
      await new Promise((resolve) => setTimeout(resolve, 800));

      try {
        const token = await getToken();
        const user = await getUser();

        if (token && user) {
          // Route based on stored user role
          if (user.role === 'ADMIN') {
            router.replace('/(admin)/home');
          } else if (user.role === 'ANCHOR') {
            router.replace('/(anchor)/home');
          } else {
            router.replace('/(reporter)/home');
          }
        } else {
          router.replace('/(auth)/login');
        }
      } catch (err) {
        console.error('[Index] Auth check failed:', err);
        router.replace('/(auth)/login');
      }
    }

    checkAuth();
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.logoContainer}>
        <Text style={styles.logoIcon}>●</Text>
        <Text style={styles.logoText}>FieldCast</Text>
      </View>
      <ActivityIndicator size="small" color="#ef4444" style={styles.loader} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0c',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 20,
  },
  logoIcon: {
    color: '#ef4444',
    fontSize: 24,
    fontWeight: '800',
  },
  logoText: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  loader: {
    marginTop: 10,
  },
});
