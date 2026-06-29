import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { authApi } from '../api/client';
import { saveAuth } from '../lib/auth';

export default function Login() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const { data } = await authApi.login(email, password);
      saveAuth(data.token, data.user);

      // Route based on role
      if (data.user.role === 'ADMIN')    navigate('/conferences');
      else if (data.user.role === 'ANCHOR')   navigate('/conferences');
      else                                    navigate('/conferences');
    } catch (e: any) {
      setError(e.response?.data?.error || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      <form onSubmit={handleSubmit} style={styles.form}>
        <div style={styles.logo}>● FieldCast</div>
        <p style={styles.sub}>Sign in to continue</p>

        <label style={styles.label}>Email</label>
        <input
          type="email" value={email} onChange={e => setEmail(e.target.value)}
          placeholder="your@email.com" required style={styles.input}
        />

        <label style={styles.label}>Password</label>
        <input
          type="password" value={password} onChange={e => setPassword(e.target.value)}
          placeholder="••••••••" required style={styles.input}
        />

        {error && <p style={styles.error}>{error}</p>}

        <button type="submit" disabled={loading} style={styles.btn}>
          {loading ? 'Signing in...' : 'Sign In'}
        </button>

        <p style={styles.footer}>
          No account?{' '}
          <Link to="/register" style={styles.link}>Register as Reporter</Link>
        </p>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page:  { minHeight: '100vh', display: 'flex', alignItems: 'center',
           justifyContent: 'center', background: '#0a0a0a' },
  form:  { background: '#141414', padding: 40, borderRadius: 16,
           width: '100%', maxWidth: 360, border: '1px solid #222' },
  logo:  { color: '#E24B4A', fontSize: 24, fontWeight: 700, marginBottom: 4 },
  sub:   { color: '#666', fontSize: 13, marginBottom: 28 },
  label: { display: 'block', fontSize: 11, color: '#888', marginBottom: 5,
           textTransform: 'uppercase', letterSpacing: '0.06em' },
  input: { width: '100%', padding: '10px 12px', background: '#1a1a1a',
           border: '1px solid #333', borderRadius: 8, color: '#fff',
           fontSize: 14, marginBottom: 14, outline: 'none' },
  error: { color: '#E24B4A', fontSize: 12, marginBottom: 12 },
  btn:    { width: '100%', padding: 12, background: '#E24B4A', color: '#fff',
            border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600,
            cursor: 'pointer', marginBottom: 16 },
  footer: { color: '#555', fontSize: 13, textAlign: 'center', margin: 0 },
  link:   { color: '#E24B4A', textDecoration: 'none' },
};
