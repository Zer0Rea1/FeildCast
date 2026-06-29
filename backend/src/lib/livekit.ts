import {
  RoomServiceClient,
  AccessToken,
  IngressClient,
  IngressInput,
  CreateIngressOptions,
} from 'livekit-server-sdk';

const livekitHost   = process.env.LIVEKIT_HOST!;
const apiKey        = process.env.LIVEKIT_API_KEY!;
const apiSecret     = process.env.LIVEKIT_API_SECRET!;
const ingressHost   = process.env.LIVEKIT_INGRESS_HOST || 'http://localhost:8080';

const roomService   = new RoomServiceClient(livekitHost, apiKey, apiSecret);
const ingressClient = new IngressClient(ingressHost, apiKey, apiSecret);

export interface IngressInfo {
  ingressId: string;
  rtmpUrl:   string;   // e.g. rtmp://localhost:1935/live
  streamKey: string;   // unique key per reporter
}

// Call this when reporter connects to WebSocket bridge
// Creates an RTMP ingress in the LiveKit room for this reporter
export async function createReporterIngress(
  roomName:      string,
  participantId: string,
  participantName: string,
): Promise<IngressInfo> {
  const options: CreateIngressOptions = {
    name:            participantName,
    roomName,
    participantIdentity: participantId + '-ingress',
    participantName,
  };

  const ingress = await ingressClient.createIngress(
    IngressInput.RTMP_INPUT,
    options,
  );

  return {
    ingressId:  ingress.ingressId,
    rtmpUrl:    ingress.url,      // e.g. rtmp://your-ingress-host/live
    streamKey:  ingress.streamKey,
  };
}

// Call this when reporter disconnects — cleans up the ingress
export async function deleteReporterIngress(ingressId: string): Promise<void> {
  try {
    await ingressClient.deleteIngress(ingressId);
  } catch {
    // Ingress may already be gone
  }
}

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
  audioOnly = false,
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
