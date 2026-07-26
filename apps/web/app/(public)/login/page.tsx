'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiSend, errorMessage } from '@/lib/api';
import { Button, Field, Input, Alert } from '@/components/ui';

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
    const res = await apiSend<{ user?: { role: string } }>('/api/auth/login', {
      body: { username, password },
    });
    setLoading(false);
    if (!res.ok) {
      setError(errorMessage(res));
      return;
    }
    const role = res.data.user?.role;
    if (role === 'ADMIN') router.push('/admin');
    else if (role === 'DRIVER') router.push('/driver');
    else router.push('/employee');
  }

  return (
    <main className="grid min-h-screen place-items-center bg-surface-muted p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-primary text-white shadow-sm">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path
                d="M3 3h2l.4 2M7 13h10l3-8H5.4M7 13 5.4 5M7 13l-1.6 4h12"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="9" cy="20" r="1.5" />
              <circle cx="17" cy="20" r="1.5" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Shabro2a</h1>
          <p className="mt-1 text-sm text-muted">Employee Management</p>
        </div>

        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-card"
        >
          <Field label="Username" htmlFor="username">
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              required
            />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" size="lg" fullWidth loading={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-muted">
          Shabro2a Employee Management System
        </p>
      </div>
    </main>
  );
}
