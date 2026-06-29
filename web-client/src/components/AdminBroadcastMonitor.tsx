/**
 * AdminBroadcastMonitor
 *
 * Admin selects a camera + microphone, clicks "Go Live in Room",
 * and joins the conference's LiveKit room as a "Director" participant.
 * Every reporter and anchor in the room sees/hears the admin's feed
 * as a regular participant tile — giving reporters live channel feedback.
 */

import { useEffect, useRef, useState } from 'react';
import {
  LiveKitRoom,
  VideoTrack,
  useLocalParticipant,
  useTracks,
} from '@livekit/components-react';
import '@livekit/components-styles';
import { Track } from 'livekit-client';
import { conferencesApi } from '../api/client';

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || 'ws://localhost:7880';

interface Props {
  confId: string;
}

type Stage = 'idle' | 'live';

export default function AdminBroadcastMonitor({ confId }: Props) {
  const [stage, setStage]             = useState<Stage>('idle');
  const [lkToken, setLkToken]         = useState('');
  const [cameras, setCameras]         = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics]               = useState<MediaDeviceInfo[]>([]);
  const [selectedCam, setSelectedCam] = useState('');
  const [selectedMic, setSelectedMic] = useState('');
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [error, setError]             = useState('');
  const [joining, setJoining]         = useState(false);
  const previewRef = useRef<HTMLVideoElement>(null);

  // Enumerate devices (requires prior getUserMedia permission)
  async function loadDevices() {
    try {
      const temp = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      temp.getTracks().forEach(t => t.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter(d => d.kind === 'videoinput');
      const mics = devices.filter(d => d.kind === 'audioinput');
      setCameras(cams);
      setMics(mics);
      if (cams.length) setSelectedCam(prev => prev || cams[0].deviceId);
      if (mics.length) setSelectedMic(prev => prev || mics[0].deviceId);
    } catch {
      setError('Camera or microphone access denied.');
    }
  }

  // Start local preview with selected devices
  async function startPreview(camId: string, micId: string) {
    if (previewStream) previewStream.getTracks().forEach(t => t.stop());
    setPreviewStream(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: camId ? { deviceId: { exact: camId } } : true,
        audio: micId ? { deviceId: { exact: micId } } : true,
      });
      setPreviewStream(stream);
      if (previewRef.current) previewRef.current.srcObject = stream;
      setError('');
    } catch {
      setError('Could not open selected devices.');
    }
  }

  useEffect(() => { loadDevices(); }, []);

  useEffect(() => {
    if (stage === 'idle' && (selectedCam || selectedMic)) {
      startPreview(selectedCam, selectedMic);
    }
  }, [selectedCam, selectedMic, stage]);

  // Cleanup preview on unmount or when going live
  useEffect(() => {
    return () => { previewStream?.getTracks().forEach(t => t.stop()); };
  }, [previewStream]);

  async function joinRoom() {
    setError(''); setJoining(true);
    try {
      const { data } = await conferencesApi.getLiveKitToken(confId);
      // Release the preview — LiveKit will re-capture with the selected devices
      previewStream?.getTracks().forEach(t => t.stop());
      setPreviewStream(null);
      setLkToken(data.token);
      setStage('live');
    } catch (e: any) {
      setError(e.response?.data?.error || 'Could not join room.');
    } finally {
      setJoining(false);
    }
  }

  function leaveRoom() {
    setLkToken('');
    setStage('idle');
    // Restart preview after leaving
    setTimeout(() => startPreview(selectedCam, selectedMic), 300);
  }

  return (
    <div style={S.wrap}>
      <div style={S.titleRow}>
        <h2 style={S.title}>Director Feed</h2>
        <span style={S.hint}>
          Your camera &amp; mic will appear live to all reporters and anchors in the room
        </span>
      </div>

      <div style={S.body}>
        {/* ── Video preview ── */}
        <div style={S.videoBox}>
          {stage === 'idle' ? (
            <>
              {/* Mirrored local preview (like ingest.html self-view) */}
              <video
                ref={previewRef}
                autoPlay
                playsInline
                muted
                style={S.previewVideo}
              />
              {!previewStream && !error && (
                <div style={S.videoOverlay}>
                  <span style={{ fontSize: 32 }}>🎥</span>
                  <p style={{ color: '#555', fontSize: 13, marginTop: 8 }}>
                    Select camera to preview
                  </p>
                </div>
              )}
            </>
          ) : (
            <LiveKitRoom
              serverUrl={LIVEKIT_URL}
              token={lkToken}
              connect
              audio={{ deviceId: selectedMic || undefined } as any}
              video={{ deviceId: selectedCam || undefined } as any}
              style={{ width: '100%', height: '100%' }}
            >
              <DirectorSelfView onLeave={leaveRoom} />
            </LiveKitRoom>
          )}
        </div>

        {/* ── Controls ── */}
        <div style={S.controls}>
          <div style={S.field}>
            <label style={S.label}>Camera</label>
            <select
              value={selectedCam}
              onChange={e => setSelectedCam(e.target.value)}
              style={S.select}
              disabled={stage === 'live'}
            >
              {cameras.length === 0 && <option value="">Loading...</option>}
              {cameras.map(d => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Camera ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </div>

          <div style={S.field}>
            <label style={S.label}>Microphone</label>
            <select
              value={selectedMic}
              onChange={e => setSelectedMic(e.target.value)}
              style={S.select}
              disabled={stage === 'live'}
            >
              {mics.length === 0 && <option value="">Loading...</option>}
              {mics.map(d => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Mic ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </div>

          {error && <div style={S.errorBox}>{error}</div>}

          {stage === 'idle' ? (
            <button
              onClick={joinRoom}
              disabled={joining || cameras.length === 0}
              style={{ ...S.btn, ...(joining || cameras.length === 0 ? S.btnDisabled : {}) }}
            >
              {joining ? '⏳ Joining...' : '📡 Go Live in Room'}
            </button>
          ) : (
            <button onClick={leaveRoom} style={{ ...S.btn, ...S.btnLeave }}>
              ⏹ Leave Room
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Rendered inside LiveKitRoom — shows the director's self-view + LIVE badge */
function DirectorSelfView({ onLeave: _onLeave }: { onLeave: () => void }) {
  const { localParticipant } = useLocalParticipant();
  const allTracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false }
  );
  const localTrack = allTracks.find(t => t.participant.isLocal);

  const micOn = localParticipant.isMicrophoneEnabled;
  const camOn = localParticipant.isCameraEnabled;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {localTrack && localTrack.publication?.track ? (
        <VideoTrack
          trackRef={localTrack}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <div style={S.videoOverlay}>
          <span style={{ fontSize: 32 }}>👤</span>
          <p style={{ color: '#555', fontSize: 13, marginTop: 8 }}>Camera connecting...</p>
        </div>
      )}

      {/* LIVE badge */}
      <div style={S.liveBadge}>📡 LIVE IN ROOM</div>

      {/* Mute toggles */}
      <div style={S.inRoomControls}>
        <button
          onClick={() => localParticipant.setMicrophoneEnabled(!micOn).catch(() => {})}
          style={{ ...S.miniBtn, ...(!micOn ? S.miniBtnOff : {}) }}
          title={micOn ? 'Mute mic' : 'Unmute mic'}
        >
          {micOn ? '🎤' : '🔇'}
        </button>
        <button
          onClick={() => localParticipant.setCameraEnabled(!camOn).catch(() => {})}
          style={{ ...S.miniBtn, ...(!camOn ? S.miniBtnOff : {}) }}
          title={camOn ? 'Turn camera off' : 'Turn camera on'}
        >
          {camOn ? '📹' : '📷'}
        </button>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap:       { background: '#0d1117', border: '1px solid #1e2a1e', borderRadius: 12,
                padding: 20, marginBottom: 32 },
  titleRow:   { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16,
                flexWrap: 'wrap' },
  title:      { fontSize: 11, color: '#1D9E75', textTransform: 'uppercase',
                letterSpacing: '0.08em', fontWeight: 700, margin: 0 },
  hint:       { fontSize: 11, color: '#444' },
  body:       { display: 'grid', gridTemplateColumns: '1fr 220px', gap: 16,
                alignItems: 'start' },
  videoBox:   { position: 'relative', aspectRatio: '16/9', background: '#0a0a0a',
                borderRadius: 10, overflow: 'hidden', border: '1px solid #1e1e1e' },
  previewVideo:{ width: '100%', height: '100%', objectFit: 'cover',
                 transform: 'scaleX(-1)', display: 'block' },
  videoOverlay:{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                 alignItems: 'center', justifyContent: 'center' },
  liveBadge:  { position: 'absolute', top: 10, left: 10, background: '#1D9E75',
                color: '#fff', fontSize: 10, fontWeight: 700, padding: '4px 10px',
                borderRadius: 6, letterSpacing: '0.04em',
                boxShadow: '0 0 0 3px rgba(29,158,117,0.25)' },
  inRoomControls: { position: 'absolute', bottom: 10, right: 10,
                    display: 'flex', gap: 6 },
  miniBtn:    { background: 'rgba(0,0,0,0.7)', border: '1px solid #333',
                borderRadius: 8, padding: '6px 10px', cursor: 'pointer',
                fontSize: 14, color: '#fff', backdropFilter: 'blur(8px)' },
  miniBtnOff: { background: 'rgba(226,75,74,0.3)', borderColor: '#E24B4A' },
  controls:   { display: 'flex', flexDirection: 'column', gap: 12 },
  field:      { display: 'flex', flexDirection: 'column', gap: 5 },
  label:      { fontSize: 10, color: '#555', textTransform: 'uppercase',
                letterSpacing: '0.07em', fontWeight: 700 },
  select:     { background: '#141414', border: '1px solid #2a2a2a', borderRadius: 8,
                color: '#fff', padding: '9px 10px', fontSize: 12, outline: 'none' },
  errorBox:   { background: '#1a0808', border: '1px solid #5a1a1a', borderRadius: 8,
                padding: '8px 12px', color: '#E24B4A', fontSize: 11 },
  btn:        { padding: '11px 0', background: '#1D9E75', color: '#fff', border: 'none',
                borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                marginTop: 'auto' },
  btnDisabled:{ opacity: 0.45, cursor: 'not-allowed' },
  btnLeave:   { background: '#2a2a2a', color: '#aaa' },
};
