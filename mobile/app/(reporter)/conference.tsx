import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, SafeAreaView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Camera } from 'expo-camera';
import { mediaDevices, RTCView } from 'react-native-webrtc';
import { conferencesApi } from '../../lib/api';
import { getToken } from '../../lib/auth';
import { SrtStreamer } from '../../lib/wsStream';

export default function ReporterConference() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamId, setStreamId] = useState('');
  const [bytesSent, setBytesSent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [conference, setConference] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [localStream, setLocalStream] = useState<any>(null);
  const [streamSettings, setStreamSettings] = useState({ resolution: '1280x720', bitrate: 2500, fps: 25 });

  const streamerRef = useRef<SrtStreamer | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    (async () => {
      // Request permissions using expo-camera
      const cameraStatus = await Camera.requestCameraPermissionsAsync();
      const audioStatus = await Camera.requestMicrophonePermissionsAsync();
      
      const granted = cameraStatus.status === 'granted' && audioStatus.status === 'granted';
      setHasPermission(granted);

      if (granted) {
        await loadConference();
      } else {
        Alert.alert('Permission denied', 'Camera and microphone permissions are required.');
        router.back();
      }
    })();

    return () => {
      cleanupStream();
    };
  }, []);

  async function loadConference() {
    try {
      const { data: conf } = await conferencesApi.get(id);
      setConference(conf);
      // Join conference — gets stream settings
      const { data: joinData } = await conferencesApi.join(id);
      if (joinData.streamSettings) {
        setStreamSettings(joinData.streamSettings);
      }
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.error || 'Could not load conference');
      router.back();
    } finally {
      setLoading(false);
    }
  }

  function cleanupStream() {
    clearInterval(timerRef.current);
    streamerRef.current?.stop();
    streamerRef.current = null;
    if (localStream) {
      localStream.getTracks().forEach((track: any) => track.stop());
      setLocalStream(null);
    }
  }

  async function startStream() {
    const token = await getToken();
    if (!token) return Alert.alert('Error', 'Session expired. Please log in again.');

    try {
      setLoading(true);

      // Get camera MediaStream via react-native-webrtc
      const [width, height] = streamSettings.resolution.split('x').map(Number);
      const stream = await mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: 'environment', // Back camera for reporters
          width: width || 1280,
          height: height || 720,
          frameRate: streamSettings.fps || 25,
        },
      });

      setLocalStream(stream);

      const streamer = new SrtStreamer({
        onReady: (sid) => {
          setStreamId(sid);
          setStreaming(true);
          setLoading(false);
          let elapsed = 0;
          timerRef.current = setInterval(() => setDuration(++elapsed), 1000);
        },
        onError: (msg) => {
          Alert.alert('Stream error', msg);
          setStreaming(false);
          setLoading(false);
          cleanupStream();
        },
        onStats: (bytes) => setBytesSent(bytes),
      });

      streamerRef.current = streamer;
      await streamer.start(token, id, stream, streamSettings.bitrate);
    } catch (e: any) {
      setLoading(false);
      Alert.alert('Stream Error', e.message || 'Failed to initialize video capture');
      cleanupStream();
    }
  }

  function stopStream() {
    cleanupStream();
    setStreaming(false);
    setDuration(0);
    setBytesSent(0);
  }

  const fmt = (s: number) => {
    const mins = String(Math.floor(s / 60)).padStart(2, '0');
    const secs = String(s % 60).padStart(2, '0');
    return `${mins}:${secs}`;
  };

  if (hasPermission === null || loading && !conference) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#ef4444" />
        <Text style={styles.loadingText}>Initializing camera...</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.previewContainer}>
          {localStream ? (
            <RTCView
              streamURL={localStream.toURL()}
              style={styles.camera}
              objectFit="cover"
            />
          ) : (
            <View style={styles.cameraPlaceholder}>
              <Text style={styles.placeholderText}>Camera Feed Off</Text>
            </View>
          )}

          {streaming && (
            <>
              <View style={styles.liveBadge}>
                <Text style={styles.liveText}>● LIVE</Text>
              </View>
              <View style={styles.hud}>
                <Text style={styles.hudText}>TIME: {fmt(duration)}</Text>
                <Text style={styles.hudText}>SENT: {(bytesSent / 1e6).toFixed(2)} MB</Text>
                <Text style={styles.hudText}>RATE: {streamSettings.bitrate} kbps</Text>
                <Text style={styles.hudText}>FPS: {streamSettings.fps}</Text>
              </View>
            </>
          )}
        </View>

        <View style={styles.controls}>
          <Text style={styles.confTitle}>{conference?.title || 'Loading...'}</Text>
          {conference?.description ? (
            <Text style={styles.confDesc}>{conference.description}</Text>
          ) : null}

          <TouchableOpacity
            style={[styles.streamBtn, streaming && styles.stopBtn]}
            onPress={streaming ? stopStream : startStream}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.streamBtnText}>
                {streaming ? 'Stop Streaming' : 'Go Live'}
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => {
              stopStream();
              router.back();
            }}
          >
            <Text style={styles.backText}>Leave Conference</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#000000' },
  container: { flex: 1, backgroundColor: '#000000' },
  loadingContainer: { flex: 1, backgroundColor: '#0a0a0c', justifyContent: 'center', alignItems: 'center' },
  loadingText: { color: '#8e8e93', marginTop: 12, fontSize: 14, fontWeight: '500' },
  previewContainer: { flex: 1, position: 'relative', overflow: 'hidden' },
  camera: { flex: 1 },
  cameraPlaceholder: {
    flex: 1,
    backgroundColor: '#121214',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: { color: '#44444c', fontSize: 16, fontWeight: '600' },
  liveBadge: {
    position: 'absolute',
    top: 20,
    left: 20,
    backgroundColor: '#301314',
    borderWidth: 1,
    borderColor: '#ef4444',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  liveText: { color: '#ef4444', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  hud: {
    position: 'absolute',
    top: 20,
    right: 20,
    backgroundColor: 'rgba(19,19,22,0.85)',
    borderWidth: 1,
    borderColor: '#2d2d34',
    borderRadius: 12,
    padding: 14,
    gap: 4,
  },
  hudText: { color: '#ffffff', fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', fontWeight: '600' },
  controls: {
    backgroundColor: '#0d0d0e',
    borderTopWidth: 1,
    borderColor: '#222227',
    padding: 24,
    paddingBottom: Platform.OS === 'ios' ? 12 : 24,
  },
  confTitle: { color: '#ffffff', fontSize: 18, fontWeight: '700', marginBottom: 4 },
  confDesc: { color: '#8e8e93', fontSize: 13, marginBottom: 20 },
  streamBtn: {
    backgroundColor: '#ef4444',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginBottom: 12,
    shadowColor: '#ef4444',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  stopBtn: {
    backgroundColor: '#222227',
    shadowColor: '#000',
    shadowOpacity: 0,
    elevation: 0,
  },
  streamBtnText: { color: '#ffffff', fontSize: 15, fontWeight: '700', letterSpacing: 0.2 },
  backBtn: { alignItems: 'center', padding: 12 },
  backText: { color: '#8e8e93', fontSize: 13, fontWeight: '600' },
});
