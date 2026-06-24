import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api/client';

export default function Login() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const navigate = useNavigate();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const { data } = await authApi.login(email, password);
      if (data.user.role !== 'ADMIN') {
        setError('This dashboard is for admin accounts only');
        return;
      }
      localStorage.setItem('admin_token', data.token);
      navigate('/');
    } catch (e: any) {
      setError(e.response?.data?.error || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', background: '#0a0a0a' }}>
      <form onSubmit={handleLogin} style={{ background: '#141414', padding: 40,
        borderRadius: 16, width: 360, border: '1px solid #222' }}>
        <div style={{ color: '#E24B4A', fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
          ● FieldCast
        </div>
        <p style={{ color: '#666', fontSize: 13, marginBottom: 28 }}>Admin Dashboard</p>

        <label style={lbl}>Email</label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)}
          placeholder="admin@yournewschannel.com" required style={inp} />

        <label style={lbl}>Password</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)}
          placeholder="••••••••" required style={inp} />

        {error && <p style={{ color: '#E24B4A', fontSize: 12, marginBottom: 12 }}>{error}</p>}

        <button type="submit" disabled={loading} style={{ width: '100%', padding: 12,
          background: '#E24B4A', color: '#fff', border: 'none', borderRadius: 10,
          fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: loading ? 0.7 : 1 }}>
          {loading ? 'Logging in...' : 'Login'}
        </button>
      </form>
    </div>
  );
}

const lbl: React.CSSProperties = {
  display: 'block', fontSize: 11, color: '#888', marginBottom: 5,
  textTransform: 'uppercase', letterSpacing: '0.06em',
};
const inp: React.CSSProperties = {
  width: '100%', padding: '10px 12px', background: '#1a1a1a', border: '1px solid #333',
  borderRadius: 8, color: '#fff', fontSize: 14, marginBottom: 14,
};
