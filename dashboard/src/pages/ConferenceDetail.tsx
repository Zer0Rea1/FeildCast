import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { conferencesApi, participantsApi, usersApi } from '../api/client';
import HLSPlayer from '../components/HLSPlayer';
import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';

const PRESETS = [
  { label: 'Studio HD',      resolution: '1920x1080', bitrate: 6000, fps: 30 },
  { label: 'Field 720p',     resolution: '1280x720',  bitrate: 2500, fps: 25 },
  { label: 'Remote 480p',    resolution: '854x480',   bitrate: 800,  fps: 20 },
  { label: 'Emergency 360p', resolution: '640x360',   bitrate: 400,  fps: 15 },
];

export default function ConferenceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [addUserId, setAddUserId]   = useState('');
  const [addRole, setAddRole]       = useState('REPORTER');
  const [addPreset, setAddPreset]   = useState(1);

  const { data: conf } = useQuery({
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
    onSuccess: () => navigate('/'),
  });

  if (!conf) return <div style={{ padding: 24, color: '#888' }}>Loading...</div>;

  const liveReporters = conf.participants.filter(
    (p: any) => p.role === 'REPORTER' && p.isLive
  );

  return (
    <div style={{ padding: 24 }}>
      <button onClick={() => navigate('/')} style={backBtn}>← Back</button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>{conf.title}</h1>
          <span style={{ ...statusBadge, background: conf.status === 'LIVE' ? '#E24B4A' : '#333' }}>
            {conf.status === 'LIVE' ? '● LIVE' : conf.status}
          </span>
          <span style={{ color: '#555', fontSize: 12, marginLeft: 10 }}>
            Created {formatDistanceToNow(new Date(conf.createdAt), { addSuffix: true })}
          </span>
        </div>
        {conf.status !== 'ENDED' && (
          <button onClick={() => endConf.mutate()} style={dangerBtn}>End Conference</button>
        )}
      </div>

      {/* Live stream tiles */}
      {liveReporters.length > 0 && (
        <section style={{ marginBottom: 32 }}>
          <h2 style={sectionTitle}>Live Streams</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {liveReporters.map((p: any) => (
              <HLSPlayer key={p.id} src={`/hls/${p.streamId}/index.m3u8`}
                reporterName={p.user.name} bitrate={p.bitrate} />
            ))}
          </div>
        </section>
      )}

      {/* Participants */}
      <section style={{ marginBottom: 28 }}>
        <h2 style={sectionTitle}>Participants</h2>
        {conf.participants.map((p: any) => (
          <div key={p.id} style={participantRow}>
            <div>
              <span style={{ fontWeight: 500 }}>{p.user.name}</span>
              <span style={{ color: '#666', fontSize: 12, marginLeft: 8 }}>
                {p.role} · {p.status}
              </span>
              {p.isLive && (
                <span style={{ color: '#1D9E75', fontSize: 11, marginLeft: 8 }}>● streaming</span>
              )}
            </div>
            {conf.status !== 'ENDED' && (
              <button onClick={() => removeParticipant.mutate(p.user.id)} style={removeBtn}>
                Remove
              </button>
            )}
          </div>
        ))}
      </section>

      {/* Add participant */}
      {conf.status !== 'ENDED' && (
        <section>
          <h2 style={sectionTitle}>Add Participant</h2>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <select value={addUserId} onChange={e => setAddUserId(e.target.value)} style={sel}>
              <option value="">Select user...</option>
              {users
                .filter((u: any) => !conf.participants.find((p: any) => p.user.id === u.id))
                .map((u: any) => (
                  <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                ))}
            </select>
            <select value={addRole} onChange={e => setAddRole(e.target.value)} style={sel}>
              <option value="REPORTER">Reporter</option>
              <option value="ANCHOR">Anchor</option>
            </select>
            {addRole === 'REPORTER' && (
              <select value={addPreset} onChange={e => setAddPreset(parseInt(e.target.value))} style={sel}>
                {PRESETS.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
              </select>
            )}
            <button
              onClick={() => addParticipant.mutate()}
              disabled={!addUserId || addParticipant.isPending}
              style={addBtn}
            >
              {addParticipant.isPending ? 'Adding...' : 'Add & Notify'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11, color: '#666', textTransform: 'uppercase',
  letterSpacing: '0.08em', marginBottom: 12,
};
const participantRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '10px 14px', background: '#141414', borderRadius: 8,
  border: '1px solid #1e1e1e', marginBottom: 6,
};
const backBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#666',
  fontSize: 14, cursor: 'pointer', marginBottom: 16, padding: 0,
};
const statusBadge: React.CSSProperties = {
  display: 'inline-block', color: '#fff', fontSize: 10, fontWeight: 700,
  padding: '3px 8px', borderRadius: 5,
};
const dangerBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #E24B4A', color: '#E24B4A',
  borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: 'pointer',
};
const removeBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #333', color: '#666',
  borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
};
const sel: React.CSSProperties = {
  background: '#1a1a1a', border: '1px solid #333', borderRadius: 8,
  color: '#fff', padding: '9px 12px', fontSize: 13,
};
const addBtn: React.CSSProperties = {
  background: '#1D9E75', border: 'none', color: '#fff',
  borderRadius: 8, padding: '9px 18px', fontSize: 13,
  fontWeight: 600, cursor: 'pointer',
};
