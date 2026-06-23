import { Expo, ExpoPushMessage } from 'expo-server-sdk';

const expo = new Expo();

export async function sendPushNotification(
  expoPushToken: string,
  title: string,
  body: string,
  data?: Record<string, any>,
): Promise<void> {
  // Validate the token
  if (!Expo.isExpoPushToken(expoPushToken)) {
    console.warn(`[Push] Invalid Expo push token: ${expoPushToken}`);
    return;
  }

  const message: ExpoPushMessage = {
    to: expoPushToken,
    sound: 'default',
    title,
    body,
    data: data || {},
    priority: 'high',
  };

  try {
    const chunks = expo.chunkPushNotifications([message]);
    for (const chunk of chunks) {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      console.log('[Push] Sent:', receipts);
    }
  } catch (err) {
    console.error('[Push] Failed to send notification:', err);
  }
}

// Send to multiple users at once (used when creating a conference with multiple participants)
export async function sendBulkPushNotification(
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, any>,
): Promise<void> {
  const validTokens = tokens.filter(t => Expo.isExpoPushToken(t));
  if (!validTokens.length) return;

  const messages: ExpoPushMessage[] = validTokens.map(token => ({
    to: token,
    sound: 'default',
    title,
    body,
    data: data || {},
    priority: 'high',
  }));

  try {
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
  } catch (err) {
    console.error('[Push] Bulk send failed:', err);
  }
}
