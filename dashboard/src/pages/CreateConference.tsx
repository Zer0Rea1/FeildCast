import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { conferencesApi, participantsApi, usersApi } from '../api/client';

const QUALITY_PRESETS = [
  { label: 'Studio HD', resolution: '1920x1080', bitrate: 6000, fps: 30 },
  { label: 'Field 720p', resolution: '1280x720',  bitrate: 2500, fps: 25 },
  { label: 'Remote 480p', resolution: '854x480',  bitrate: 800,  fps: 20 },
  { label: 'Emergency 360p', resolution: '640x360', bitrate: 400, fps: 15 },
];

export default function CreateConference() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<{ userId: string; role: string; preset: number }[]>([]);

  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list().then(r => r.data),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      // 1. Create conference
      const { data: conf } = await conferencesApi.create(title, description);
      // 2. Add each selected participant — server sends push notification automatically
      for (const s of selected) {
        const preset = QUALITY_PRESETS[s.preset];
        await participantsApi.add(conf.id, s.userId, s.role,
          s.role === 'REPORTER' ? preset : undefined);
      }
      return conf;
    },
    onSuccess: (conf) => {
      qc.invalidateQueries({ queryKey: ['conferences'] });
      navigate(`/conference/${conf.id}`);
    },
  });

  function toggleUser(userId: string, role: string) {
    setSelected(prev => {
      const exists = prev.find(s => s.userId === userId);
      if (exists) return prev.filter(s => s.userId !== userId);
      return [...prev, { userId, role, preset: 1 }]; // default Field 720p
    });
  }

  function setPreset(userId: string, preset: number) {
    setSelected(prev => prev.map(s => s.userId === userId ? { ...s, preset } : s));
  }

  return (
    <div style={{ maxWidth: 640, padding: 24 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>New Conference</h1>

      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Conference Title</label>
        <input value={title} onChange={e => setTitle(e.target.value)}
          placeholder="e.g. Live from Islamabad — Budget 2025"
          style={inputStyle} />
      </div>
      <div style={{ marginBottom: 24 }}>
        <label style={labelStyle}>Description (optional)</label>
        <input value={description} onChange={e => setDescription(e.target.value)}
          placeholder="Brief description"
          style={inputStyle} />
      </div>

      <label style={labelStyle}>Select Participants</label>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
        Each selected user will receive a push notification immediately.
      </p>

      <div style={{ marginBottom: 24 }}>
        {users.map((user: any) => {
          const sel = selected.find(s => s.userId === user.id);
          return (
            <div key={user.id} style={{ background: sel ? '#1D9E7515' : '#1a1a1a',
              border: `1px solid ${sel ? '#1D9E75' : '#2a2a2a'}`, borderRadius: 10,
              padding: 14, marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="checkbox" checked={!!sel}
                  onChange={() => toggleUser(user.id, user.role)}
                  style={{ width: 16, height: 16, accentColor: '#1D9E75' }} />
                <div>
                  <div style={{ fontWeight: 500 }}>{user.name}</div>
                  <div style={{ fontSize: 11, color: '#666' }}>{user.email} · {user.role}</div>
                </div>
                {sel && (
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                    {/* Role selector */}
                    <select value={sel.role}
                      onChange={e => setSelected(prev => prev.map(s =>
                        s.userId === user.id ? { ...s, role: e.target.value } : s))}
                      style={{ ...inputStyle, padding: '4px 8px', fontSize: 11 }}>
                      <option value="REPORTER">Reporter</option>
                      <option value="ANCHOR">Anchor</option>
                    </select>
                    {/* Quality preset — only for reporters */}
                    {sel.role === 'REPORTER' && (
                      <select value={sel.preset}
                        onChange={e => setPreset(user.id, parseInt(e.target.value))}
                        style={{ ...inputStyle, padding: '4px 8px', fontSize: 11 }}>
                        {QUALITY_PRESETS.map((p, i) => (
                          <option key={i} value={i}>{p.label}</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <button
        onClick={() => createMutation.mutate()}
        disabled={!title || selected.length === 0 || createMutation.isPending}
        style={{ background: '#E24B4A', color: '#fff', border: 'none', borderRadius: 10,
          padding: '12px 24px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
          opacity: (!title || selected.length === 0) ? 0.5 : 1 }}
      >
        {createMutation.isPending ? 'Creating...' : `Create & Notify ${selected.length} Participant${selected.length !== 1 ? 's' : ''}`}
      </button>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 11, color: '#888', marginBottom: 6,
  textTransform: 'uppercase', letterSpacing: '0.06em',
};

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1a1a1a', border: '1px solid #333',
  borderRadius: 8, padding: '10px 12px', color: '#fff', fontSize: 13,
};
