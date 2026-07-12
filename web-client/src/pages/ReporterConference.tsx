import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useIsMobile } from '../hooks/useIsMobile';
import { useCameraDevices } from '../hooks/useCameraDevices';
import {
  LiveKitRoom,
  VideoTrack,
  useTracks,
  RoomAudioRenderer,
  isTrackReference,
  useLocalParticipant,
  useRoomContext,
} from '@livekit/components-react';
import '@livekit/components-styles';
import { Track } from 'livekit-client';
import { conferencesApi } from '../api/client';
import { getToken } from '../lib/auth';
import { SrtStreamer, getCameraStream } from '../lib/wsStream';

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || 'ws://localhost:7880';

// The backend rejects a reconnect with "Stream already active" if the
// *previous* connection died silently (flaky network, no clean close) —
// its server-side heartbeat needs up to ~30s to notice and clear the stale
// session. Retry through that window instead of surfacing a hard error.
const MAX_STALE_RETRIES    = 5;
const STALE_RETRY_DELAY_MS = 7000;

// Auto-pick dual mode default from the connection type.
// Dual = publish camera to LiveKit AND SRT at once (2x uplink).
// WiFi/ethernet/unknown → ON. Cellular / slow link → OFF (protect the air feed).
function detectDualDefault(): boolean {
  const c = (navigator as any).connection;
  if (!c) return true; // API unsupported (iOS Safari) → allow; user can turn off
  if (c.type === 'cellular') return false;
  if (['slow-2g', '2g', '3g'].includes(c.effectiveType)) return false;
  return true;
}

