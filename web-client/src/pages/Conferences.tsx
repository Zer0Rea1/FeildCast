import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { conferencesApi } from '../api/client';
import { getUser, clearAuth } from '../lib/auth';
import HLSPlayer from '../components/HLSPlayer';

interface Participant {
  id: string;
  role: string;
  status: string;
  streamId: string | null;
  bitrate: number | null;
  user: { id: string; name: string; role: string };
}

interface Conference {
  id: string;
  title: string;
  description?: string;
  status: 'PENDING' | 'LIVE' | 'ENDED';
  participants: Participant[];
}

export default function Conferences() {
  const [conferences, setConferences] = useState<Conference[]>([]);
  const [loading, setLoading]         = useState(true);
  const navigate = useNavigate();
  const user = getUser();
  const isAdmin = user?.role === 'ADMIN';

  async function load() {
    try {
      const { data } = await conferencesApi.list();
      setConferences(data);
    } catch {}
    finally { setLoading(false); }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, []);

  function handleJoin(conf: Conference) {
    if (user?.role === 'REPORTER') navigate(`/reporter/${conf.id}`);
    else if (user?.role === 'ANCHOR') navigate(`/anchor/${conf.id}`);
  }

  function logout() { clearAuth(); navigate('/login'); }

  // All live reporter streams across all conferences (admin HLS monitor)
  const liveStreams = conferences.flatMap(conf =>
    conf.participants
      .filter(p => p.role === 'REPORTER' && p.streamId && p.status === 'JOINED')
      .map(p => ({ ...p, confTitle: conf.title, confId: conf.id }))
  );

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <span style={S.logo}>● FieldCast</span>
        <div style={S.headerRight}>
          {isAdmin && (
            <>
              <button onClick={() => navigate('/admin/users')} style={S.navBtn}>
                Users
              </button>
              <button onClick={() => navigate('/admin/create')} style={S.newConfBtn}>
                + New Conference
              </button>
            </>
          )}
          <span style={S.userName}>{user?.name} · {user?.role}</span>
          <button onClick={logout} style={S.logoutBtn}>Logout</button>
        </div>
      </div>

      <div style={S.content}>

        {/* Admin: live HLS monitor */}
        {isAdmin && (
          <section style={S.hlsSection}>
            <div style={S.hlsHeader}>
              <h2 style={S.hlsTitle}>Live Monitor</h2>
              {liveStreams.length > 0 && (
                <span style={S.liveCount}>
                  <span style={{ color: '#E24B4A' }}>●</span>
                  {' '}{liveStreams.length} stream{liveStreams.length !== 1 ? 's' : ''} live
                </span>
              )}
            </div>
            {liveStreams.length === 0 ? (
              <div style={S.hlsEmpty}>
                <span style={{ fontSize: 32, marginBottom: 8 }}>📡</span>
                <p>No active streams. Waiting for reporters to go live...</p>
              </div>
            ) : (
              <div style={S.hlsGrid}>
                {liveStreams.map((p: any) => (
                  <div key={p.id}>
                    <div style={S.hlsConfLabel}>{p.confTitle}</div>
                    <HLSPlayer
                      src={`/hls/${p.streamId}/index.m3u8`}
                      reporterName={p.user.name}
                      bitrate={p.bitrate ?? undefined}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        <h1 style={S.heading}>
          {isAdmin ? 'All Conferences' : 'Your Conferences'}
        </h1>

        {loading && <p style={S.empty}>Loading...</p>}

        {!loading && conferences.length === 0 && (
          <p style={S.empty}>
            {isAdmin ? 'No conferences yet. Create one to get started.' : 'No conferences assigned yet.'}
          </p>
        )}

        {conferences.map(conf => (
          <div key={conf.id} style={S.card}>
            <div style={S.cardTop}>
              <span style={S.title}>{conf.title}</span>
              <span style={{
                ...S.badge,
                background: conf.status === 'LIVE' ? '#E24B4A'
                  : conf.status === 'ENDED' ? '#1a1a1a' : '#333',
              }}>
                {conf.status === 'LIVE' ? '● LIVE' : conf.status}
              </span>
            </div>
            {conf.description && <p style={S.desc}>{conf.description}</p>}
            <div style={S.meta}>
              {conf.participants.length} participant{conf.participants.length !== 1 ? 's' : ''}
              {conf.status === 'LIVE' && (
                <span style={S.streaming}>
                  {' · '}{conf.participants.filter(p => p.status === 'JOINED').length} joined
                </span>
              )}
            </div>
            {isAdmin ? (
              <button
                onClick={() => navigate(`/admin/conference/${conf.id}`)}
                style={S.manageBtn}
              >
                Manage →
              </button>
            ) : (
              conf.status !== 'ENDED' && (
                <button onClick={() => handleJoin(conf)} style={S.joinBtn}>
                  {user?.role === 'ANCHOR' ? 'Join as Anchor' : 'Go Live'}
                </button>
              )
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page:         { minHeight: '100vh', background: '#0a0a0a', color: '#fff',
                  fontFamily: 'system-ui, sans-serif' },
  header:       { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '14px 20px', borderBottom: '1px solid #1a1a1a', flexWrap: 'wrap', gap: 8 },
  logo:         { color: '#E24B4A', fontWeight: 700, fontSize: 18 },
  headerRight:  { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  userName:     { color: '#666', fontSize: 13 },
  logoutBtn:    { background: 'transparent', border: '1px solid #333', color: '#888',
                  borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12 },
  navBtn:       { background: 'transparent', border: '1px solid #333', color: '#aaa',
                  borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 13 },
  newConfBtn:   { background: '#E24B4A', color: '#fff', border: 'none',
                  borderRadius: 8, padding: '7px 14px', fontSize: 13,
                  fontWeight: 600, cursor: 'pointer' },
  content:      { maxWidth: 860, margin: '0 auto', padding: '24px 20px' },
  hlsSection:   { marginBottom: 32 },
  hlsHeader:    { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 },
  hlsTitle:     { fontSize: 13, fontWeight: 700, color: '#666', textTransform: 'uppercase',
                  letterSpacing: '0.08em', margin: 0 },
  liveCount:    { fontSize: 12, color: '#888' },
  hlsEmpty:     { background: '#111', border: '1px solid #1e1e1e', borderRadius: 12,
                  padding: '32px 20px', display: 'flex', flexDirection: 'column',
                  alignItems: 'center', color: '#444', fontSize: 13 },
  hlsGrid:      { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 },
  hlsConfLabel: { fontSize: 11, color: '#555', marginBottom: 4, paddingLeft: 2 },
  heading:      { fontSize: 20, fontWeight: 600, marginBottom: 16 },
  card:         { background: '#141414', border: '1px solid #222', borderRadius: 12,
                  padding: 16, marginBottom: 10 },
  cardTop:      { display: 'flex', justifyContent: 'space-between',
                  alignItems: 'center', marginBottom: 6 },
  title:        { fontWeight: 600, fontSize: 15, flex: 1, marginRight: 8 },
  badge:        { color: '#fff', fontSize: 10, fontWeight: 700,
                  padding: '3px 8px', borderRadius: 5, flexShrink: 0 },
  desc:         { color: '#666', fontSize: 13, marginBottom: 8 },
  meta:         { color: '#555', fontSize: 12, marginBottom: 12 },
  streaming:    { color: '#1D9E75' },
  joinBtn:      { background: '#E24B4A', color: '#fff', border: 'none',
                  borderRadius: 8, padding: '11px 20px', fontSize: 14,
                  fontWeight: 600, cursor: 'pointer', width: '100%' },
  manageBtn:    { background: 'transparent', color: '#aaa', border: '1px solid #2a2a2a',
                  borderRadius: 8, padding: '9px 20px', fontSize: 13,
                  fontWeight: 600, cursor: 'pointer', width: '100%' },
  empty:        { color: '#555', textAlign: 'center', marginTop: 60 },
};
