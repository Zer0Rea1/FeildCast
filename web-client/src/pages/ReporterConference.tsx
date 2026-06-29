import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useIsMobile } from '../hooks/useIsMobile';
import {
  LiveKitRoom,
  VideoTrack,
  useTracks,
  RoomAudioRenderer,
  isTrackReference,
  useLocalParticipant,
} from '@livekit/components-react';
import '@livekit/components-styles';
import { Track } from 'livekit-client';
import { conferencesApi } from '../api/client';
import { getToken } from '../lib/auth';
import { SrtStreamer, getCameraStream } from '../lib/wsStream';

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || 'ws://localhost:7880';

export default function ReporterConference() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // All hooks at top — never after conditional returns
  const isMobile = useIsMobile();
  const [conference, setConference]         = useState<any>(null);
  const [streaming, setStreaming]           = useState(false);
  const [, setStreamId]                     = useState('');
  const [bytesSent, setBytesSent]           = useState(0);
  const [duration, setDuration]             = useState(0);
  const [error, setError]                   = useState('');
  const [lkToken, setLkToken]               = useState('');
  const [cameraOff, setCameraOff]           = useState(false);
  const [facingMode, setFacingMode]         = useState<'environment' | 'user'>('environment');
  const [streamSettings, setStreamSettings] = useState({
    resolution: '1280x720', bitrate: 2500, fps: 25,
  });

  const videoRef    = useRef<HTMLVideoElement>(null);
  const streamerRef = useRef<SrtStreamer | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const timerRef    = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    load();
    return () => {
      clearInterval(timerRef.current);
      streamerRef.current?.stop();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [id]);

  async function load() {
    try {
      const { data: conf }     = await conferencesApi.get(id!);
      const { data: joinData } = await conferencesApi.join(id!);
      setConference(conf);
      if (joinData.streamSettings) setStreamSettings(joinData.streamSettings);
      const { data: tkData }   = await conferencesApi.getLiveKitToken(id!);
      setLkToken(tkData.token);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Could not join conference');
    }
  }

  // Camera flip: if currently streaming, stop → switch → restart automatically
  async function flipCamera() {
    const next: 'environment' | 'user' = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(next);

    if (streaming) {
      // Stop the current stream
      streamerRef.current?.stop();
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
      clearInterval(timerRef.current);
      setStreaming(false);
      setDuration(0);
      setBytesSent(0);

      // Small delay so old tracks fully release
      await new Promise(r => setTimeout(r, 300));

      // Restart with new facing mode
      await startStreamWithFacing(next);
    }
  }

  async function startStreamWithFacing(facing: 'environment' | 'user') {
    setError('');
    try {
      const stream = await getCameraStream(streamSettings.resolution, streamSettings.fps, facing);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
      const token = getToken()!;
      const streamer = new SrtStreamer({
        onReady: (sid) => {
          setStreamId(sid);
          setStreaming(true);
          timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
        },
        onError: (msg) => { setError(msg); setStreaming(false); clearInterval(timerRef.current); },
        onStats: (bytes) => setBytesSent(bytes),
        onDisconnect: () => { setStreaming(false); clearInterval(timerRef.current); },
      });
      streamerRef.current = streamer;
      await streamer.start(token, id!, stream, streamSettings.bitrate);
    } catch (e: any) {
      setError(e.name === 'NotAllowedError'
        ? 'Camera/microphone permission denied.'
        : e.message || 'Failed to start stream');
    }
  }

  async function startStream() { await startStreamWithFacing(facingMode); }

  function stopStream() {
    streamerRef.current?.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    clearInterval(timerRef.current);
    setStreaming(false);
    setDuration(0);
    setBytesSent(0);
    setCameraOff(false);
  }

  function toggleCameraStream() {
    if (streamRef.current) {
      streamRef.current.getVideoTracks().forEach(t => { t.enabled = !t.enabled; });
    }
    setCameraOff(prev => !prev);
  }

  function leave() { stopStream(); navigate('/conferences'); }

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  if (error && !conference) {
    return (
      <div style={ST.center}>
        <div style={ST.errorCard}>
          <div style={{ fontSize: 36 }}>⚠️</div>
          <p style={{ color: '#E24B4A', margin: 0 }}>{error}</p>
          <button onClick={() => navigate('/conferences')} style={ST.backBtn}>← Go Back</button>
        </div>
      </div>
    );
  }

  if (!lkToken || !conference) {
    return (
      <div style={ST.center}>
        <div style={ST.spinner} />
        <p style={{ color: '#888', marginTop: 16, fontSize: 14 }}>Joining conference...</p>
      </div>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={LIVEKIT_URL}
      token={lkToken}
      connect
      audio={true}
      video={true}
      style={{ ...ST.container, flexDirection: isMobile ? 'column' : 'row' }}
    >
      <RoomAudioRenderer />

      {/* ── Main: camera preview + controls ── */}
      <div style={ST.mainArea}>
        <div style={ST.header}>
          <div style={ST.headerLeft}>
            <span style={ST.logo}>● FieldCast</span>
            {!isMobile && <><span style={ST.dividerDot}>·</span><span style={ST.confNameText}>{conference?.title}</span></>}
            <span style={ST.roleBadge}>REPORTER</span>
          </div>
          <button onClick={leave} style={ST.leaveBtn}>← Leave</button>
        </div>

        <div style={ST.videoWrap}>
          <video ref={videoRef} muted playsInline style={ST.video} />
          {streaming && <div style={ST.liveBadge}>🔴 LIVE</div>}
          {streaming && (
            <div style={ST.hud}>
              <span style={ST.hudItem}>{fmt(duration)}</span>
              <span style={ST.hudItem}>{(bytesSent / 1e6).toFixed(1)} MB</span>
              {!isMobile && <span style={ST.hudItem}>{streamSettings.bitrate} kbps</span>}
            </div>
          )}
          {!streaming && (
            <div style={ST.placeholder}>
              <span style={{ fontSize: isMobile ? 40 : 52 }}>📹</span>
              <p style={ST.placeholderText}>SRT Broadcast</p>
              <p style={ST.placeholderSub}>Tap "Go Live" to start</p>
            </div>
          )}
        </div>

        <div style={ST.controls}>
          {error && <div style={ST.errorBox}>{error}</div>}
          <ReporterControlBar
            streaming={streaming}
            cameraOff={cameraOff}
            isMobile={isMobile}
            facingMode={facingMode}
            confMeta={`${streamSettings.resolution} · ${streamSettings.bitrate} kbps`}
            onStartStream={startStream}
            onStopStream={stopStream}
            onCameraToggle={toggleCameraStream}
            onFlipCamera={flipCamera}
          />
        </div>
      </div>

      {/* ── Desktop: sidebar with participant tiles ── */}
      {!isMobile && <MeetingSidebar />}

      {/* ── Mobile: compact participant strip below controls ── */}
      {isMobile && <MobileParticipantStrip />}
    </LiveKitRoom>
  );
}