export default function ReporterConference() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const isMobile = useIsMobile();
  const [conference, setConference]         = useState<any>(null);
  const [streaming, setStreaming]           = useState(false);
  const [, setStreamId]                     = useState('');
  const [bytesSent, setBytesSent]           = useState(0);
  const [duration, setDuration]             = useState(0);
  const [error, setError]                   = useState('');
  const [lkToken, setLkToken]               = useState('');
  const [cameraOff, setCameraOff]           = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [dualMode, setDualMode]             = useState<boolean>(detectDualDefault());
  const [streamSettings, setStreamSettings] = useState({
    resolution: '1280x720', bitrate: 2500, fps: 25,
  });

  const videoRef      = useRef<HTMLVideoElement>(null);
  const streamerRef   = useRef<SrtStreamer | null>(null);
  const streamRef     = useRef<MediaStream | null>(null);
  const timerRef      = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // Tracks whether the *running* stream is dual (LiveKit-owned tracks) — so we
  // never stop LiveKit's camera/mic when tearing down the SRT side.
  const dualActiveRef = useRef(false);
  const retryCountRef   = useRef(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    load();
    return () => {
      clearInterval(timerRef.current);
      clearTimeout(retryTimeoutRef.current);
      streamerRef.current?.stop();
      // In dual mode the tracks belong to LiveKit; LiveKitRoom unmount cleans them up.
      if (!dualActiveRef.current) {
        streamRef.current?.getTracks().forEach(t => t.stop());
      }
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

  // Core: wire an SRT streamer to a given MediaStream.
  // dual=true means the tracks are LiveKit's (shared capture) — don't own/stop them here.
  async function beginStream(stream: MediaStream, dual: boolean) {
    setError('');
    dualActiveRef.current = dual;
    streamRef.current = stream;
    if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); }
    try {
      const token = getToken()!;
      const streamer = new SrtStreamer({
        onReady: (sid) => {
          retryCountRef.current = 0;
          setStreamId(sid); setStreaming(true);
          timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
        },
        onError: (msg) => {
          clearInterval(timerRef.current);
          const isStaleLock = /already (active|streaming)/i.test(msg);
          if (isStaleLock && retryCountRef.current < MAX_STALE_RETRIES) {
            retryCountRef.current++;
            setStreaming(false);
            setError(`Reconnecting… (${retryCountRef.current}/${MAX_STALE_RETRIES})`);
            retryTimeoutRef.current = setTimeout(() => beginStream(stream, dual), STALE_RETRY_DELAY_MS);
            return;
          }
          setError(msg); setStreaming(false);
        },
        onStats:  (bytes) => setBytesSent(bytes),
        onDisconnect: () => { setStreaming(false); clearInterval(timerRef.current); },
      });
      streamerRef.current = streamer;
      await streamer.start(token, id!, stream, streamSettings.bitrate, dual);
    } catch (e: any) {
      setError(e.name === 'NotAllowedError' ? 'Camera/mic permission denied.' : e.message || 'Failed to start');
    }
  }

  // Solo capture — opens the camera ourselves (SRT-only path).
  // When a specific deviceId is selected use it; otherwise fall back to 'environment'.
  function getSoloStream(deviceId: string) {
    return getCameraStream(
      streamSettings.resolution,
      streamSettings.fps,
      'environment',  // facingMode hint, ignored when deviceId is provided
      deviceId || undefined,
    );
  }

  // Tear down the SRT side. Only stop tracks we own (solo). Dual tracks stay live in LiveKit.
  function endStream() {
    clearTimeout(retryTimeoutRef.current);
    retryCountRef.current = 0;
    streamerRef.current?.stop();
    if (!dualActiveRef.current) {
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    }
    streamRef.current = null;
    clearInterval(timerRef.current);
    setStreaming(false); setDuration(0); setBytesSent(0);
  }

  function stopStream() { endStream(); setCameraOff(false); }

  function leave() { stopStream(); navigate('/conferences'); }

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  /* ── Error ── */
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

  /* ── Loading ── */
  if (!lkToken || !conference) {
    return (
      <div style={ST.center}>
        <div style={ST.spinner} />
        <p style={{ color: '#888', marginTop: 16, fontSize: 14 }}>Joining conference...</p>
      </div>
    );
  }

  /* ── Props shared between desktop + mobile ── */
  const ctrlBarProps = {
    streaming, cameraOff, isMobile, selectedDeviceId, dualMode,
    streamRef,          // needed so control bar can mute SRT audio/video tracks
    confMeta: `${streamSettings.resolution} · ${streamSettings.bitrate} kbps`,
    onBeginStream: beginStream,
    onEndStream: endStream,
    onGetSoloStream: getSoloStream,
    onSetDeviceId: setSelectedDeviceId,
    onSetDualMode: setDualMode,
    onStopStream: stopStream,
    onSetCameraOff: setCameraOff,   // let control bar update this state
    onError: setError,
  };

  /* ══════════════════════════════════════════════════
     MOBILE LAYOUT — matches the Discord-VC sketch:
       [SRT preview]   top, fixed height
       [Participant tiles]  scrollable middle
       [Controls]      bottom, two rows
  ══════════════════════════════════════════════════ */
  if (isMobile) {
    return (
      <LiveKitRoom
        serverUrl={LIVEKIT_URL} token={lkToken}
        connect audio video
        options={{ videoCaptureDefaults: { facingMode: 'environment', resolution: { width: 1280, height: 720, frameRate: 25 } } }}
        style={ST.mobileRoot}
      >
        <RoomAudioRenderer />

        {/* ── 1. SRT Broadcast preview (top card) ─────────────── */}
        <div style={ST.mobilePreviewCard}>
          <video ref={videoRef} muted playsInline style={ST.mobilePreviewVideo} />

          {/* overlay header */}
          <div style={ST.mobileOverlayHeader}>
            <div style={ST.mobileHeaderLeft}>
              <span style={ST.mobileLogo}>● FieldCast</span>
              <span style={ST.mobileRoleBadge}>REPORTER</span>
            </div>
            <button onClick={leave} style={ST.mobileLeaveBtn}>✕</button>
          </div>

          {/* LIVE badge */}
          {streaming && <div style={ST.mobileLiveBadge}>🔴 LIVE</div>}

          {/* HUD */}
          {streaming && (
            <div style={ST.mobileHud}>
              <span style={ST.mobileHudItem}>{fmt(duration)}</span>
              <span style={ST.mobileHudSep}>·</span>
              <span style={ST.mobileHudItem}>{(bytesSent / 1e6).toFixed(1)} MB</span>
            </div>
          )}

          {/* Placeholder when not streaming */}
          {!streaming && (
            <div style={ST.mobilePreviewPlaceholder}>
              <span style={{ fontSize: 38, marginBottom: 6 }}>📹</span>
              <span style={ST.mobilePreviewLabel}>SRT BROADCAST</span>
              <span style={{ fontSize: 11, color: '#555', marginTop: 2 }}>{conference.title}</span>
            </div>
          )}

          {/* Streaming label over the video */}
          {streaming && (
            <div style={ST.mobileStreamLabel}>
              <span style={{ color: '#aaa', fontSize: 10 }}>SRT BROADCAST</span>
              <span style={{ color: '#555', fontSize: 10 }}>· {conference.title}</span>
            </div>
          )}

          {/* ── Self-view PiP — bottom-right corner of the SRT card ── */}
          <MobileSelfPip streaming={streaming} streamRef={streamRef} />
        </div>

        {/* ── 2. Participant tiles (scrollable middle) ─────────── */}
        <MobileRoomGrid />

        {/* ── 3. Controls (two-row bottom bar) ─────────────────── */}
        <div style={ST.mobileControlsWrap}>
          {error && <div style={ST.mobileErrorBox}>{error}</div>}
          <ReporterControlBar {...ctrlBarProps} />
        </div>
      </LiveKitRoom>
    );
  }

  /* ══════════════════════════════════════════
     DESKTOP LAYOUT — side by side (unchanged)
  ══════════════════════════════════════════ */
  return (
    <LiveKitRoom
      serverUrl={LIVEKIT_URL} token={lkToken}
      connect audio video
      style={ST.container}
    >
      <RoomAudioRenderer />

      <div style={ST.mainArea}>
        <div style={ST.header}>
          <div style={ST.headerLeft}>
            <span style={ST.logo}>● FieldCast</span>
            <span style={ST.dividerDot}>·</span>
            <span style={ST.confNameText}>{conference?.title}</span>
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
              <span style={ST.hudItem}>{streamSettings.bitrate} kbps</span>
            </div>
          )}
          {!streaming && (
            <div style={ST.placeholder}>
              <span style={{ fontSize: 52 }}>📹</span>
              <p style={ST.placeholderText}>SRT Broadcast</p>
              <p style={ST.placeholderSub}>Click "Go Live" to start streaming</p>
            </div>
          )}
        </div>

        <div style={ST.controls}>
          {error && <div style={ST.errorBox}>{error}</div>}
          <ReporterControlBar {...ctrlBarProps} />
        </div>
      </div>

      <MeetingSidebar />
    </LiveKitRoom>
  );
}

