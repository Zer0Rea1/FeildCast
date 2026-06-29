import { useEffect, useState } from 'react';
import { View, StyleSheet, Text, TouchableOpacity, Alert, ActivityIndicator, SafeAreaView, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
// import { LiveKitRoom, useRoomContext, VideoView } from '@livekit/react-native';
import { Camera } from 'expo-camera';
import { conferencesApi } from '../../lib/api';

// Anchor screen — joins LiveKit room and sees all reporter video tiles
// Anchor can talk to all reporters via WebRTC audio
// export default function AnchorConference() {
//   const { id } = useLocalSearchParams<{ id: string }>();
//   const router = useRouter();
//   const [liveKitToken, setLiveKitToken] = useState('');
//   const [liveKitUrl, setLiveKitUrl] = useState('');
//   const [conference, setConference] = useState<any>(null);
//   const [loading, setLoading] = useState(true);

//   useEffect(() => {
//     (async () => {
//       // Request microphone permissions so the anchor can talk to reporters
//       const micStatus = await Camera.requestMicrophonePermissionsAsync();
//       if (micStatus.status !== 'granted') {
//         Alert.alert('Microphone Required', 'Microphone permission is required to speak with reporters.');
//       }
//       await load();
//     })();
//   }, []);

//   async function load() {
//     try {
//       const { data: conf } = await conferencesApi.get(id);
//       setConference(conf);

//       // Join the conference (marks anchor as joined in DB)
//       await conferencesApi.join(id);

//       // Get LiveKit token for WebRTC room
//       const { data: tkData } = await conferencesApi.getLiveKitToken(id);
//       setLiveKitToken(tkData.token);
//       setLiveKitUrl(process.env.EXPO_PUBLIC_LIVEKIT_URL || 'wss://yourdomain.com');
//     } catch (e: any) {
//       Alert.alert('Error', e.response?.data?.error || 'Could not join conference');
//       router.back();
//     } finally {
//       setLoading(false);
//     }
//   }

//   if (loading || !liveKitToken) {
//     return (
//       <View style={styles.loading}>
//         <ActivityIndicator size="large" color="#ef4444" />
//         <Text style={styles.loadingText}>Connecting to Broadcast Studio...</Text>
//       </View>
//     );
//   }

//   return (
//     <LiveKitRoom serverUrl={liveKitUrl} token={liveKitToken} connect audio={true}>
//       <AnchorView conference={conference} onLeave={() => router.back()} />
//     </LiveKitRoom>
//   );
// }
// Safe import — won't crash if WebRTC native module is missing
let RoomProvider: any = null;
let useRoom: any = null;
try {
  const lk = require('@livekit/react-native');
  RoomProvider = lk.RoomProvider;
  useRoom = lk.useRoom;
} catch {
  console.warn('LiveKit not available in Expo Go');
}
export default function AnchorConference() {
  if (!RoomProvider) {
    return (
      <View style={{ flex:1, backgroundColor:'#000',
        justifyContent:'center', alignItems:'center' }}>
        <Text style={{ color:'#fff', fontSize:16, marginBottom:8 }}>
          WebRTC requires a development build
        </Text>
        <Text style={{ color:'#666', fontSize:12, textAlign:'center', paddingHorizontal:40 }}>
          Run: eas build --profile development --platform android
        </Text>
      </View>
    );
  }

  // ... rest of anchor screen
}

// function AnchorView({ conference, onLeave }: { conference: any; onLeave: () => void }) {
//   const room = useRoomContext();
//   const participants = Array.from(room.remoteParticipants.values());

//   return (
//     <SafeAreaView style={styles.safeArea}>
//       <View style={styles.container}>
//         <View style={styles.header}>
//           <View style={styles.headerTitleContainer}>
//             <View style={styles.studioIndicator}>
//               <Text style={styles.studioIndicatorText}>STUDIO ON-AIR</Text>
//             </View>
//             <Text style={styles.title} numberOfLines={1}>{conference?.title}</Text>
//           </View>
//           <TouchableOpacity onPress={onLeave} style={styles.leaveBtn}>
//             <Text style={styles.leaveBtnText}>Disconnect</Text>
//           </TouchableOpacity>
//         </View>

//         {/* Reporter video grid */}
//         <View style={styles.grid}>
//           {participants.length === 0 ? (
//             <View style={styles.emptyStudio}>
//               <Text style={styles.emptyStudioIcon}>📡</Text>
//               <Text style={styles.waiting}>Waiting for reporters to connect...</Text>
//               <Text style={styles.waitingSub}>Reporters will appear here automatically when they go live.</Text>
//             </View>
//           ) : (
//             <View style={styles.tilesContainer}>
//               {participants.map(participant => {
//                 const videoPublications = Array.from(participant.videoTrackPublications.values());
//                 const audioPublications = Array.from(participant.audioTrackPublications.values());
//                 const videoTrackPub = videoPublications[0];
//                 const audioTrackPub = audioPublications[0];

//                 return (
//                   <View key={participant.identity} style={styles.tile}>
//                     <View style={styles.videoWrapper}>
//                       {videoTrackPub?.track ? (
//                         <VideoView
//                           videoTrack={videoTrackPub.track as any}
//                           style={styles.video}
//                         />
//                       ) : (
//                         <View style={styles.noVideo}>
//                           <Text style={styles.noVideoText}>🎙️ Audio Only</Text>
//                         </View>
//                       )}
                      
//                       {/* Premium tile label */}
//                       <View style={styles.tileLabel}>
//                         <View style={styles.greenDot} />
//                         <Text style={styles.tileLabelText}>{participant.name || 'Remote Reporter'}</Text>
//                       </View>
//                     </View>
//                   </View>
//                 );
//               })}
//             </View>
//           )}
//         </View>

//         {/* Control bar for Anchor */}
//         <View style={styles.studioControls}>
//           <Text style={styles.studioInfo}>Studio Link: {participants.length} Active Feed(s)</Text>
//         </View>
//       </View>
//     </SafeAreaView>
//   );
// }

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0a0a0c' },
  container: { flex: 1, backgroundColor: '#0a0a0c' },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0a0a0c' },
  loadingText: { color: '#8e8e93', fontSize: 14, marginTop: 16, fontWeight: '500' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderColor: '#1c1c21',
  },
  headerTitleContainer: {
    flex: 1,
    marginRight: 16,
  },
  studioIndicator: {
    backgroundColor: '#301314',
    borderWidth: 1,
    borderColor: '#ef4444',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignSelf: 'flex-start',
    marginBottom: 4,
  },
  studioIndicatorText: {
    color: '#ef4444',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  title: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
  leaveBtn: {
    backgroundColor: '#1c1c21',
    borderWidth: 1,
    borderColor: '#2d2d34',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  leaveBtnText: { color: '#ef4444', fontSize: 12, fontWeight: '700' },
  grid: { flex: 1, padding: 10 },
  tilesContainer: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  tile: {
    width: '48.5%',
    aspectRatio: 16 / 9,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#222227',
    backgroundColor: '#131316',
  },
  videoWrapper: {
    width: '100%',
    height: '100%',
    position: 'relative',
  },
  video: { width: '100%', height: '100%', backgroundColor: '#131316' },
  noVideo: {
    flex: 1,
    backgroundColor: '#1c1c21',
    justifyContent: 'center',
    alignItems: 'center',
  },
  noVideoText: {
    color: '#8e8e93',
    fontSize: 12,
    fontWeight: '600',
  },
  tileLabel: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    backgroundColor: 'rgba(19,19,22,0.85)',
    borderWidth: 1,
    borderColor: '#2d2d34',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  greenDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#10b981',
  },
  tileLabelText: { color: '#ffffff', fontSize: 10, fontWeight: '600' },
  emptyStudio: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyStudioIcon: {
    fontSize: 44,
    marginBottom: 16,
  },
  waiting: { color: '#ffffff', fontSize: 16, fontWeight: '700', textAlign: 'center', marginBottom: 6 },
  waitingSub: { color: '#8e8e93', fontSize: 13, textAlign: 'center', lineHeight: 18 },
  studioControls: {
    backgroundColor: '#0d0d0e',
    borderTopWidth: 1,
    borderColor: '#222227',
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: Platform.OS === 'ios' ? 8 : 16,
  },
  studioInfo: {
    color: '#8e8e93',
    fontSize: 12,
    fontWeight: '600',
  },
});