// ── Inside LiveKitRoom context ──

function MobileParticipantStrip() {
  const allTracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false }
  );
  const remoteTracks = allTracks.filter(
    t => !t.participant.isLocal && !t.participant.identity.endsWith('-ingress')
  );

  if (remoteTracks.length === 0) {
    return (
      <div style={ST.mobileStrip}>
        <div style={ST.mobileStripEmpty}>
          <span style={{ fontSize: 14 }}>👥</span>
          <span>Waiting for others…</span>
        </div>
      </div>
    );
  }

  return (
    <div style={ST.mobileStrip}>
      <div style={ST.mobileStripScroll}>
        {remoteTracks.map(track => {
          const name = track.participant.name || track.participant.identity;
          const hasVideo = isTrackReference(track);
          return (
            <div key={track.participant.identity} style={ST.stripTile}>
              {hasVideo
                ? <VideoTrack trackRef={track} style={ST.stripVideo} />
                : <div style={ST.stripAvatar}>{name.charAt(0).toUpperCase()}</div>}
              <span style={ST.stripName}>{name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MeetingSidebar() {
  const allTracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false }
  );
  const localTrack   = allTracks.find(t => t.participant.isLocal);
  const remoteTracks = allTracks.filter(
    t => !t.participant.isLocal && !t.participant.identity.endsWith('-ingress')
  );

  return (
    <div style={ST.sidebar}>
      <div style={ST.sidebarHeader}>
        <span style={ST.sidebarTitle}>Meeting Room</span>
        <span style={ST.sidebarCount}>{remoteTracks.length + 1}</span>
      </div>
      <div style={ST.selfSection}>
        <SidebarTile track={localTrack} label="You" isSelf />
      </div>
      <div style={ST.divider} />
      {remoteTracks.length === 0 ? (
        <div style={ST.sideEmpty}>
          <span style={{ fontSize: 28 }}>👥</span>
          <p style={{ margin: 0, fontSize: 12 }}>Waiting for others…</p>
        </div>
      ) : (
        <div style={ST.sideList}>
          {remoteTracks.map(t => (
            <SidebarTile key={t.participant.identity}
              track={t} label={t.participant.name || t.participant.identity} />
          ))}
        </div>
      )}
    </div>
  );
}

function SidebarTile({ track, label, isSelf }: { track: any; label: string; isSelf?: boolean }) {
  const hasVideo = track && isTrackReference(track);
  return (
    <div style={ST.sideTile}>
      <div style={ST.sideTileInner}>
        {hasVideo
          ? <VideoTrack trackRef={track} style={ST.sideVideo} />
          : <div style={ST.sideAvatar}><span style={ST.sideAvatarText}>{label.charAt(0).toUpperCase()}</span></div>}
        <div style={ST.sideName}>
          {isSelf && <span style={{ color: '#34d399', fontWeight: 700 }}>YOU · </span>}
          {label}
        </div>
        {isSelf && <div style={ST.selfGreenDot} />}
      </div>
    </div>
  );
}

function ReporterControlBar({
  streaming, cameraOff, isMobile, facingMode, confMeta,
  onStartStream, onStopStream, onCameraToggle, onFlipCamera,
}: {
  streaming: boolean; cameraOff: boolean; isMobile: boolean;
  facingMode: 'environment' | 'user'; confMeta: string;
  onStartStream: () => void; onStopStream: () => void;
  onCameraToggle: () => void; onFlipCamera: () => void;
}) {
  const { localParticipant } = useLocalParticipant();
  const micEnabled = localParticipant.isMicrophoneEnabled;

  const btnBase = isMobile ? ST.mediaBtnMobile : ST.mediaBtn;
  const [starting, setStarting] = useState(false);

  async function handleGoLive() {
    setStarting(true);
    try {
      // Release LiveKit's camera first so SRT can exclusively capture it.
      // On mobile only one getUserMedia session can hold the camera at a time.
      if (localParticipant.isCameraEnabled) {
        await localParticipant.setCameraEnabled(false);
        // Give the OS a moment to fully release the hardware
        await new Promise(r => setTimeout(r, 350));
      }
      await onStartStream();
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    onStopStream();
    // Re-enable LiveKit camera for sidebar preview after SRT tracks are released
    await new Promise(r => setTimeout(r, 400));
    localParticipant.setCameraEnabled(true).catch(() => {});
  }

  return (
    <div style={{ ...ST.controlRow, flexWrap: isMobile ? 'wrap' : 'nowrap', gap: isMobile ? 8 : 12 }}>
      {!isMobile && <div style={ST.confInfo}><span style={ST.confMeta}>{confMeta}</span></div>}

      <div style={{ ...ST.mediaButtons, flex: isMobile ? 1 : undefined, justifyContent: isMobile ? 'center' : undefined }}>
        <button
          onClick={() => localParticipant.setMicrophoneEnabled(!micEnabled).catch(() => {})}
          title={micEnabled ? 'Mute' : 'Unmute'}
          style={{ ...btnBase, ...(!micEnabled ? ST.mediaBtnOff : {}) }}
        >
          <span style={ST.mediaBtnIcon}>{micEnabled ? '🎤' : '🔇'}</span>
          <span style={ST.mediaBtnLabel}>{micEnabled ? 'Mute' : 'Unmuted'}</span>
        </button>
        <button
          onClick={onCameraToggle}
          title={cameraOff ? 'Cam On' : 'Cam Off'}
          style={{ ...btnBase, ...(cameraOff ? ST.mediaBtnOff : {}) }}
        >
          <span style={ST.mediaBtnIcon}>{cameraOff ? '📷' : '📹'}</span>
          <span style={ST.mediaBtnLabel}>{cameraOff ? 'Cam Off' : 'Camera'}</span>
        </button>
        <button
          onClick={onFlipCamera}
          title={facingMode === 'environment' ? 'Front cam' : 'Back cam'}
          style={btnBase}
        >
          <span style={ST.mediaBtnIcon}>🔄</span>
          <span style={ST.mediaBtnLabel}>{facingMode === 'environment' ? 'Back' : 'Front'}</span>
        </button>
      </div>

      {!streaming
        ? <button
            onClick={handleGoLive}
            disabled={starting}
            style={{ ...ST.liveBtn, ...(isMobile ? ST.liveBtnMobile : {}), opacity: starting ? 0.6 : 1 }}
          >
            {starting ? '⏳ Starting…' : '🔴 Go Live'}
          </button>
        : <button onClick={handleStop} style={{ ...ST.stopBtn, ...(isMobile ? ST.liveBtnMobile : {}) }}>
            ⏹ Stop
          </button>}
    </div>
  );
}

const ST: Record<string, React.CSSProperties> = {
  container:   { display: 'flex', height: '100vh', background: '#0d0d0d',
                 color: '#fff', fontFamily: 'system-ui, sans-serif', overflow: 'hidden' },
  mainArea:    { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 },

  header:      { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                 padding: '10px 14px', background: '#111', borderBottom: '1px solid #1e1e1e',
                 flexShrink: 0, minHeight: 48 },
  headerLeft:  { display: 'flex', alignItems: 'center', gap: 8 },
  logo:        { color: '#E24B4A', fontWeight: 700, fontSize: 14 },
  dividerDot:  { color: '#333' },
  confNameText:{ fontWeight: 600, fontSize: 13, color: '#eee', maxWidth: 200,
                 overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  roleBadge:   { background: '#2a1a1a', color: '#E24B4A', fontSize: 9, fontWeight: 700,
                 padding: '2px 7px', borderRadius: 4, border: '1px solid #4a2a2a' },
  leaveBtn:    { background: 'transparent', border: '1px solid #2a2a2a', color: '#aaa',
                 borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 12 },

  videoWrap:   { flex: 1, position: 'relative', background: '#0a0a0a',
                 display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0 },
  video:       { width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 },
  liveBadge:   { position: 'absolute', top: 12, left: 12, background: '#E24B4A',
                 color: '#fff', padding: '4px 10px', borderRadius: 6,
                 fontSize: 11, fontWeight: 700, zIndex: 10 },
  hud:         { position: 'absolute', top: 12, right: 12, background: 'rgba(0,0,0,0.75)',
                 backdropFilter: 'blur(8px)', padding: '8px 12px', borderRadius: 8,
                 zIndex: 10, display: 'flex', flexDirection: 'column', gap: 3 },
  hudItem:     { fontSize: 11, color: '#e0e0e0', fontFamily: 'monospace' },
  placeholder: { display: 'flex', flexDirection: 'column', alignItems: 'center',
                 justifyContent: 'center', position: 'absolute', inset: 0, gap: 8 },
  placeholderText: { color: '#666', fontSize: 14, fontWeight: 600, margin: 0 },
  placeholderSub:  { color: '#444', fontSize: 12, margin: 0 },

  controls:    { padding: '12px 14px', background: '#111', borderTop: '1px solid #1e1e1e', flexShrink: 0 },
  errorBox:    { background: '#200d0d', border: '1px solid #5a2020', borderRadius: 8,
                 padding: '8px 12px', color: '#E24B4A', fontSize: 12, marginBottom: 10 },
  controlRow:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  confInfo:    { flex: 1 },
  confMeta:    { color: '#555', fontSize: 11 },
  mediaButtons:{ display: 'flex', gap: 8, alignItems: 'center' },
  mediaBtn:    { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                 background: '#1e1e1e', border: '1px solid #2a2a2a', color: '#ccc',
                 borderRadius: 10, padding: '6px 12px', cursor: 'pointer', minWidth: 54 },
  mediaBtnMobile: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                    background: '#1e1e1e', border: '1px solid #2a2a2a', color: '#ccc',
                    borderRadius: 12, padding: '10px 16px', cursor: 'pointer', minWidth: 64 },
  mediaBtnOff: { background: '#3a1a1a', borderColor: '#5a2020', color: '#E24B4A' },
  mediaBtnIcon:{ fontSize: 18 },
  mediaBtnLabel: { fontSize: 9, color: '#666', fontWeight: 600, letterSpacing: '0.04em' },
  liveBtn:     { padding: '10px 22px', background: '#E24B4A', color: '#fff', border: 'none',
                 borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
  liveBtnMobile: { flex: 1, padding: '12px 0', fontSize: 15, borderRadius: 12 },
  stopBtn:     { padding: '10px 22px', background: '#2a2a2a', color: '#ccc', border: 'none',
                 borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },

  /* Mobile participant strip */
  mobileStrip: { background: '#0f0f0f', borderTop: '1px solid #1a1a1a',
                 flexShrink: 0, height: 96 },
  mobileStripEmpty: { height: '100%', display: 'flex', alignItems: 'center',
                      justifyContent: 'center', gap: 8, color: '#444', fontSize: 12 },
  mobileStripScroll: { display: 'flex', gap: 8, overflowX: 'auto', padding: '8px 10px',
                       height: '100%', alignItems: 'center',
                       scrollbarWidth: 'none' },
  stripTile:   { flexShrink: 0, width: 112, height: 72, borderRadius: 8,
                 overflow: 'hidden', position: 'relative', background: '#1a1a1a',
                 border: '1px solid #2a2a2a' },
  stripVideo:  { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  stripAvatar: { width: '100%', height: '100%', display: 'flex', alignItems: 'center',
                 justifyContent: 'center', fontSize: 22, fontWeight: 700, color: '#fff',
                 background: 'linear-gradient(135deg,#E24B4A,#a83232)' },
  stripName:   { position: 'absolute', bottom: 4, left: 5, fontSize: 9, fontWeight: 600,
                 color: '#fff', background: 'rgba(0,0,0,0.65)', padding: '2px 5px',
                 borderRadius: 3, maxWidth: '90%', overflow: 'hidden',
                 textOverflow: 'ellipsis', whiteSpace: 'nowrap' },

  /* Desktop sidebar */
  sidebar:      { width: 220, borderLeft: '1px solid #1a1a1a', display: 'flex',
                  flexDirection: 'column', background: '#0f0f0f', flexShrink: 0 },
  sidebarHeader:{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 12px', borderBottom: '1px solid #1a1a1a' },
  sidebarTitle: { fontSize: 10, fontWeight: 700, color: '#555',
                  textTransform: 'uppercase', letterSpacing: '0.08em' },
  sidebarCount: { fontSize: 10, color: '#444', background: '#1a1a1a',
                  padding: '2px 7px', borderRadius: 10 },
  selfSection:  { padding: '8px 8px 0' },
  divider:      { height: 1, background: '#1a1a1a', margin: '8px' },
  sideEmpty:    { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                  justifyContent: 'center', color: '#444', fontSize: 12, gap: 6 },
  sideList:     { display: 'flex', flexDirection: 'column', gap: 6, padding: '0 8px',
                  overflowY: 'auto', flex: 1 },
  sideTile:     { borderRadius: 8, overflow: 'hidden', border: '1px solid #1e1e1e', background: '#141414' },
  sideTileInner:{ position: 'relative', aspectRatio: '16/9' },
  sideVideo:    { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  sideAvatar:   { width: '100%', height: '100%', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', background: '#1a1a1a' },
  sideAvatarText:{ width: 32, height: 32, borderRadius: '50%',
                   background: 'linear-gradient(135deg,#E24B4A,#a83232)',
                   display: 'flex', alignItems: 'center', justifyContent: 'center',
                   fontSize: 14, fontWeight: 700, color: '#fff' },
  sideName:     { position: 'absolute', bottom: 4, left: 6, fontSize: 9, fontWeight: 600,
                  color: '#ccc', background: 'rgba(0,0,0,0.65)', padding: '2px 5px',
                  borderRadius: 3, maxWidth: '85%', overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  selfGreenDot: { position: 'absolute', top: 6, right: 6, width: 6, height: 6,
                  borderRadius: '50%', background: '#34d399' },

  center:       { height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center',
                  justifyContent: 'center', background: '#0d0d0d', color: '#fff', gap: 8, padding: 16 },
  errorCard:    { background: '#141414', border: '1px solid #2a2a2a', borderRadius: 16,
                  padding: 36, textAlign: 'center', maxWidth: 340, width: '100%',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 },
  backBtn:      { background: '#222', color: '#ccc', border: '1px solid #333',
                  borderRadius: 8, padding: '8px 20px', cursor: 'pointer', fontSize: 13 },
  spinner:      { width: 36, height: 36, border: '3px solid #222',
                  borderTop: '3px solid #E24B4A', borderRadius: '50%',
                  animation: 'spin 1s linear infinite' },
};
