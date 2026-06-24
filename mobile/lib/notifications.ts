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

  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    console.log('[Push] Expo push token:', token);
    return token;
  } catch (err: any) {
    console.warn('[Push] Error getting push token:', err.message || err);
    return null;
  }
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
