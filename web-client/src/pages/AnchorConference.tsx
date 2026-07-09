import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useIsMobile } from '../hooks/useIsMobile';
import {
  LiveKitRoom,
  VideoTrack,
  useTracks,
  useParticipants,
  RoomAudioRenderer,
  isTrackReference,
  useLocalParticipant,
  useRoomContext,
} from '@livekit/components-react';
import '@livekit/components-styles';
import { Track } from 'livekit-client';
import { conferencesApi } from '../api/client';
import { useCameraDevices } from '../hooks/useCameraDevices';

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || 'ws://localhost:7880';

type Stage = 'loading' | 'prejoin' | 'live' | 'error';

export default function AnchorConference() {
  const { id }        = useParams<{ id: string }>();
  const navigate      = useNavigate();

  // ── Hooks must all be at the top — no hooks after early returns ──
  const isMobile = useIsMobile();
  const [token, setToken]           = useState('');
  const [conference, setConference] = useState<any>(null);
  const [stage, setStage]           = useState<Stage>('loading');
  const [error, setError]           = useState('');
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const previewRef                  = useRef<HTMLVideoElement>(null);
  const previewStream               = useRef<MediaStream | null>(null);

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    return () => { previewStream.current?.getTracks().forEach(t => t.stop()); };
  }, []);

  async function load() {
    try {
      const { data: conf }   = await conferencesApi.get(id!);
      await conferencesApi.join(id!);
      const { data: tkData } = await conferencesApi.getLiveKitToken(id!);
      setConference(conf);
      setToken(tkData.token);
      setStage('prejoin');
    } catch (e: any) {
      setError(e.response?.data?.error || 'Could not join conference');
      setStage('error');
    }
  }

  async function handleJoin() {
    try {
      const md = navigator.mediaDevices;
      if (!md || typeof md.getUserMedia !== 'function') {
        setError('Camera or microphone is not supported in this browser.');
        setStage('error');
        return;
      }
      const stream = await md.getUserMedia({ video: true, audio: true });
      previewStream.current = stream;
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        previewRef.current.play();
      }
      await new Promise(r => setTimeout(r, 400));
      previewStream.current?.getTracks().forEach(t => t.stop());
      previewStream.current = null;
      setStage('live');
    } catch (e: any) {
      if (e?.name === 'NotAllowedError') {
        setError('Camera or microphone permission was denied. Please allow access and try again.');
      } else {
        setError(e?.message || 'Could not access camera/microphone');
      }
      setStage('error');
    }
  }

  /* ── Error ── */
  if (stage === 'error') {
    return (
      <div style={S.center}>
        <div style={S.card}>
          <span style={{ fontSize: 36 }}>⚠️</span>
          <p style={{ color: '#E24B4A', margin: 0, fontSize: 14 }}>{error}</p>
          <button onClick={() => navigate('/conferences')} style={S.btnSecondary}>← Go Back</button>
        </div>
      </div>
    );
  }

  /* ── Loading ── */
  if (stage === 'loading') {
    return (
      <div style={S.center}>
        <div style={S.spinner} />
        <p style={{ color: '#555', marginTop: 16, fontSize: 13 }}>Connecting to conference...</p>
      </div>
    );
  }

  /* ── Pre-join ── */
  if (stage === 'prejoin') {
    return (
      <div style={S.center}>
        <div style={{ ...S.prejoinCard, width: isMobile ? '92vw' : 380, padding: isMobile ? '28px 20px' : '36px 32px' }}>
          <div style={S.prejoinLogo}>● FieldCast</div>
          <div style={S.previewBox}>
            <video ref={previewRef} muted playsInline style={S.previewVideo} />
            <div style={S.previewOverlay}>
              <span style={{ fontSize: 36, opacity: 0.4 }}>🎥</span>
              <p style={{ color: '#444', fontSize: 12, marginTop: 8 }}>Preview appears after Join</p>
            </div>
          </div>
          <div style={S.prejoinInfo}>
            <h2 style={S.prejoinTitle}>{conference?.title}</h2>
            <p style={S.prejoinRole}>Joining as <strong style={{ color: '#34d399' }}>Anchor</strong></p>
          </div>
          <div style={S.permNote}>🔒 Browser will ask for <strong>camera & microphone</strong> access.</div>
          {error && <div style={S.errorBox}>{error}</div>}
          <button onClick={handleJoin} style={S.btnJoin}>📹 Join with Camera &amp; Mic</button>
          <button onClick={() => navigate('/conferences')} style={S.btnSecondary}>Cancel</button>
        </div>
      </div>
    );
  }

  /* ── Live ── */
  return (
    <div style={S.page}>
      <div style={S.header}>
        <div style={S.headerLeft}>
          <span style={S.logo}>● FieldCast</span>
          {!isMobile && <><span style={S.dot}>·</span><span style={S.confTitle}>{conference?.title}</span></>}
          <span style={S.roleBadge}>ANCHOR</span>
        </div>
        <button onClick={() => navigate('/conferences')} style={S.leaveBtn}>← Leave</button>
      </div>

      <LiveKitRoom
        serverUrl={LIVEKIT_URL}
        token={token}
        connect
        audio={true}
        video={true}
        style={S.room}
      >
        <RoomAudioRenderer />
        <ConferenceGrid
          isMobile={isMobile}
          selectedDeviceId={selectedDeviceId}
          onSetDeviceId={setSelectedDeviceId}
        />
      </LiveKitRoom>
    </div>
  );
}

