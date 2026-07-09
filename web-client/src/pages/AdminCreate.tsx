import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { conferencesApi, participantsApi, usersApi } from '../api/client';

const PRESETS = [
  { label: 'Studio HD',      resolution: '1920x1080', bitrate: 6000, fps: 30 },
  { label: 'Field 720p',     resolution: '1280x720',  bitrate: 2500, fps: 25 },
  { label: 'Remote 480p',    resolution: '854x480',   bitrate: 800,  fps: 20 },
  { label: 'Emergency 360p', resolution: '640x360',   bitrate: 400,  fps: 15 },
];

interface Selected { userId: string; role: string; preset: number; }

export default function AdminCreate() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle]       = useState('');
  const [desc, setDesc]         = useState('');
  const [selected, setSelected] = useState<Selected[]>([]);
  const [search, setSearch]     = useState('');
  const [filter, setFilter]     = useState<'all' | 'selected' | 'reporters' | 'anchors'>('all');

  const { data: users = [] } = useQuery<any[]>({
    queryKey: ['users'],
    queryFn: () => usersApi.list().then(r => r.data),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const { data: conf } = await conferencesApi.create(title, desc);
      for (const s of selected) {
        const p = PRESETS[s.preset];
        await participantsApi.add(
          conf.id, s.userId, s.role,
          s.role === 'REPORTER' ? p : undefined,
        );
      }
      return conf;
    },
    onSuccess: (conf) => {
      qc.invalidateQueries({ queryKey: ['conferences'] });
      navigate(`/admin/conference/${conf.id}`);
    },
  });

  function toggleUser(user: any) {
    setSelected(prev => {
      const exists = prev.find(s => s.userId === user.id);
      if (exists) return prev.filter(s => s.userId !== user.id);
      return [...prev, { userId: user.id, role: user.role === 'ANCHOR' ? 'ANCHOR' : 'REPORTER', preset: 1 }];
    });
  }

  function setRole(userId: string, role: string) {
    setSelected(prev => prev.map(s => s.userId === userId ? { ...s, role } : s));
  }

  function setPreset(userId: string, preset: number) {
    setSelected(prev => prev.map(s => s.userId === userId ? { ...s, preset } : s));
  }

  const canSubmit = title.trim() && selected.length > 0 && !createMutation.isPending;

  return (
    <div style={S.page}>
      <div style={S.header}>
        <button onClick={() => navigate('/conferences')} style={S.back}>← Back</button>
        <h1 style={S.heading}>New Conference</h1>
      </div>

      <div style={S.form}>
        <label style={S.label}>Title</label>
        <input
          value={title} onChange={e => setTitle(e.target.value)}
          placeholder="e.g. Budget 2025 Live Coverage"
          style={S.input}
        />

        <label style={S.label}>Description (optional)</label>
        <input
          value={desc} onChange={e => setDesc(e.target.value)}
          placeholder="Brief description"
          style={S.input}
        />

        <label style={S.label}>Select Participants</label>
        <p style={S.sublabel}>Each person receives a push notification immediately.</p>

        {/* Search input */}
        <div style={S.searchContainer}>
          <span style={S.searchIcon}>🔍</span>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, email, designation, or city..."
            style={S.searchInput}
          />
        </div>

        {/* Filter Tabs */}
        <div style={S.tabs}>
          {[
            { id: 'all', label: 'All', count: users.length },
            { id: 'selected', label: 'Selected', count: selected.length, isSelectedTab: true },
            { id: 'reporters', label: 'Reporters', count: users.filter(u => u.role === 'REPORTER').length },
            { id: 'anchors', label: 'Anchors', count: users.filter(u => u.role === 'ANCHOR').length },
          ].map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setFilter(t.id as any)}
              style={{ ...S.tabBtn, ...(filter === t.id ? S.tabBtnActive : {}) }}
            >
              {t.label}
              <span style={{
                ...S.badge,
                ...(filter === t.id ? S.badgeActive : {}),
                ...(t.isSelectedTab && selected.length > 0 && filter !== t.id ? { background: '#1D9E75', color: '#fff' } : {})
              }}>
                {t.count}
              </span>
            </button>
          ))}
        </div>

        {/* Participant list */}
        <div style={{ marginBottom: 24 }}>
          {(() => {
            const filtered = users.filter(user => {
              const term = search.toLowerCase();
              const matchesSearch =
                user.name.toLowerCase().includes(term) ||
                user.email.toLowerCase().includes(term) ||
                (user.designation || '').toLowerCase().includes(term) ||
                (user.city || '').toLowerCase().includes(term);

              if (!matchesSearch) return false;

              const isSel = selected.some(s => s.userId === user.id);
              if (filter === 'selected') return isSel;
              if (filter === 'reporters') return user.role === 'REPORTER';
              if (filter === 'anchors') return user.role === 'ANCHOR';
              return true;
            });

            if (filtered.length === 0) {
              return (
                <div style={{ textAlign: 'center', padding: '36px 0', color: '#444' }}>
                  <span style={{ fontSize: 24, display: 'block', marginBottom: 8 }}>👥</span>
                  No matching participants found
                </div>
              );
            }

            return filtered.map((user: any) => {
              const sel = selected.find(s => s.userId === user.id);
              return (
                <div
                  key={user.id}
                  style={{ ...S.userCard, ...(sel ? S.userCardSel : {}) }}
                >
                  <div style={S.userRow}>
                    <input
                      type="checkbox" checked={!!sel}
                      onChange={() => toggleUser(user)}
                      style={{ width: 16, height: 16, accentColor: '#1D9E75', cursor: 'pointer' }}
                    />
                    <div style={{ flex: 1, marginLeft: 10 }}>
                      <div style={S.userName}>{user.name}</div>
                      <div style={S.userEmail}>{user.email} · {user.role}</div>
                      {(user.designation || user.city) && (
                        <div style={S.meta}>
                          {user.designation && <span>💼 {user.designation}</span>}
                          {user.designation && user.city && <span style={S.metaDot}>·</span>}
                          {user.city && <span>📍 {user.city}</span>}
                        </div>
                      )}
                    </div>
                  </div>

                  {sel && (
                    <div style={S.userSettings}>
                      <div style={S.roleRow}>
                        {(['REPORTER', 'ANCHOR'] as const).map(r => (
                          <button
                            key={r}
                            onClick={() => setRole(user.id, r)}
                            style={{ ...S.roleBtn, ...(sel.role === r ? S.roleBtnActive : {}) }}
                          >
                            {r === 'REPORTER' ? '📹 Reporter' : '🎤 Anchor'}
                          </button>
                        ))}
                      </div>
                      {sel.role === 'REPORTER' && (
                        <div style={S.presetRow}>
                          {PRESETS.map((p, i) => (
                            <button
                              key={i}
                              onClick={() => setPreset(user.id, i)}
                              style={{ ...S.presetBtn, ...(sel.preset === i ? S.presetBtnActive : {}) }}
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            });
          })()}
        </div>

        {createMutation.isError && (
          <div style={S.errorBox}>Failed to create conference. Please try again.</div>
        )}

        <button onClick={() => createMutation.mutate()} disabled={!canSubmit} style={{
          ...S.createBtn, ...(!canSubmit ? S.createBtnDisabled : {})
        }}>
          {createMutation.isPending
            ? 'Creating...'
            : `Create & Notify ${selected.length} Participant${selected.length !== 1 ? 's' : ''}`}
        </button>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page:            { minHeight: '100vh', background: '#0a0a0a', color: '#fff',
                     fontFamily: 'system-ui, sans-serif' },
  header:          { display: 'flex', alignItems: 'center', gap: 16, padding: '16px 24px',
                     borderBottom: '1px solid #1a1a1a' },
  back:            { background: 'transparent', border: 'none', color: '#666',
                     fontSize: 14, cursor: 'pointer', padding: 0 },
  heading:         { fontSize: 18, fontWeight: 700, margin: 0 },
  form:            { maxWidth: 600, margin: '0 auto', padding: '24px 20px' },
  label:           { display: 'block', fontSize: 11, color: '#888', marginBottom: 6, marginTop: 16,
                     textTransform: 'uppercase', letterSpacing: '0.08em' },
  sublabel:        { color: '#555', fontSize: 12, marginBottom: 10 },
  input:           { width: '100%', background: '#141414', border: '1px solid #2a2a2a',
                     borderRadius: 8, padding: '10px 12px', color: '#fff', fontSize: 14,
                     outline: 'none' },
  userCard:        { background: '#141414', border: '1px solid #222', borderRadius: 12,
                     padding: 14, marginBottom: 8 },
  userCardSel:     { borderColor: '#1D9E75' },
  userRow:         { display: 'flex', alignItems: 'center' },
  userName:        { color: '#fff', fontSize: 14, fontWeight: 500 },
  userEmail:       { color: '#666', fontSize: 12 },
  userSettings:    { marginTop: 12, paddingTop: 12, borderTop: '1px solid #222' },
  roleRow:         { display: 'flex', gap: 8, marginBottom: 10 },
  roleBtn:         { flex: 1, border: '1px solid #2a2a2a', borderRadius: 8, padding: '7px 0',
                     background: 'transparent', color: '#666', fontSize: 12, cursor: 'pointer' },
  roleBtnActive:   { background: '#0a1e16', borderColor: '#1D9E75', color: '#1D9E75' },
  presetRow:       { display: 'flex', flexWrap: 'wrap', gap: 6 },
  presetBtn:       { border: '1px solid #2a2a2a', borderRadius: 6, padding: '5px 10px',
                     background: 'transparent', color: '#666', fontSize: 11, cursor: 'pointer' },
  presetBtnActive: { background: '#2a1010', borderColor: '#E24B4A', color: '#E24B4A' },
  errorBox:        { background: '#200d0d', border: '1px solid #5a2020', borderRadius: 8,
                     padding: '10px 14px', color: '#E24B4A', fontSize: 13, marginBottom: 14 },
  createBtn:       { width: '100%', padding: 14, background: '#E24B4A', color: '#fff',
                     border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700,
                     cursor: 'pointer', marginTop: 8 },
  createBtnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  searchInput:     { width: '100%', background: '#141414', border: '1px solid #2a2a2a',
                     borderRadius: 8, padding: '10px 12px 10px 36px', color: '#fff', fontSize: 14,
                     outline: 'none', boxSizing: 'border-box' },
  searchContainer: { position: 'relative', marginBottom: 12 },
  searchIcon:      { position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
                     color: '#555', fontSize: 14 },
  tabs:            { display: 'flex', gap: 6, marginBottom: 16, overflowX: 'auto' },
  tabBtn:          { background: 'transparent', border: '1px solid #222', borderRadius: 8,
                     padding: '6px 12px', color: '#666', fontSize: 12, fontWeight: 600,
                     cursor: 'pointer', transition: 'all 0.15s', display: 'flex', alignItems: 'center' },
  tabBtnActive:    { background: '#1e1e1e', borderColor: '#444', color: '#fff' },
  badge:           { background: '#222', color: '#666', borderRadius: 20, padding: '1px 6px',
                     fontSize: 10, marginLeft: 6 },
  badgeActive:     { background: '#E24B4A', color: '#fff' },
  meta:            { color: '#888', fontSize: 12, marginTop: 4, display: 'flex', gap: 6, alignItems: 'center' },
  metaDot:         { color: '#444' },
};
