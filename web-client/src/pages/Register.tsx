import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { authApi } from '../api/client';
import { saveAuth } from '../lib/auth';

export default function Register() {
  const [name, setName]                 = useState('');
  const [email, setEmail]               = useState('');
  const [designation, setDesignation]   = useState('');
  const [city, setCity]                 = useState('');
  const [password, setPassword]         = useState('');
  const [confirm, setConfirm]           = useState('');
  const [error, setError]               = useState('');
  const [loading, setLoading]           = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError('Passwords do not match'); return; }
    if (password.length < 6)  { setError('Password must be at least 6 characters'); return; }
    setLoading(true); setError('');
    try {
      // Register always creates a REPORTER — admin can promote to ANCHOR later
      const { data } = await authApi.register(name, email, password, designation, city);
      saveAuth(data.token, data.user);
      navigate('/conferences');
    } catch (e: any) {
      setError(e.response?.data?.error || 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={S.page}>
      <form onSubmit={handleSubmit} style={S.form}>
        <div style={S.logo}>● FieldCast</div>
        <p style={S.sub}>Create a reporter account</p>

        <label style={S.label}>Full Name</label>
        <input
          type="text" value={name} onChange={e => setName(e.target.value)}
          placeholder="Your name" required style={S.input}
        />

        <label style={S.label}>Email</label>
        <input
          type="email" value={email} onChange={e => setEmail(e.target.value)}
          placeholder="your@email.com" required style={S.input}
        />

        <label style={S.label}>Reporter Designation / Role</label>
        <input
          type="text" value={designation} onChange={e => setDesignation(e.target.value)}
          placeholder="e.g. Senior Correspondent" required style={S.input}
        />

        <label style={S.label}>Reporter City</label>
        <input
          type="text" value={city} onChange={e => setCity(e.target.value)}
          placeholder="e.g. Islamabad" required style={S.input}
        />

        <label style={S.label}>Password</label>
        <input
          type="password" value={password} onChange={e => setPassword(e.target.value)}
          placeholder="Min 6 characters" required style={S.input}
        />

        <label style={S.label}>Confirm Password</label>
        <input
          type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
          placeholder="Repeat password" required style={S.input}
        />

        {error && <p style={S.error}>{error}</p>}

        <button type="submit" disabled={loading} style={S.btn}>
          {loading ? 'Creating account...' : 'Create Account'}
        </button>

        <p style={S.footer}>
          Already have an account?{' '}
          <Link to="/login" style={S.link}>Sign in</Link>
        </p>
      </form>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page:   { minHeight: '100vh', display: 'flex', alignItems: 'center',
            justifyContent: 'center', background: '#0a0a0a', padding: '20px' },
  form:   { background: '#141414', padding: 40, borderRadius: 16,
            width: '100%', maxWidth: 380, border: '1px solid #222' },
  logo:   { color: '#E24B4A', fontSize: 24, fontWeight: 700, marginBottom: 4 },
  sub:    { color: '#666', fontSize: 13, marginBottom: 24 },
  label:  { display: 'block', fontSize: 11, color: '#888', marginBottom: 5,
            textTransform: 'uppercase', letterSpacing: '0.06em' },
  input:  { width: '100%', padding: '10px 12px', background: '#1a1a1a',
            border: '1px solid #333', borderRadius: 8, color: '#fff',
            fontSize: 14, marginBottom: 14, outline: 'none', boxSizing: 'border-box' },
  error:  { color: '#E24B4A', fontSize: 12, marginBottom: 12 },
  btn:    { width: '100%', padding: 12, background: '#E24B4A', color: '#fff',
            border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600,
            cursor: 'pointer', marginBottom: 16 },
  footer: { color: '#555', fontSize: 13, textAlign: 'center', margin: 0 },
  link:   { color: '#E24B4A', textDecoration: 'none' },
};
