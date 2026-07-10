'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const json = (await res.json()) as { ok: boolean; data?: { user?: { role: string } }; error?: { message: string } };
      if (!res.ok || !json.ok) {
        setError(json.error?.message ?? 'Login failed');
        return;
      }
      const role = json.data?.user?.role;
      if (role === 'ADMIN') router.push('/admin');
      else if (role === 'DRIVER') router.push('/driver');
      else router.push('/employee');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm flex flex-col gap-4 p-6 rounded-lg border border-gray-200"
      >
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <label className="flex flex-col gap-1">
          <span className="text-sm">Username</span>
          <input
            className="border rounded px-3 py-3 min-h-12"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm">Password</span>
          <input
            className="border rounded px-3 py-3 min-h-12"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button
          type="submit"
          disabled={loading}
          className="min-h-12 rounded bg-blue-600 text-white font-medium disabled:opacity-60"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}