/* ═══════════════════════════════════════════════════════════
   MOBILE PARTICIPANT GRID — stacked cards (Discord VC style)
═══════════════════════════════════════════════════════════ */
function MobileRoomGrid() {
  const allTracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false }
  );
  const remoteTracks = allTracks.filter(
    t => !t.participant.isLocal && !t.participant.identity.endsWith('-ingress')
  );

  return (
    <div style={ST.mobileRoomGrid}>
      {/* Section header */}
      <div style={ST.mobileRoomHeader}>
        <span style={ST.mobileRoomTitle}>Meeting Room</span>
        <span style={ST.mobileRoomCount}>
          {remoteTracks.length} {remoteTracks.length === 1 ? 'person' : 'people'}
        </span>
      </div>

      {remoteTracks.length === 0 ? (
        <div style={ST.mobileRoomEmpty}>
          <span style={{ fontSize: 30, marginBottom: 8 }}>👥</span>
          <span style={{ color: '#444', fontSize: 13 }}>Waiting for others to join…</span>
        </div>
      ) : (
        <div style={ST.mobileCardList}>
          {remoteTracks.map(track => (
            <MobileParticipantCard key={track.participant.identity} track={track} />
          ))}
        </div>
      )}
    </div>
  );
}

function MobileParticipantCard({ track }: { track: any }) {
  const hasVideo = isTrackReference(track);
  const name     = track.participant.name || track.participant.identity;

  return (
    <div style={ST.mobileCard}>
      {hasVideo ? (
        <VideoTrack trackRef={track} style={ST.mobileCardVideo} />
      ) : (
        <div style={ST.mobileCardAvatar}>
          <div style={ST.mobileAvatarCircle}>{name.charAt(0).toUpperCase()}</div>
          <span style={ST.mobileAvatarName}>{name}</span>
          <span style={ST.mobileAvatarSub}>Camera off</span>
        </div>
      )}
      {/* Gradient name bar at bottom */}
      <div style={ST.mobileCardNameBar}>
        <span style={{ color: '#34d399', fontSize: 8 }}>●  </span>
        <span style={ST.mobileCardName}>{name}</span>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════
   DESKTOP SIDEBAR
═════════════════════════════════════════ */
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

/* ═════════════════════════════════════════════════════════════
   CONTROL BAR — desktop: single row | mobile: icon row + main btn
═════════════════════════════════════════════════════════════ */
function ReporterControlBar({
  streaming, cameraOff, isMobile, selectedDeviceId, dualMode, confMeta,
  streamRef,
  onBeginStream, onEndStream, onGetSoloStream, onSetDeviceId, onSetDualMode,
  onStopStream, onSetCameraOff, onError,
}: {
  streaming: boolean; cameraOff: boolean; isMobile: boolean;
  selectedDeviceId: string; dualMode: boolean; confMeta: string;
  streamRef: React.RefObject<MediaStream | null>;
  onBeginStream: (stream: MediaStream, dual: boolean) => Promise<void>;
  onEndStream: () => void;
  onGetSoloStream: (deviceId: string) => Promise<MediaStream>;
  onSetDeviceId: (id: string) => void;
  onSetDualMode: (v: boolean) => void;
  onStopStream: () => void;
  onSetCameraOff: (off: boolean | ((prev: boolean) => boolean)) => void;
  onError: (msg: string) => void;
}) {
  const room = useRoomContext();
  const cameras = useCameraDevices();
  const { localParticipant } = useLocalParticipant();
  const micEnabled = localParticipant.isMicrophoneEnabled;
  const camEnabled = localParticipant.isCameraEnabled;
  const [starting, setStarting] = useState(false);
  const isSwitchingRef = useRef(false);
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  // Auto-select the first camera once devices are enumerated
  useEffect(() => {
    if (cameras.length > 0 && !selectedDeviceId) {
      onSetDeviceId(cameras[0].deviceId);
    }
  }, [cameras]);

  // ── Unified mic toggle ──
  // Mutes/unmutes LiveKit conference AND the SRT audio track simultaneously.
  async function handleMicToggle() {
    const nextEnabled = !micEnabled;
    // Toggle LiveKit conference mic
    await localParticipant.setMicrophoneEnabled(nextEnabled).catch(() => {});
    // Mirror to the SRT stream's audio track (dual or solo) if active
    if (streaming && streamRef.current) {
      streamRef.current.getAudioTracks().forEach(t => { t.enabled = nextEnabled; });
    }
  }

  // ── Unified camera toggle ──
  // Coordinates LiveKit camera + SRT video track so both go on/off together.
  async function handleCameraToggle() {
    const nextOn = !camEnabled;

    if (!streaming) {
      // Not streaming — just toggle LiveKit's camera (the SRT preview isn't running).
      await localParticipant.setCameraEnabled(nextOn).catch(() => {});
    } else if (dualMode) {
      // Dual mode: LiveKit owns the track; toggle it, then mirror to SRT stream.
      await localParticipant.setCameraEnabled(nextOn).catch(() => {});
      if (streamRef.current) {
        streamRef.current.getVideoTracks().forEach(t => { t.enabled = nextOn; });
      }
    } else {
      // Solo mode: LiveKit camera is already off; only toggle the SRT video track.
      if (streamRef.current) {
        streamRef.current.getVideoTracks().forEach(t => { t.enabled = nextOn; });
      }
    }

    onSetCameraOff(!nextOn);
  }

  // Poll until LiveKit has actually published the local camera track — setCameraEnabled()
  // can resolve slightly before the publication + mediaStreamTrack are attached.
  async function waitForCameraTrack(timeoutMs = 4000): Promise<MediaStreamTrack> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const t = localParticipant.getTrackPublication(Track.Source.Camera)?.track?.mediaStreamTrack;
      if (t && t.readyState === 'live') return t;
      await sleep(100);
    }
    throw new Error('Camera did not become ready in time — try again.');
  }

  // Build a MediaStream from LiveKit's already-published camera + mic tracks (dual mode).
  async function buildStreamFromLk(): Promise<MediaStream> {
    const videoTrack = await waitForCameraTrack();
    const audioTrack = localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
    return new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack]);
  }

  // Build LiveKit camera constraints from the selected device
  function lkCameraOpts() {
    return selectedDeviceId
      ? { deviceId: selectedDeviceId }
      : {};
  }

  async function handleGoLive() {
    setStarting(true);
    onError('');
    try {
      if (dualMode) {
        // Reuse LiveKit's single camera capture for SRT too — no second getUserMedia.
        if (!localParticipant.isCameraEnabled) {
          await localParticipant.setCameraEnabled(true, lkCameraOpts());
        }
        if (!localParticipant.isMicrophoneEnabled) {
          await localParticipant.setMicrophoneEnabled(true);
        }
        await onBeginStream(await buildStreamFromLk(), true);
      } else {
        // Solo: release LiveKit's camera, open our own for SRT.
        if (localParticipant.isCameraEnabled) {
          await localParticipant.setCameraEnabled(false);
          await sleep(350);
        }
        const s = await onGetSoloStream(selectedDeviceId);
        await onBeginStream(s, false);
      }
    } catch (e: any) {
      onError(e?.message || 'Failed to go live — try again.');
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    onStopStream();
    if (!dualMode) {
      // Solo: give the SRT camera time to release, then re-enable LiveKit's for the self-view.
      await sleep(400);
      localParticipant.setCameraEnabled(true, lkCameraOpts()).catch(() => {});
    }
    // Dual: leave LiveKit camera running — reporter stays visible in the conference.
  }

  // Switch camera mid-stream or pre-stream.
  // Uses isSwitchingRef to prevent overlapping switches causing device conflicts.
  async function handleCameraChange(deviceId: string) {
    if (isSwitchingRef.current) return;  // ignore rapid clicks
    isSwitchingRef.current = true;
    onSetDeviceId(deviceId);
    onError('');

    try {
      if (!streaming) {
        // Not live — just update LiveKit's active videoinput device if camera is enabled.
        if (localParticipant.isCameraEnabled) {
          await room.switchActiveDevice('videoinput', deviceId);
        }
        return;
      }

      // Live — stop SRT first, then switch, then restart.
      // This ensures the old device is fully released before the new one opens.
      onEndStream();
      await sleep(350);  // let MediaRecorder + WebSocket close cleanly

      if (dualMode) {
        // Dual: LiveKit owns the camera — tell it to switch active device under the hood.
        await room.switchActiveDevice('videoinput', deviceId);
        await sleep(250);  // give LiveKit track time to re-initialize
        const stream = await buildStreamFromLk();
        await onBeginStream(stream, true);
      } else {
        // Solo: LiveKit's camera is already off — just open the new device directly.
        const s = await onGetSoloStream(deviceId);
        await onBeginStream(s, false);
      }
    } catch (e: any) {
      onError(e?.message || 'Failed to switch camera — try again.');
    } finally {
      isSwitchingRef.current = false;
    }
  }

  /* ── Mobile: two-row layout ── */
  if (isMobile) {
    return (
      <>
        {/* Camera picker dropdown */}
        {cameras.length > 1 && (
          <div style={ST.cameraPickerWrap}>
            <span style={ST.cameraPickerIcon}>📷</span>
            <select
              value={selectedDeviceId}
              onChange={e => handleCameraChange(e.target.value)}
              style={ST.cameraPicker}
            >
              {cameras.map(cam => (
                <option key={cam.deviceId} value={cam.deviceId}>
                  {cam.facing === 'user' ? '🤳 ' : cam.facing === 'environment' ? '📸 ' : '📷 '}
                  {cam.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Row 1: icon buttons */}
        <div style={ST.mobileIconRow}>
          <button
            onClick={handleMicToggle}
            style={{ ...ST.mobileIconBtn, ...(!micEnabled ? ST.mobileIconBtnOff : {}) }}
            title={micEnabled ? 'Mute' : 'Unmute'}
          >
            <span style={ST.mobileIconEmoji}>{micEnabled ? '🎤' : '🔇'}</span>
            <span style={ST.mobileIconLabel}>{micEnabled ? 'Mute' : 'Unmuted'}</span>
          </button>

          <button
            onClick={handleCameraToggle}
            style={{ ...ST.mobileIconBtn, ...(cameraOff ? ST.mobileIconBtnOff : {}) }}
            title={cameraOff ? 'Camera On' : 'Camera Off'}
          >
            <span style={ST.mobileIconEmoji}>{cameraOff ? '📷' : '📹'}</span>
            <span style={ST.mobileIconLabel}>{cameraOff ? 'Cam Off' : 'Camera'}</span>
          </button>

          <button
            onClick={() => onSetDualMode(!dualMode)}
            disabled={streaming}
            style={{ ...ST.mobileIconBtn, ...(dualMode ? ST.dualOn : {}), opacity: streaming ? 0.5 : 1 }}
            title={dualMode ? 'Publishing to conference + SRT' : 'SRT only (conference via server)'}
          >
            <span style={ST.mobileIconEmoji}>{dualMode ? '🔗' : '🔌'}</span>
            <span style={ST.mobileIconLabel}>{dualMode ? 'Dual' : 'SRT'}</span>
          </button>
        </div>

        {/* Row 2: main action */}
        {!streaming ? (
          <button
            onClick={handleGoLive} disabled={starting}
            style={{ ...ST.mobileLiveBtn, opacity: starting ? 0.6 : 1 }}
          >
            {starting ? '⏳  Starting…' : dualMode ? '🔴  Go Live (Dual)' : '🔴  Go Live'}
          </button>
        ) : (
          <button onClick={handleStop} style={ST.mobileStopBtn}>
            ⏹  Stop Broadcasting
          </button>
        )}
      </>
    );
  }

  /* ── Desktop: single row ── */
  return (
    <div style={ST.desktopControlsWrap}>
      {/* Camera picker */}
      {cameras.length > 0 && (
        <div style={ST.cameraPickerWrap}>
          <span style={ST.cameraPickerIcon}>📷</span>
          <select
            value={selectedDeviceId}
            onChange={e => handleCameraChange(e.target.value)}
            style={ST.cameraPicker}
          >
            {cameras.map(cam => (
              <option key={cam.deviceId} value={cam.deviceId}>
                {cam.facing === 'user' ? '🤳 ' : cam.facing === 'environment' ? '📸 ' : '📷 '}
                {cam.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div style={ST.controlRow}>
        <div style={ST.confInfo}><span style={ST.confMeta}>{confMeta}</span></div>
        <div style={ST.mediaButtons}>
          <button
            onClick={handleMicToggle}
            style={{ ...ST.mediaBtn, ...(!micEnabled ? ST.mediaBtnOff : {}) }}
          >
            {micEnabled ? '🎤' : '🔇'}
            <span style={ST.mediaBtnLabel}>{micEnabled ? 'Mute' : 'Unmuted'}</span>
          </button>
          <button
            onClick={handleCameraToggle}
            style={{ ...ST.mediaBtn, ...(cameraOff ? ST.mediaBtnOff : {}) }}
          >
            {cameraOff ? '📷' : '📹'}
            <span style={ST.mediaBtnLabel}>{cameraOff ? 'Cam Off' : 'Camera'}</span>
          </button>
          <button
            onClick={() => onSetDualMode(!dualMode)}
            disabled={streaming}
            style={{ ...ST.mediaBtn, ...(dualMode ? ST.dualOn : {}), opacity: streaming ? 0.5 : 1 }}
            title={dualMode ? 'Publishing to conference + SRT' : 'SRT only (conference via server)'}
          >
            {dualMode ? '🔗' : '🔌'}
            <span style={ST.mediaBtnLabel}>{dualMode ? 'Dual' : 'SRT'}</span>
          </button>
        </div>
        {!streaming
          ? <button onClick={handleGoLive} disabled={starting}
              style={{ ...ST.liveBtn, opacity: starting ? 0.6 : 1 }}>
              {starting ? '⏳ Starting…' : dualMode ? '🔴 Go Live (Dual)' : '🔴 Go Live'}
            </button>
          : <button onClick={handleStop} style={ST.stopBtn}>⏹ Stop</button>}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MOBILE SELF-VIEW PIP
   Shows reporter's own camera in the bottom-right of the SRT card.
   Before Go Live → LiveKit local track. During streaming → SRT stream.
═══════════════════════════════════════════════════════════════════ */
function MobileSelfPip({
  streaming,
  streamRef,
}: {
  streaming: boolean;
  streamRef: React.RefObject<MediaStream | null>;
}) {
  const pipRef = useRef<HTMLVideoElement>(null);
  const allTracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false }
  );
  const localTrack = allTracks.find(t => t.participant.isLocal);

  // When streaming starts, mirror the SRT stream into the pip video element
  useEffect(() => {
    if (streaming && streamRef.current && pipRef.current) {
      pipRef.current.srcObject = streamRef.current;
      pipRef.current.play().catch(() => {});
    }
    if (!streaming && pipRef.current) {
      pipRef.current.srcObject = null;
    }
  }, [streaming, streamRef.current]);

  return (
    <div style={ST.selfPip}>
      {streaming ? (
        // SRT stream mirror
        <video
          ref={pipRef}
          muted
          playsInline
          autoPlay
          style={ST.selfPipMedia}
        />
      ) : localTrack && isTrackReference(localTrack) ? (
        // LiveKit local track (before Go Live)
        <VideoTrack trackRef={localTrack} style={ST.selfPipMedia} />
      ) : (
        <div style={ST.selfPipFallback}>👤</div>
      )}
      <div style={ST.selfPipLabel}>You</div>
    </div>
  );
}

/* ═══════════════════
   STYLES
═══════════════════ */
const ST: Record<string, React.CSSProperties> = {

  /* ── Loading / error screens ── */
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

  /* ══════════════════════════════════════
     MOBILE LAYOUT STYLES
  ══════════════════════════════════════ */

  mobileRoot:   { height: '100vh', display: 'flex', flexDirection: 'column',
                  background: '#0d0d0d', color: '#fff', fontFamily: 'system-ui, sans-serif',
                  overflow: 'hidden' },

  /* SRT preview card */
  mobilePreviewCard: {
    position: 'relative', height: '40vh', flexShrink: 0,
    background: '#111', overflow: 'hidden',
    borderBottomLeftRadius: 20, borderBottomRightRadius: 20,
    boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
  },
  mobilePreviewVideo: {
    width: '100%', height: '100%', objectFit: 'cover', display: 'block',
  },
  mobileOverlayHeader: {
    position: 'absolute', top: 0, left: 0, right: 0,
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 14px',
    background: 'linear-gradient(to bottom, rgba(0,0,0,0.6), transparent)',
    zIndex: 10,
  },
  mobileHeaderLeft: { display: 'flex', alignItems: 'center', gap: 8 },
  mobileLogo:       { color: '#E24B4A', fontWeight: 700, fontSize: 13 },
  mobileRoleBadge:  { background: '#2a1a1a', color: '#E24B4A', fontSize: 8, fontWeight: 700,
                      padding: '2px 7px', borderRadius: 4, border: '1px solid #4a2a2a' },
  mobileLeaveBtn:   { background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.15)',
                      color: '#ccc', borderRadius: 8, padding: '5px 11px',
                      cursor: 'pointer', fontSize: 13, backdropFilter: 'blur(6px)' },
  mobileLiveBadge:  { position: 'absolute', top: 46, left: 14, background: '#E24B4A',
                      color: '#fff', padding: '4px 10px', borderRadius: 6,
                      fontSize: 11, fontWeight: 700, zIndex: 10,
                      boxShadow: '0 0 0 3px rgba(226,75,74,0.25)' },
  mobileHud:        { position: 'absolute', top: 46, right: 14,
                      background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(8px)',
                      padding: '5px 10px', borderRadius: 8, zIndex: 10,
                      display: 'flex', alignItems: 'center', gap: 6 },
  mobileHudItem:    { fontSize: 11, color: '#e0e0e0', fontFamily: 'monospace' },
  mobileHudSep:     { color: '#444' },
  mobilePreviewPlaceholder: {
    position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  mobilePreviewLabel: { color: '#555', fontSize: 10, fontWeight: 700,
                        letterSpacing: '0.1em', textTransform: 'uppercase' },
  mobileStreamLabel:  { position: 'absolute', bottom: 12, left: 14, display: 'flex',
                        alignItems: 'center', gap: 6, zIndex: 10 },

  /* Self-view PiP */
  selfPip:          { position: 'absolute', bottom: 12, right: 12, zIndex: 20,
                      width: 88, height: 52, borderRadius: 10, overflow: 'hidden',
                      border: '2px solid rgba(255,255,255,0.15)',
                      boxShadow: '0 2px 12px rgba(0,0,0,0.7)',
                      background: '#111' },
  selfPipMedia:     { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  selfPipFallback:  { width: '100%', height: '100%', display: 'flex',
                      alignItems: 'center', justifyContent: 'center',
                      fontSize: 20, background: '#1a1a1a' },
  selfPipLabel:     { position: 'absolute', bottom: 3, left: 6, fontSize: 8,
                      fontWeight: 700, color: 'rgba(255,255,255,0.7)',
                      letterSpacing: '0.04em', textTransform: 'uppercase' },

  /* Participant grid */
  mobileRoomGrid:   { flex: 1, overflowY: 'auto', padding: '12px 14px',
                      display: 'flex', flexDirection: 'column' },
  mobileRoomHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      marginBottom: 10 },
  mobileRoomTitle:  { fontSize: 10, color: '#555', fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '0.08em' },
  mobileRoomCount:  { fontSize: 10, color: '#444', background: '#1a1a1a',
                      padding: '2px 8px', borderRadius: 10 },
  mobileRoomEmpty:  { flex: 1, display: 'flex', flexDirection: 'column',
                      alignItems: 'center', justifyContent: 'center', gap: 8, color: '#444' },
  mobileCardList:   { display: 'flex', flexDirection: 'column', gap: 10 },
  mobileCard:       { position: 'relative', width: '100%', aspectRatio: '16/9',
                      background: '#1a1a1a', borderRadius: 16, overflow: 'hidden',
                      border: '1px solid #2a2a2a',
                      boxShadow: '0 2px 12px rgba(0,0,0,0.4)' },
  mobileCardVideo:  { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  mobileCardAvatar: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
                      alignItems: 'center', justifyContent: 'center', gap: 8 },
  mobileAvatarCircle: { width: 52, height: 52, borderRadius: '50%', fontSize: 22, fontWeight: 700,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
                        background: 'linear-gradient(135deg,#E24B4A,#a83232)' },
  mobileAvatarName: { color: '#ddd', fontSize: 14, fontWeight: 600 },
  mobileAvatarSub:  { color: '#555', fontSize: 11 },
  mobileCardNameBar: { position: 'absolute', bottom: 0, left: 0, right: 0,
                       padding: '24px 12px 10px',
                       background: 'linear-gradient(transparent, rgba(0,0,0,0.75))',
                       display: 'flex', alignItems: 'center', gap: 4 },
  mobileCardName:   { color: '#fff', fontSize: 13, fontWeight: 600 },

  /* Controls wrap */
  mobileControlsWrap: { flexShrink: 0, background: '#111',
                         borderTopLeftRadius: 20, borderTopRightRadius: 20,
                         padding: '14px 14px 20px',
                         boxShadow: '0 -4px 20px rgba(0,0,0,0.5)' },
  mobileErrorBox:   { background: '#200d0d', border: '1px solid #5a2020', borderRadius: 10,
                      padding: '8px 12px', color: '#E24B4A', fontSize: 12, marginBottom: 10 },

  /* Mobile icon buttons row */
  mobileIconRow:    { display: 'flex', gap: 10, justifyContent: 'center',
                      marginBottom: 10 },
  mobileIconBtn:    { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                      flex: 1, background: '#1e1e1e', border: '1px solid #2a2a2a',
                      color: '#ccc', borderRadius: 14, padding: '10px 0', cursor: 'pointer' },
  mobileIconBtnOff: { background: '#3a1a1a', borderColor: '#5a2020', color: '#E24B4A' },
  dualOn:           { background: '#0f2a1e', borderColor: '#1D9E75', color: '#34d399' },
  mobileIconEmoji:  { fontSize: 20 },
  mobileIconLabel:  { fontSize: 9, color: '#666', fontWeight: 700,
                      letterSpacing: '0.05em', textTransform: 'uppercase' },

  /* Mobile main action buttons */
  mobileLiveBtn:    { width: '100%', padding: '14px 0', background: '#E24B4A', color: '#fff',
                      border: 'none', borderRadius: 14, fontSize: 16, fontWeight: 700,
                      cursor: 'pointer', letterSpacing: '0.02em',
                      boxShadow: '0 0 0 4px rgba(226,75,74,0.2)' },
  mobileStopBtn:    { width: '100%', padding: '14px 0', background: '#2a2a2a', color: '#ccc',
                      border: 'none', borderRadius: 14, fontSize: 16, fontWeight: 600,
                      cursor: 'pointer' },

  /* ══════════════════════════════════════
     DESKTOP LAYOUT STYLES (unchanged)
  ══════════════════════════════════════ */

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
  controlRow:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  confInfo:    { flex: 1 },
  confMeta:    { color: '#555', fontSize: 11 },
  mediaButtons:{ display: 'flex', gap: 8, alignItems: 'center' },
  mediaBtn:    { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                 background: '#1e1e1e', border: '1px solid #2a2a2a', color: '#ccc',
                 borderRadius: 10, padding: '6px 12px', cursor: 'pointer', minWidth: 54 },
  mediaBtnOff: { background: '#3a1a1a', borderColor: '#5a2020', color: '#E24B4A' },
  mediaBtnLabel: { fontSize: 9, color: '#666', fontWeight: 600, letterSpacing: '0.04em' },
  liveBtn:     { padding: '10px 22px', background: '#E24B4A', color: '#fff', border: 'none',
                 borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
  stopBtn:     { padding: '10px 22px', background: '#2a2a2a', color: '#ccc', border: 'none',
                 borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },

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

  /* ── Camera picker (desktop + mobile) ── */
  desktopControlsWrap: {
    padding: '0 14px 12px',
    background: '#111',
    borderTop: '1px solid #1e1e1e',
    flexShrink: 0,
  },
  cameraPickerWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 0 8px',
    borderBottom: '1px solid #1e1e1e',
    marginBottom: 8,
  },
  cameraPickerIcon: {
    fontSize: 14,
    flexShrink: 0,
  },
  cameraPicker: {
    flex: 1,
    background: '#1e1e1e',
    border: '1px solid #2a2a2a',
    color: '#ccc',
    borderRadius: 8,
    padding: '5px 10px',
    fontSize: 12,
    cursor: 'pointer',
    outline: 'none',
    appearance: 'auto' as const,
  },
};
