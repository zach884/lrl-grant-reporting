// pages/staff-login.tsx — the one page in front of the staff app.
//
// Renders inside the GHL iframe too (the session cookie is SameSite=None), so a staff member who
// opens the embedded app after the cookie expires logs in in place rather than hitting a dead frame.

import { useState } from 'react';

export default function StaffLogin() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/staff/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        setError((await r.json().catch(() => ({}))).error ?? 'login failed');
        setBusy(false);
        return;
      }
      const next = new URLSearchParams(window.location.search).get('next');
      // Only ever follow a same-origin path — an open redirect on a login page is a phishing gift.
      window.location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
    } catch {
      setError('network error');
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#171717', color: '#fff',
      fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif', padding: 24 }}>
      <form onSubmit={submit} style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em' }}>Lean Rocket Lab</h1>
          <p style={{ margin: '6px 0 0', fontSize: 14, color: '#9a9a9a' }}>Operations platform. Staff only.</p>
        </div>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid #3a3a3a', background: '#0f0f0f',
            color: '#fff', fontSize: 15, outline: 'none' }}
        />
        {error && <div style={{ color: '#ff8b7a', fontSize: 13 }}>{error}</div>}
        <button
          type="submit"
          disabled={busy || !password}
          style={{ padding: '12px 14px', borderRadius: 10, border: 'none', background: busy ? '#6b5217' : '#F8B932',
            color: '#171717', fontSize: 15, fontWeight: 700, cursor: busy ? 'default' : 'pointer' }}
        >
          {busy ? 'Checking...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
