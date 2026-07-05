import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { conferencesApi, participantsApi, usersApi } from '../api/client';
import HLSPlayer from '../components/HLSPlayer';
import AdminBroadcastMonitor from '../components/AdminBroadcastMonitor';

interface StreamInfo {
  reporterName: string;
  streamId:     string | null;
  status:       string;
  resolution:   string | null;
  bitrate:      number | null;
  srtUrl:       string | null;
}

const PRESETS = [
  { label: 'Studio HD',      resolution: '1920x1080', bitrate: 6000, fps: 30 },
  { label: 'Field 720p',     resolution: '1280x720',  bitrate: 2500, fps: 25 },
  { label: 'Remote 480p',    resolution: '854x480',   bitrate: 800,  fps: 20 },
  { label: 'Emergency 360p', resolution: '640x360',   bitrate: 400,  fps: 15 },
];

export default function AdminConferenceDetail() {
  const { id }    = useParams<{ id: string }>();
  const navigate  = useNavigate();
  const qc        = useQueryClient();
  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole]     = useState('REPORTER');
  const [addPreset, setAddPreset] = useState(1);
  const [copied, setCopied]       = useState<string | null>(null);

  const { data: conf, isLoading } = useQuery({
    queryKey: ['conference', id],
    queryFn: () => conferencesApi.get(id!).then(r => r.data),
    refetchInterval: 5000,
  });

  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list().then(r => r.data),
  });

  const addParticipant = useMutation({
    mutationFn: () => {
      const preset = PRESETS[addPreset];
      return participantsApi.add(id!, addUserId, addRole,
        addRole === 'REPORTER' ? preset : undefined);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conference', id] });
      setAddUserId('');
    },
  });

  const removeParticipant = useMutation({
    mutationFn: (userId: string) => participantsApi.remove(id!, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conference', id] }),
  });

  const endConf = useMutation({
    mutationFn: () => conferencesApi.end(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conferences'] });
      navigate('/conferences');
    },
  });

  const { data: streamsData } = useQuery({
    queryKey: ['streams', id],
    queryFn: () => conferencesApi.getStreams(id!).then(r => r.data),
    refetchInterval: 5000,
    enabled: !!id,
  });

  function copyToClipboard(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  if (isLoading || !conf) {
    return <div style={{ ...S.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={S.spinner} />
    </div>;
  }

  const liveReporters = conf.participants.filter(
    (p: any) => p.role === 'REPORTER' && p.streamId && p.status === 'JOINED'
  );
  const availableUsers = users.filter(
    (u: any) => !conf.participants.find((p: any) => p.user?.id === u.id)
  );

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <button onClick={() => navigate('/conferences')} style={S.back}>← Back</button>
        <div style={S.headerInfo}>
          <h1 style={S.heading}>{conf.title}</h1>
          <span style={{
            ...S.statusBadge,
            background: conf.status === 'LIVE' ? '#E24B4A' : conf.status === 'ENDED' ? '#222' : '#333',
          }}>
            {conf.status === 'LIVE' ? '● LIVE' : conf.status}
          </span>
          <span style={S.createdAt}>
            {formatDistanceToNow(new Date(conf.createdAt), { addSuffix: true })}
          </span>
        </div>
        {conf.status !== 'ENDED' && (
          <button
            onClick={() => { if (confirm('End this conference?')) endConf.mutate(); }}
            style={S.endBtn}
          >
            End Conference
          </button>
        )}
      </div>

      <div style={S.content}>
        {/* Director Feed — admin joins LiveKit room so reporters/anchors see them */}
        {conf.status !== 'ENDED' && (
          <AdminBroadcastMonitor confId={id!} />
        )}

        {/* Live HLS tiles — always show this section when conference is active */}
        {conf.status !== 'ENDED' && (
          <section style={S.section}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <h2 style={S.sectionTitle}>Live Streams</h2>
              {liveReporters.length > 0 && (
                <span style={{ fontSize: 11, color: '#E24B4A', fontWeight: 700 }}>
                  ● {liveReporters.length} active
                </span>
              )}
            </div>
            {liveReporters.length === 0 ? (
              <div style={S.hlsEmpty}>
                <span style={{ fontSize: 36, marginBottom: 8 }}>📡</span>
                <p style={{ margin: 0, color: '#555', fontSize: 13 }}>
                  Waiting for reporters to start streaming...
                </p>
                <p style={{ margin: '6px 0 0', color: '#444', fontSize: 11 }}>
                  Streams appear here automatically when reporters go live
                </p>
              </div>
            ) : (
              <div style={S.hlsGrid}>
                {liveReporters.map((p: any) => (
                  <HLSPlayer
                    key={p.id}
                    src={`/hls/${p.streamId}/index.m3u8`}
                    reporterName={p.user.name}
                    bitrate={p.bitrate}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {/* SRT Stream URLs for playout systems */}
        {streamsData && (
          <section style={S.section}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
              <h2 style={S.sectionTitle}>SRT Stream URLs</h2>
              <span style={{ fontSize: 11, color: '#444' }}>
                for OBS · vMix · Caspar · FFmpeg playout
              </span>
              <span style={{ fontSize: 11, color: '#555', marginLeft: 'auto' }}>
                Server: <code style={{ color: '#888', fontSize: 11 }}>{streamsData.srtServer}</code>
              </span>
            </div>

            {streamsData.streams.length === 0 ? (
              <div style={S.streamEmpty}>
                No reporters assigned yet.
              </div>
            ) : (
              <div style={S.streamTable}>
                {/* Header */}
                <div style={S.streamRowHead}>
                  <span>Reporter</span>
                  <span>Status</span>
                  <span>Quality</span>
                  <span>Stream ID</span>
                  <span>SRT URL (copy → paste into playout)</span>
                </div>

                {(streamsData.streams as StreamInfo[]).map((s, i) => {
                  const isActive = s.status === 'JOINED' && !!s.streamId;
                  const urlKey   = `url-${i}`;
                  const idKey    = `id-${i}`;
                  return (
                    <div key={i} style={{ ...S.streamRow, ...(isActive ? S.streamRowActive : {}) }}>

                      {/* Reporter name */}
                      <span style={S.streamName}>{s.reporterName}</span>

                      {/* Status */}
                      <span style={{ ...S.streamStatus, color: isActive ? '#1D9E75' : '#555' }}>
                        {isActive ? '● LIVE' : s.status}
                      </span>

                      {/* Quality */}
                      <span style={S.streamMeta}>
                        {s.resolution ?? '—'}
                        {s.bitrate ? ` · ${s.bitrate}k` : ''}
                      </span>

                      {/* Stream ID */}
                      <div style={S.streamIdWrap}>
                        <code style={S.streamIdCode}>
                          {s.streamId ?? 'not started'}
                        </code>
                        {s.streamId && (
                          <button
                            onClick={() => copyToClipboard(s.streamId!, idKey)}
                            style={S.copyBtn}
                            title="Copy stream ID"
                          >
                            {copied === idKey ? '✓' : '⎘'}
                          </button>
                        )}
                      </div>

                      {/* Full SRT URL */}
                      <div style={S.streamUrlWrap}>
                        {s.srtUrl ? (
                          <>
                            <code style={{ ...S.streamIdCode, color: isActive ? '#7dd3c8' : '#555', flex: 1 }}>
                              {s.srtUrl}
                            </code>
                            <button
                              onClick={() => copyToClipboard(s.srtUrl!, urlKey)}
                              style={{ ...S.copyBtn, ...(isActive ? S.copyBtnActive : {}) }}
                              title="Copy SRT URL"
                            >
                              {copied === urlKey ? '✓ Copied' : '⎘ Copy'}
                            </button>
                          </>
                        ) : (
                          <span style={{ color: '#444', fontSize: 11 }}>
                            Stream not started
                          </span>
                        )}
                      </div>

                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* Participants */}
        <section style={S.section}>
          <h2 style={S.sectionTitle}>Participants ({conf.participants.length})</h2>
          {conf.participants.map((p: any) => (
            <div key={p.id} style={S.participantRow}>
              <div>
                <span style={S.participantName}>{p.user.name}</span>
                <span style={S.participantMeta}>
                  {p.role} · {p.status}
                </span>
                {p.streamId && (
                  <span style={S.streaming}>● streaming</span>
                )}
              </div>
              {conf.status !== 'ENDED' && (
                <button
                  onClick={() => removeParticipant.mutate(p.user.id)}
                  disabled={removeParticipant.isPending}
                  style={S.removeBtn}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </section>

        {/* Add participant */}
        {conf.status !== 'ENDED' && availableUsers.length > 0 && (
          <section style={S.section}>
            <h2 style={S.sectionTitle}>Add Participant</h2>
            <div style={S.addRow}>
              <select value={addUserId} onChange={e => setAddUserId(e.target.value)} style={S.sel}>
                <option value="">Select user...</option>
                {availableUsers.map((u: any) => (
                  <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                ))}
              </select>
              <select value={addRole} onChange={e => setAddRole(e.target.value)} style={S.sel}>
                <option value="REPORTER">Reporter</option>
                <option value="ANCHOR">Anchor</option>
              </select>
              {addRole === 'REPORTER' && (
                <select value={addPreset} onChange={e => setAddPreset(parseInt(e.target.value))} style={S.sel}>
                  {PRESETS.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
                </select>
              )}
              <button
                onClick={() => addParticipant.mutate()}
                disabled={!addUserId || addParticipant.isPending}
                style={S.addBtn}
              >
                {addParticipant.isPending ? 'Adding...' : 'Add & Notify'}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page:            { minHeight: '100vh', background: '#0a0a0a', color: '#fff',
                     fontFamily: 'system-ui, sans-serif' },
  header:          { display: 'flex', alignItems: 'center', gap: 16, padding: '14px 24px',
                     borderBottom: '1px solid #1a1a1a', flexWrap: 'wrap' },
  back:            { background: 'transparent', border: 'none', color: '#666',
                     fontSize: 14, cursor: 'pointer', padding: 0, flexShrink: 0 },
  headerInfo:      { flex: 1, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  heading:         { fontSize: 18, fontWeight: 700, margin: 0 },
  statusBadge:     { color: '#fff', fontSize: 10, fontWeight: 700,
                     padding: '3px 8px', borderRadius: 5 },
  createdAt:       { color: '#555', fontSize: 12 },
  endBtn:          { background: 'transparent', border: '1px solid #E24B4A', color: '#E24B4A',
                     borderRadius: 8, padding: '7px 16px', fontSize: 13, cursor: 'pointer',
                     flexShrink: 0 },
  content:         { maxWidth: 900, margin: '0 auto', padding: '24px 20px' },
  section:         { marginBottom: 32 },
  sectionTitle:    { fontSize: 11, color: '#555', textTransform: 'uppercase',
                     letterSpacing: '0.08em', marginBottom: 12 },
  hlsGrid:         { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 },
  hlsEmpty:        { background: '#0d0d0d', border: '1px dashed #222', borderRadius: 12,
                     padding: '32px 20px', display: 'flex', flexDirection: 'column',
                     alignItems: 'center' },
  participantRow:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                     padding: '10px 14px', background: '#141414', borderRadius: 8,
                     border: '1px solid #1e1e1e', marginBottom: 6 },
  participantName: { fontWeight: 500, marginRight: 8 },
  participantMeta: { color: '#666', fontSize: 12 },
  streaming:       { color: '#1D9E75', fontSize: 11, marginLeft: 8 },
  removeBtn:       { background: 'transparent', border: '1px solid #2a2a2a', color: '#666',
                     borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer' },
  addRow:          { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' },
  sel:             { background: '#141414', border: '1px solid #2a2a2a', borderRadius: 8,
                     color: '#fff', padding: '9px 12px', fontSize: 13 },
  addBtn:          { background: '#1D9E75', border: 'none', color: '#fff',
                     borderRadius: 8, padding: '9px 18px', fontSize: 13,
                     fontWeight: 600, cursor: 'pointer' },
  spinner:         { width: 36, height: 36, border: '3px solid #222',
                     borderTop: '3px solid #E24B4A', borderRadius: '50%',
                     animation: 'spin 1s linear infinite' },

  /* Stream URLs panel */
  streamEmpty:     { color: '#444', fontSize: 13, padding: '12px 0' },
  streamTable:     { display: 'flex', flexDirection: 'column', gap: 4 },
  streamRowHead:   { display: 'grid',
                     gridTemplateColumns: '130px 80px 120px 200px 1fr',
                     gap: 10, padding: '6px 14px',
                     fontSize: 9, color: '#555', fontWeight: 700,
                     textTransform: 'uppercase', letterSpacing: '0.08em' },
  streamRow:       { display: 'grid',
                     gridTemplateColumns: '130px 80px 120px 200px 1fr',
                     gap: 10, padding: '10px 14px',
                     background: '#0f0f0f', border: '1px solid #1a1a1a',
                     borderRadius: 8, alignItems: 'center' },
  streamRowActive: { background: '#0a140f', borderColor: '#1a3a2a' },
  streamName:      { fontWeight: 600, fontSize: 13, color: '#ddd',
                     overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  streamStatus:    { fontSize: 11, fontWeight: 700 },
  streamMeta:      { fontSize: 11, color: '#555', fontFamily: 'monospace' },
  streamIdWrap:    { display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' },
  streamIdCode:    { fontSize: 10, color: '#666', fontFamily: 'monospace',
                     background: '#141414', padding: '3px 7px', borderRadius: 4,
                     overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                     maxWidth: '100%' },
  streamUrlWrap:   { display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', minWidth: 0 },
  copyBtn:         { flexShrink: 0, background: '#1e1e1e', border: '1px solid #2a2a2a',
                     color: '#888', borderRadius: 6, padding: '4px 10px',
                     fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' },
  copyBtnActive:   { background: '#0a1e14', borderColor: '#1D9E75', color: '#1D9E75' },
};
