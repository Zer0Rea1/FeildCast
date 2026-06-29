import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usersApi } from '../api/client';

interface User {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'REPORTER' | 'ANCHOR';
  createdAt: string;
}

export default function AdminUsers() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: users = [], isLoading } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: () => usersApi.list().then(r => r.data),
    refetchInterval: 15000,
  });

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) =>
      usersApi.updateRole(id, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  if (isLoading) {
    return (
      <div style={{ ...S.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={S.spinner} />
      </div>
    );
  }

  const reporters = users.filter(u => u.role === 'REPORTER');
  const anchors   = users.filter(u => u.role === 'ANCHOR');
  const admins    = users.filter(u => u.role === 'ADMIN');

  return (
    <div style={S.page}>
      <div style={S.header}>
        <button onClick={() => navigate('/conferences')} style={S.back}>← Back</button>
        <h1 style={S.heading}>User Management</h1>
        <span style={S.count}>{users.length} users</span>
      </div>

      <div style={S.content}>
        <p style={S.note}>
          New accounts register as <strong style={{ color: '#E24B4A' }}>Reporter</strong> by default.
          Promote to <strong style={{ color: '#34d399' }}>Anchor</strong> here.
        </p>

        {[
          { label: 'Reporters', items: reporters, color: '#E24B4A' },
          { label: 'Anchors',   items: anchors,   color: '#34d399' },
          { label: 'Admins',    items: admins,     color: '#888' },
        ].map(({ label, items, color }) => (
          items.length === 0 ? null : (
            <section key={label} style={S.section}>
              <h2 style={{ ...S.sectionTitle, color }}>
                {label} ({items.length})
              </h2>
              {items.map(user => (
                <div key={user.id} style={S.row}>
                  <div style={S.userInfo}>
                    <div style={S.name}>{user.name}</div>
                    <div style={S.email}>{user.email}</div>
                  </div>
                  <div style={S.roleTag} data-role={user.role}>
                    <span style={{ ...S.roleDot, background: color }} />
                    {user.role}
                  </div>
                  {user.role !== 'ADMIN' && (
                    <div style={S.actions}>
                      {user.role === 'REPORTER' ? (
                        <button
                          onClick={() => changeRole.mutate({ id: user.id, role: 'ANCHOR' })}
                          disabled={changeRole.isPending}
                          style={S.promoteBtn}
                          title="Promote to Anchor"
                        >
                          → Anchor
                        </button>
                      ) : (
                        <button
                          onClick={() => changeRole.mutate({ id: user.id, role: 'REPORTER' })}
                          disabled={changeRole.isPending}
                          style={S.demoteBtn}
                          title="Set back to Reporter"
                        >
                          → Reporter
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </section>
          )
        ))}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page:       { minHeight: '100vh', background: '#0a0a0a', color: '#fff',
                fontFamily: 'system-ui, sans-serif' },
  header:     { display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px',
                borderBottom: '1px solid #1a1a1a' },
  back:       { background: 'transparent', border: 'none', color: '#666',
                fontSize: 14, cursor: 'pointer', padding: 0 },
  heading:    { fontSize: 18, fontWeight: 700, margin: 0, flex: 1 },
  count:      { color: '#444', fontSize: 13 },
  content:    { maxWidth: 700, margin: '0 auto', padding: '24px 20px' },
  note:       { background: '#141414', border: '1px solid #222', borderRadius: 10,
                padding: '12px 16px', color: '#888', fontSize: 13, marginBottom: 28 },
  section:    { marginBottom: 28 },
  sectionTitle:{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                 letterSpacing: '0.08em', marginBottom: 10 },
  row:        { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                background: '#141414', border: '1px solid #1e1e1e', borderRadius: 10,
                marginBottom: 6 },
  userInfo:   { flex: 1 },
  name:       { fontWeight: 500, fontSize: 14 },
  email:      { color: '#555', fontSize: 12, marginTop: 2 },
  roleTag:    { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11,
                fontWeight: 700, color: '#666', textTransform: 'uppercase',
                letterSpacing: '0.05em', minWidth: 80 },
  roleDot:    { width: 6, height: 6, borderRadius: '50%' },
  actions:    { display: 'flex', gap: 6 },
  promoteBtn: { background: '#0a1e14', border: '1px solid #1D9E75', color: '#1D9E75',
                borderRadius: 8, padding: '5px 12px', fontSize: 12,
                fontWeight: 600, cursor: 'pointer' },
  demoteBtn:  { background: '#1a1010', border: '1px solid #5a2020', color: '#888',
                borderRadius: 8, padding: '5px 12px', fontSize: 12,
                fontWeight: 600, cursor: 'pointer' },
  spinner:    { width: 32, height: 32, border: '3px solid #222',
                borderTop: '3px solid #E24B4A', borderRadius: '50%',
                animation: 'spin 1s linear infinite' },
};
