// Push notification helpers.
// NOTE: This file is currently stubbed out (push system removed from the app UI).
// Keeping the exported functions prevents TypeScript/build errors in screens.

export async function registerForPushNotifications(): Promise<string | null> {
  // No-op
  return null;
}

// Reload helper used by home screens.
export function listenForNotifications(_onNotification: (data: any) => void): () => void {
  // No-op: return unsubscribe function
  return () => {};
}

export function listenForNotificationTaps(_onTap: (data: any) => void): () => void {
  // No-op: return unsubscribe function
  return () => {};
}

