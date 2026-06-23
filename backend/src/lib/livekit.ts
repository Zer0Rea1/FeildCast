import { RoomServiceClient, AccessToken } from 'livekit-server-sdk';

const livekitHost = process.env.LIVEKIT_HOST!;
const apiKey = process.env.LIVEKIT_API_KEY!;
const apiSecret = process.env.LIVEKIT_API_SECRET!;

const roomService = new RoomServiceClient(livekitHost, apiKey, apiSecret);

// Create a LiveKit room when admin creates a conference
export async function createLiveKitRoom(roomName: string): Promise<void> {
  await roomService.createRoom({
    name: roomName,
    emptyTimeout: 300,     // auto-delete after 5 min if empty
    maxParticipants: 6,    // 1 anchor + up to 5 reporters
  });
}

// Delete room when conference ends
export async function deleteLiveKitRoom(roomName: string): Promise<void> {
  try {
    await roomService.deleteRoom(roomName);
  } catch {
    // Room may already be gone — ignore
  }
}

// Generate a LiveKit access token for a participant joining a room
// This token is passed to the LiveKit SDK on the mobile app
export async function generateLiveKitToken(
  roomName: string,
  participantId: string,
  participantName: string,
): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, {
    identity: participantId,
    name: participantName,
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return await token.toJwt();
}

// List active participants in a room (for admin dashboard)
export async function getRoomParticipants(roomName: string) {
  try {
    return await roomService.listParticipants(roomName);
  } catch {
    return [];
  }
}
