import { Outlet, NavLink, useNavigate } from 'react-router-dom';

export default function Layout() {
  const navigate = useNavigate();

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#0a0a0a', color: '#fff' }}>
      {/* Sidebar */}
      <nav style={{ width: 210, background: '#111', borderRight: '1px solid #1e1e1e',
                    padding: '20px 12px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ color: '#E24B4A', fontWeight: 700, fontSize: 16,
                      marginBottom: 28, paddingLeft: 8 }}>
          ● FieldCast
        </div>
        <NavLink to="/"       end style={nav}>Dashboard</NavLink>
        <NavLink to="/create"     style={nav}>New Conference</NavLink>
        <div style={{ flex: 1 }} />
        <button onClick={() => { localStorage.removeItem('admin_token'); navigate('/login'); }}
          style={{ background: 'transparent', border: '1px solid #333', color: '#666',
                   borderRadius: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}>
          Logout
        </button>
      </nav>

      {/* Content */}
      <main style={{ flex: 1, overflowY: 'auto' }}>
        <Outlet />
      </main>
    </div>
  );
}

function nav({ isActive }: { isActive: boolean }): React.CSSProperties {
  return {
    display: 'block', padding: '9px 12px', marginBottom: 4, borderRadius: 8,
    color: isActive ? '#E24B4A' : '#888',
    background: isActive ? 'rgba(226,75,74,0.08)' : 'transparent',
    textDecoration: 'none', fontSize: 14,
  };
}
