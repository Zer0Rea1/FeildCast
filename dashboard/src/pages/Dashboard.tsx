import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { conferencesApi } from '../api/client';
import HLSPlayer from '../components/HLSPlayer';

interface Participant {
  id: string;
  role: string;
  status: string;
  streamId: string | null;
  bitrate: number | null;
  user: { id: string; name: string };
}

interface Conference {
  id: string;
  title: string;
  status: 'PENDING' | 'LIVE' | 'ENDED';
  participants: Participant[];
}

export default function Dashboard() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: conferences = [] } = useQuery<Conference[]>({
    queryKey: ['conferences'],
    queryFn: () => conferencesApi.list().then(r => r.data),
    refetchInterval: 5000, // poll every 5 seconds
  });

  const endConference = useMutation({
    mutationFn: (id: string) => conferencesApi.end(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conferences'] }),
  });

  const liveConferences = conferences.filter(c => c.status === 'LIVE');
  const pendingConferences = conferences.filter(c => c.status === 'PENDING');

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Live Dashboard</h1>
        <button
          onClick={() => navigate('/create')}
          style={{ background: '#E24B4A', color: '#fff', border: 'none', borderRadius: 8,
            padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          New Conference
        </button>
      </div>

      {/* Live conferences — show HLS tiles */}
      {liveConferences.length > 0 && (
        <section style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 13, color: '#888', textTransform: 'uppercase',
            letterSpacing: '0.08em', marginBottom: 14 }}>Live Now</h2>
          {liveConferences.map(conf => (
            <div key={conf.id} style={{ background: '#1a1a1a', borderRadius: 12,
              border: '1px solid #2a2a2a', padding: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', marginBottom: 14 }}>
                <div>
                  <span style={{ color: '#E24B4A', fontWeight: 700, marginRight: 8 }}>● LIVE</span>
                  <span style={{ fontWeight: 600 }}>{conf.title}</span>
                </div>
                <button
                  onClick={() => endConference.mutate(conf.id)}
                  style={{ background: 'transparent', border: '1px solid #E24B4A',
                    color: '#E24B4A', borderRadius: 6, padding: '5px 12px',
                    fontSize: 12, cursor: 'pointer' }}
                >
                  End Conference
                </button>
              </div>

              {/* Reporter HLS video tiles */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                {conf.participants
                  .filter(p => p.role === 'REPORTER' && p.streamId && p.status === 'JOINED')
                  .map(p => (
                    <HLSPlayer
                      key={p.id}
                      src={`/hls/${p.streamId}/index.m3u8`}
                      reporterName={p.user.name}
                      bitrate={p.bitrate || undefined}
                    />
                  ))}
                {conf.participants.filter(p => p.role === 'REPORTER' && p.status === 'JOINED').length === 0 && (
                  <p style={{ color: '#555', fontSize: 13 }}>Waiting for reporters to join...</p>
                )}
              </div>

              {/* Participant list */}
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                {conf.participants.map(p => (
                  <div key={p.id} style={{
                    background: p.status === 'JOINED' ? '#1D9E7520' : '#33333340',
                    border: `1px solid ${p.status === 'JOINED' ? '#1D9E75' : '#444'}`,
                    borderRadius: 6, padding: '4px 10px', fontSize: 11,
                  }}>
                    <span style={{ color: p.status === 'JOINED' ? '#1D9E75' : '#666' }}>
                      {p.role === 'ANCHOR' ? '🎤' : '📹'} {p.user.name}
                      {p.status === 'JOINED' ? ' ●' : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Pending conferences */}
      {pendingConferences.length > 0 && (
        <section>
          <h2 style={{ fontSize: 13, color: '#888', textTransform: 'uppercase',
            letterSpacing: '0.08em', marginBottom: 14 }}>Scheduled</h2>
          {pendingConferences.map(conf => (
            <div key={conf.id} style={{ background: '#1a1a1a', borderRadius: 12,
              border: '1px solid #2a2a2a', padding: 16, marginBottom: 10,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{conf.title}</div>
                <div style={{ fontSize: 12, color: '#666' }}>
                  {conf.participants.length} participant{conf.participants.length !== 1 ? 's' : ''} assigned
                </div>
              </div>
              <button
                onClick={() => navigate(`/conference/${conf.id}`)}
                style={{ background: 'transparent', border: '1px solid #444',
                  color: '#aaa', borderRadius: 6, padding: '6px 12px',
                  fontSize: 12, cursor: 'pointer' }}
              >
                Manage
              </button>
            </div>
          ))}
        </section>
      )}

      {conferences.length === 0 && (
        <div style={{ textAlign: 'center', color: '#555', marginTop: 80 }}>
          No conferences yet. Create one to get started.
        </div>
      )}
    </div>
  );
}