function ConferenceGrid({
  isMobile,
  selectedDeviceId,
  onSetDeviceId,
}: {
  isMobile: boolean;
  selectedDeviceId: string;
  onSetDeviceId: (id: string) => void;
}) {
  const room = useRoomContext();
  const cameras = useCameraDevices();
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();

  // Enable camera + mic on mount
  useEffect(() => {
    localParticipant.setCameraEnabled(true).catch(() => {});
    localParticipant.setMicrophoneEnabled(true).catch(() => {});
  }, [localParticipant]);

  // Auto-select first camera once devices are enumerated
  useEffect(() => {
    if (cameras.length > 0 && !selectedDeviceId) {
      onSetDeviceId(cameras[0].deviceId);
    }
  }, [cameras]);

  const allTracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false }
  );

  const localTrack   = allTracks.find(t => t.participant.isLocal);
  const remoteTracks = allTracks.filter(
    t => !t.participant.isLocal && !t.participant.identity.endsWith('-ingress')
  );
  const meetingCount = participants.filter(p => !p.identity.endsWith('-ingress')).length;

  const cols = isMobile
    ? (remoteTracks.length <= 1 ? '1fr' : 'repeat(2, 1fr)')
    : remoteTracks.length <= 1 ? '1fr'
    : remoteTracks.length <= 4 ? 'repeat(2, 1fr)'
    : 'repeat(3, 1fr)';

  const micEnabled    = localParticipant.isMicrophoneEnabled;
  const cameraEnabled = localParticipant.isCameraEnabled;
  // Extra height when camera picker is visible
  const ctrlBarH = cameras.length > 0
    ? (isMobile ? 108 : 96)
    : (isMobile ? 72 : 64);

  function toggleMic()    { localParticipant.setMicrophoneEnabled(!micEnabled).catch(() => {}); }
  function toggleCamera() { localParticipant.setCameraEnabled(!cameraEnabled).catch(() => {}); }

  async function handleCameraChange(deviceId: string) {
    onSetDeviceId(deviceId);
    if (localParticipant.isCameraEnabled) {
      await room.switchActiveDevice('videoinput', deviceId).catch(() => {});
    }
  }

  return (
    <div style={S.roomWrapper}>

      {/* ── Participant count badge (top-left) ── */}
      <div style={S.participantBadge}>
        <span style={{ color: '#34d399', fontSize: 8 }}>●</span>
        {meetingCount} in room
      </div>

      {/* ── Reporter grid or empty state ── */}
      {remoteTracks.length === 0 ? (
        <div style={S.emptyState}>
          <div style={S.emptyIcon}>📡</div>
          <h2 style={S.emptyTitle}>Waiting for Reporters</h2>
          <p style={S.emptySub}>Reporter feeds will appear here once they join</p>
          <div style={S.emptyPulse} />
        </div>
      ) : (
        <div style={{ ...S.grid, gridTemplateColumns: cols, paddingBottom: ctrlBarH + 10 }}>
          {remoteTracks.map(track => <Tile key={track.participant.identity} track={track} />)}
        </div>
      )}

      {/* ── Anchor self-view PiP — bottom-left on mobile only ── */}
      {localTrack && isMobile && (
        <div style={{ ...S.selfView, bottom: ctrlBarH + 10, left: 12, right: 'auto' }}>
          <div style={S.selfViewInner}>
            {isTrackReference(localTrack)
              ? <VideoTrack trackRef={localTrack} style={S.selfVideo} />
              : <div style={S.selfEmpty}>👤</div>}
          </div>
          <div style={S.selfLabel}>You (Anchor)</div>
          {/* Camera-off overlay */}
          {!cameraEnabled && (
            <div style={S.selfOffOverlay}>📷</div>
          )}
        </div>
      )}

      {/* ── Controls bar — single row ── */}
      <div style={{ ...S.controlsBar, height: ctrlBarH }}>

        {/* Camera picker (left side) */}
        {cameras.length > 0 && (
          <div style={S.pickerWrap}>
            <span style={S.pickerIcon}>📷</span>
            <select
              value={selectedDeviceId}
              onChange={e => handleCameraChange(e.target.value)}
              style={S.cameraPicker}
            >
              {cameras.map(cam => (
                <option key={cam.deviceId} value={cam.deviceId}>
                  {cam.facing === 'user' ? '🤳 ' : cam.facing === 'environment' ? '📸 ' : ''}
                  {cam.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Divider */}
        {cameras.length > 0 && <div style={S.pickerDivider} />}

        {/* Mic button */}
        <button
          onClick={toggleMic}
          style={{ ...S.ctrlBtn, ...(!micEnabled ? S.ctrlBtnOff : {}) }}
          title={micEnabled ? 'Mute' : 'Unmute'}
        >
          <span style={S.ctrlIcon}>{micEnabled ? '🎤' : '🔇'}</span>
          <span style={S.ctrlLabel}>{micEnabled ? 'Mute' : 'Unmute'}</span>
        </button>

        {/* Camera button */}
        <button
          onClick={toggleCamera}
          style={{ ...S.ctrlBtn, ...(!cameraEnabled ? S.ctrlBtnOff : {}) }}
          title={cameraEnabled ? 'Camera Off' : 'Camera On'}
        >
          <span style={S.ctrlIcon}>{cameraEnabled ? '📹' : '📷'}</span>
          <span style={S.ctrlLabel}>{cameraEnabled ? 'Camera' : 'Cam Off'}</span>
        </button>

      </div>
    </div>
  );
}

function Tile({ track }: { track: any }) {
  const hasVideo = isTrackReference(track);
  const name     = track.participant.name || track.participant.identity;
  return (
    <div style={S.tile}>
      {hasVideo
        ? <VideoTrack trackRef={track} style={S.tileVideo} />
        : (
          <div style={S.tilePlaceholder}>
            <div style={S.tileAvatar}>{name.charAt(0).toUpperCase()}</div>
            <p style={S.tileAvatarName}>{name}</p>
            <p style={S.tileAvatarSub}>Camera off</p>
          </div>
        )}
      <div style={S.nameTag}>
        <span style={{ color: '#34d399', fontSize: 7 }}>●</span>
        {name}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page:         { height: '100vh', display: 'flex', flexDirection: 'column',
                  background: '#0d0d0d', color: '#fff', fontFamily: 'system-ui,sans-serif',
                  overflow: 'hidden' },
  header:       { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 16px', background: '#111', borderBottom: '1px solid #1e1e1e',
                  flexShrink: 0, minHeight: 48 },
  headerLeft:   { display: 'flex', alignItems: 'center', gap: 8 },
  logo:         { color: '#E24B4A', fontWeight: 700, fontSize: 14 },
  dot:          { color: '#333', fontSize: 16 },
  confTitle:    { fontWeight: 600, fontSize: 13, color: '#eee', maxWidth: 220,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  roleBadge:    { background: '#1a3a2a', color: '#34d399', fontSize: 9, fontWeight: 700,
                  padding: '2px 8px', borderRadius: 4, border: '1px solid #2a5a3a' },
  leaveBtn:     { background: 'transparent', border: '1px solid #2a2a2a', color: '#aaa',
                  borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13 },
  room:         { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
  roomWrapper:  { flex: 1, minHeight: 0, position: 'relative', display: 'flex',
                  flexDirection: 'column' },
  participantBadge: { position: 'absolute', top: 10, left: 12, zIndex: 20,
                      background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(8px)',
                      border: '1px solid #2a2a2a', borderRadius: 20,
                      padding: '4px 12px', fontSize: 11, color: '#888',
                      display: 'flex', alignItems: 'center', gap: 6 },
  grid:         { flex: 1, display: 'grid', gap: 4, padding: 8, alignContent: 'start',
                  overflowY: 'auto' },
  tile:         { position: 'relative', background: '#1a1a1a', borderRadius: 10,
                  overflow: 'hidden', minHeight: 120 },
  tileVideo:    { width: '100%', height: '100%', objectFit: 'cover', display: 'block',
                  minHeight: 120 },
  tilePlaceholder: { display: 'flex', flexDirection: 'column', alignItems: 'center',
                     justifyContent: 'center', minHeight: 120, gap: 8, padding: 16 },
  tileAvatar:   { width: 52, height: 52, borderRadius: '50%', fontSize: 22, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
                  background: 'linear-gradient(135deg,#E24B4A,#a83232)' },
  tileAvatarName: { color: '#ddd', fontSize: 13, fontWeight: 600, margin: 0 },
  tileAvatarSub:  { color: '#555', fontSize: 11, margin: 0 },
  nameTag:      { position: 'absolute', bottom: 8, left: 8,
                  background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
                  padding: '3px 8px', borderRadius: 6, fontSize: 10,
                  fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 },
  emptyState:   { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                  justifyContent: 'center', color: '#555', gap: 6 },
  emptyTitle:   { fontSize: 17, fontWeight: 600, color: '#ccc', margin: 0 },
  emptySub:     { fontSize: 12, color: '#444', margin: 0 },
  controlsBar:  { position: 'absolute', bottom: 0, left: 0, right: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
                  background: 'rgba(8,8,8,0.9)', backdropFilter: 'blur(12px)',
                  borderTop: '1px solid #1e1e1e', zIndex: 30 },
  ctrlBtn:      { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                  background: '#1e1e1e', border: '1px solid #2a2a2a', color: '#ccc',
                  borderRadius: 12, padding: '8px 20px', cursor: 'pointer', minWidth: 70 },
  ctrlBtnMobile:{ padding: '10px 24px', minWidth: 80 },
  ctrlBtnOff:   { background: '#3a1a1a', borderColor: '#5a2020', color: '#E24B4A' },
  cameraPicker: { flex: 1, background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#ccc',
                  borderRadius: 6, padding: '4px 8px', fontSize: 11, cursor: 'pointer',
                  outline: 'none', maxWidth: 220 },
  pickerWrap:   { display: 'flex', alignItems: 'center', gap: 6 },
  pickerIcon:   { fontSize: 13, flexShrink: 0, color: '#666' },
  pickerDivider:{ width: 1, height: 28, background: '#2a2a2a', marginInline: 6 },
  emptyIcon:    { fontSize: 52, marginBottom: 8, opacity: 0.5 },
  emptyPulse:   { width: 8, height: 8, borderRadius: '50%', background: '#34d399',
                  marginTop: 8, animation: 'pulse 2s infinite' },
  ctrlIcon:     { fontSize: 18 },
  ctrlLabel:    { fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', color: '#666' },
  mobileAvatar: { width: 40, height: 40, borderRadius: '50%', overflow: 'hidden',
                  background: '#222', border: '2px solid #333',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 18, flexShrink: 0 },
  selfView:     { position: 'absolute', bottom: 76, left: 12, width: 130, height: 84,
                  borderRadius: 10, overflow: 'hidden', border: '2px solid rgba(255,255,255,0.12)',
                  background: '#1a1a1a', zIndex: 30, boxShadow: '0 6px 24px rgba(0,0,0,0.7)' },
  selfViewInner: { width: '100%', height: '100%', position: 'relative' },
  selfOffOverlay:{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)',
                   display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 },
  selfVideo:    { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  selfEmpty:    { width: '100%', height: '100%', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 28, background: '#222' },
  selfLabel:    { position: 'absolute', bottom: 5, left: 7, fontSize: 9, color: '#ccc',
                  fontWeight: 600, background: 'rgba(0,0,0,0.65)', padding: '2px 5px', borderRadius: 3 },
  selfBadge:    { position: 'absolute', top: 5, right: 6, fontSize: 8, fontWeight: 700,
                  color: '#34d399', background: 'rgba(0,0,0,0.65)', padding: '2px 5px', borderRadius: 3 },

  /* Center / pre-join / loading */
  center:       { height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: '#0d0d0d', fontFamily: 'system-ui,sans-serif', padding: '16px' },
  card:         { background: '#141414', border: '1px solid #2a2a2a', borderRadius: 16,
                  padding: 40, textAlign: 'center', display: 'flex', flexDirection: 'column',
                  alignItems: 'center', gap: 16, maxWidth: 340, width: '100%' },
  spinner:      { width: 36, height: 36, border: '3px solid #222',
                  borderTop: '3px solid #E24B4A', borderRadius: '50%',
                  animation: 'spin 1s linear infinite' },
  prejoinCard:  { background: '#111', border: '1px solid #1e1e1e', borderRadius: 20,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
                  boxShadow: '0 20px 60px rgba(0,0,0,0.6)', maxWidth: '100%' },
  prejoinLogo:  { color: '#E24B4A', fontWeight: 700, fontSize: 16 },
  previewBox:   { width: '100%', aspectRatio: '16/9', background: '#0a0a0a',
                  borderRadius: 10, overflow: 'hidden', position: 'relative',
                  border: '1px solid #1e1e1e' },
  previewVideo: { width: '100%', height: '100%', objectFit: 'cover',
                  position: 'absolute', inset: 0, zIndex: 2 },
  previewOverlay:{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                   alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  prejoinInfo:  { textAlign: 'center', display: 'flex', flexDirection: 'column',
                  alignItems: 'center', gap: 4 },
  prejoinTitle: { fontSize: 17, fontWeight: 700, color: '#fff', margin: 0 },
  prejoinRole:  { fontSize: 13, color: '#777', margin: 0 },
  permNote:     { background: '#0a1a14', border: '1px solid #1a3a2a', borderRadius: 8,
                  padding: '10px 14px', fontSize: 12, color: '#4aaa80',
                  width: '100%', boxSizing: 'border-box', textAlign: 'center' },
  errorBox:     { background: '#1a0808', border: '1px solid #5a1a1a', borderRadius: 8,
                  padding: '10px 14px', fontSize: 12, color: '#E24B4A',
                  width: '100%', boxSizing: 'border-box', textAlign: 'center' },
  btnJoin:      { width: '100%', padding: '13px 0', background: '#E24B4A', color: '#fff',
                  border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 700,
                  cursor: 'pointer', boxShadow: '0 0 0 3px rgba(226,75,74,0.2)' },
  btnSecondary: { background: 'transparent', border: '1px solid #2a2a2a', color: '#555',
                  borderRadius: 10, padding: '8px 20px', cursor: 'pointer',
                  fontSize: 13, width: '100%' },
};
